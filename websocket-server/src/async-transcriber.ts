import axios from 'axios';
import FormData from 'form-data';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SpeechClient } from '@google-cloud/speech';
import { logConversationToRedis, ConversationTurn } from './redis-client';
import { CallSpecificConfig, LoggerInstance } from './types';

interface AsyncTranscriberParams {
  callId: string;
  audioBuffer: Buffer;
  audioFormat: 'mulaw' | 'wav' | 'pcm_s16le'; // Formato del buffer de entrada
  sampleRate: number;
  config: CallSpecificConfig;
  callLogger: LoggerInstance;
  originalTurnTimestamp: string; // Timestamp del turno original del llamante
}

async function transcribeWithOpenAIWhisperAPI(
  audioFilePath: string,
  apiKey: string,
  model: string,
  language: string | undefined,
  prompt: string | undefined, // For hints
  logger: LoggerInstance
): Promise<string | null> {
  const formData = new FormData();
  formData.append('file', await fs.readFile(audioFilePath), path.basename(audioFilePath));
  formData.append('model', model);
  if (language) {
    formData.append('language', language);
  }
  if (prompt) {
    formData.append('prompt', prompt);
  }

  try {
    logger.info(`[AsyncTranscriber] Sending audio to OpenAI Whisper API. Model: ${model}, File: ${audioFilePath}`);
    const response = await axios.post('https://api.openai.com/v1/audio/transcriptions', formData, {
      headers: {
        ...formData.getHeaders(),
        'Authorization': `Bearer ${apiKey}`,
      },
      timeout: 60000, // 60 seconds timeout
    });
    logger.info(`[AsyncTranscriber] Received response from Whisper API.`);
    if (response.data && response.data.text) {
      return response.data.text;
    }
    logger.warn('[AsyncTranscriber] Whisper API response did not contain text.', response.data);
    return null;
  } catch (error: any) {
    logger.error(`[AsyncTranscriber] Error calling OpenAI Whisper API: ${error.message}`, error.response?.data);
    return null;
  }
}

async function transcribeWithGoogleSpeechV1(
  audioBuffer: Buffer, // Directly pass the buffer
  languageCode: string, // e.g., "es-ES", "en-US"
  sampleRateHertz: number,
  encoding: 'MULAW' | 'LINEAR16', // MULAW for 8kHz, LINEAR16 for WAV/PCM
  logger: LoggerInstance,
  googleCredentials?: string // Path to credentials JSON, if not using ADC
): Promise<string | null> {
  try {
    logger.info(`[AsyncTranscriber] Initializing Google Speech client. Language: ${languageCode}, Sample Rate: ${sampleRateHertz}, Encoding: ${encoding}`);

    const clientOptions = googleCredentials ? { keyFilename: googleCredentials } : {};
    const speechClient = new SpeechClient(clientOptions);

    const audio = {
      content: audioBuffer.toString('base64'), // Google API expects base64 encoded audio
    };
    const config = {
      encoding: encoding,
      sampleRateHertz: sampleRateHertz,
      languageCode: languageCode,
      // model: 'telephony', // or other models as needed
      // enableAutomaticPunctuation: true,
    };
    const request = {
      audio: audio,
      config: config,
    };

    logger.info('[AsyncTranscriber] Sending audio to Google Speech API.');
    // @ts-ignore due to potential type mismatch with library version if not installed
    const [response] = await speechClient.recognize(request);
    logger.info('[AsyncTranscriber] Received response from Google Speech API.');

    if (response.results && response.results.length > 0) {
      const transcription = response.results
        .map((result: any) => result.alternatives[0].transcript)
        .join('\n');
      return transcription;
    }
    logger.warn('[AsyncTranscriber] Google Speech API response did not contain results.');
    return null;
  } catch (error: any) {
    logger.error(`[AsyncTranscriber] Error calling Google Speech API: ${error.message}`, error);
    return null;
  }
}


export async function transcribeAudioAsync(params: AsyncTranscriberParams): Promise<void> {
  const { callId, audioBuffer, audioFormat, sampleRate, config, callLogger, originalTurnTimestamp } = params;
  const appRecogConf = config.appConfig.appRecognitionConfig;

  if (!appRecogConf.asyncSttEnabled) {
    callLogger.info('[AsyncTranscriber] Async STT is disabled. Skipping.');
    return;
  }

  const provider = appRecogConf.asyncSttProvider;
  const tempDir = os.tmpdir();
  // Temp file only needed for providers that require a file path (like Whisper API via FormData)
  let tempFilePath: string | null = null;
  let transcribedText: string | null = null;

  try {
    if (provider === 'openai_whisper_api') {
      const tempFileName = `async_stt_audio_${callId}_${Date.now()}.${audioFormat === 'mulaw' ? 'ulaw' : 'raw'}`;
      tempFilePath = path.join(tempDir, tempFileName);
      await fs.writeFile(tempFilePath, audioBuffer);
      callLogger.info(`[AsyncTranscriber] Temporary audio file saved to ${tempFilePath} for call ${callId} (OpenAI)`);

      const apiKey = appRecogConf.asyncSttOpenaiApiKey || process.env.OPENAI_API_KEY;
      const model = appRecogConf.asyncSttOpenaiModel || 'whisper-1';
      const language = appRecogConf.asyncSttLanguage;

      if (!apiKey) {
        callLogger.error('[AsyncTranscriber] OpenAI API key for async STT is missing.');
        throw new Error('Missing OpenAI API key for async STT');
      }

      let effectiveFilePathForApi = tempFilePath;
      if (audioFormat === 'mulaw' && sampleRate === 8000) {
        callLogger.warn(`[AsyncTranscriber] Audio is in mulaw format for Whisper. Whisper API prefers WAV. Transcription might fail or be inaccurate without conversion if raw mulaw is not directly supported by the API for the specified model.`);
      }

      transcribedText = await transcribeWithOpenAIWhisperAPI(
        effectiveFilePathForApi,
        apiKey,
        model,
        language,
        undefined,
        callLogger.child({ component: 'AsyncTranscriber-OpenAI' })
      );

    } else if (provider === 'google_speech_v1') {
      const languageCode = appRecogConf.asyncSttGoogleLanguageCode || 'es-ES'; // Default to Spanish for Google
      const googleCredentials = appRecogConf.asyncSttGoogleCredentials; // Path to JSON key file

      let encoding: 'MULAW' | 'LINEAR16' = 'LINEAR16'; // Default
      if (audioFormat === 'mulaw' && sampleRate === 8000) {
        encoding = 'MULAW';
        callLogger.info('[AsyncTranscriber] Using MULAW encoding for Google Speech.');
      } else if (audioFormat === 'pcm_s16le' || audioFormat === 'wav') {
        encoding = 'LINEAR16';
         callLogger.info(`[AsyncTranscriber] Using LINEAR16 encoding for Google Speech. Sample rate: ${sampleRate}`);
         // For LINEAR16, ensure sampleRate is correctly passed.
         // If input is WAV, it ideally should be stripped of header for 'content' base64, or use 'uri' if it's a GCS URI.
         // For now, assuming raw PCM or mulaw buffer.
      } else {
        callLogger.error(`[AsyncTranscriber] Unsupported audioFormat "${audioFormat}" for Google Speech. Defaulting to LINEAR16, but this may fail.`);
      }

      // Note: @google-cloud/speech package needs to be installed.
      // If not installed, this will throw an error at runtime.
      try {
        transcribedText = await transcribeWithGoogleSpeechV1(
          audioBuffer,
          languageCode,
          sampleRate,
          encoding,
          callLogger.child({ component: 'AsyncTranscriber-Google' }),
          googleCredentials
        );
      } catch (e: any) {
        if (e.message.includes("Cannot find module '@google-cloud/speech'")) {
          callLogger.error("[AsyncTranscriber] Google Speech SDK not installed. Please install '@google-cloud/speech'.");
        }
        throw e; // Re-throw to be caught by outer try-catch
      }


    } else {
      callLogger.error(`[AsyncTranscriber] Unknown async STT provider: ${provider}`);
      throw new Error(`Unknown async STT provider: ${provider}`);
    }

    if (transcribedText) {
      callLogger.info(`[AsyncTranscriber] Async transcription successful for call ${callId}. Full Text: "${transcribedText}"`);
      const turnData: Omit<ConversationTurn, 'timestamp' | 'callId'> & { originalTurnTimestamp?: string } = {
        actor: 'caller',
        type: 'transcript',
        content: transcribedText,
        originalTurnTimestamp: originalTurnTimestamp,
      };
      await logConversationToRedis(callId, turnData);
    } else {
      callLogger.warn(`[AsyncTranscriber] Async transcription failed or returned no text for call ${callId}. Provider: ${provider}`);
      await logConversationToRedis(callId, {
        actor: 'system',
        type: 'error_message',
        content: `Async STT failed or returned no text for turn originally at ${originalTurnTimestamp}. Provider: ${provider}`,
        originalTurnTimestamp: originalTurnTimestamp,
      });
    }

  } catch (error: any) {
    callLogger.error(`[AsyncTranscriber] Error during async transcription process for call ${callId}: ${error.message}`, error);
    await logConversationToRedis(callId, {
      actor: 'system',
      type: 'error_message',
      content: `Async STT critical error for turn at ${originalTurnTimestamp}: ${error.message}. Provider: ${provider}`,
      originalTurnTimestamp: originalTurnTimestamp,
    });
  } finally {
    if (tempFilePath) { // Only unlink if a temp file was created
      try {
        await fs.unlink(tempFilePath);
        callLogger.info(`[AsyncTranscriber] Deleted temporary audio file: ${tempFilePath}`);
      } catch (cleanupError: any) {
        callLogger.warn(`[AsyncTranscriber] Failed to delete temporary audio file ${tempFilePath}: ${cleanupError.message}`);
      }
    }
  }
}
