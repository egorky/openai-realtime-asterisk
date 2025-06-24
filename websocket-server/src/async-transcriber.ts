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

  // Ensure audio is PCM s16le if Vosk is the provider and input is mulaw
  let finalAudioBuffer = audioBuffer;
  if (provider === 'vosk' && audioFormat === 'mulaw' && sampleRate === 8000) {
    callLogger.info('[AsyncTranscriber] Vosk provider: Converting mulaw audio to PCM s16le for Vosk.');
    // This is a placeholder. Actual mulaw to PCM conversion is needed.
    // For now, we'll log a warning. A proper library like 'pcm-convert' or custom logic would be required.
    // finalAudioBuffer = convertMulawToPcm(audioBuffer); // Fictional function
    callLogger.warn('[AsyncTranscriber] Vosk provider: MULAW to PCM conversion is NOT YET IMPLEMENTED. Sending raw mulaw. This will likely fail if Vosk server expects PCM.');
    // If Vosk server can handle raw mulaw directly (less common), this might work.
    // Otherwise, a conversion step is critical here.
  }


  try {
    if (provider === 'openai_whisper_api') {
      const tempFileName = `async_stt_audio_${callId}_${Date.now()}.${audioFormat === 'mulaw' ? 'ulaw' : 'raw'}`;
      tempFilePath = path.join(tempDir, tempFileName);
      await fs.writeFile(tempFilePath, finalAudioBuffer); // Use finalAudioBuffer
      callLogger.info(`[AsyncTranscriber] Temporary audio file saved to ${tempFilePath} for call ${callId} (OpenAI)`);

      const apiKey = appRecogConf.asyncSttOpenaiApiKey || process.env.OPENAI_API_KEY;
      const model = appRecogConf.asyncSttOpenaiModel || 'whisper-1';
      const language = appRecogConf.asyncSttLanguage;

      if (!apiKey) {
        callLogger.error('[AsyncTranscriber] OpenAI API key for async STT is missing.');
        throw new Error('Missing OpenAI API key for async STT');
      }

      // Whisper API generally prefers WAV, MP3 etc. Raw mulaw might not be ideal.
      // If finalAudioBuffer is still mulaw, this warning remains relevant.
      if (audioFormat === 'mulaw' && sampleRate === 8000 && finalAudioBuffer === audioBuffer) { // Check if conversion didn't happen
        callLogger.warn(`[AsyncTranscriber] Audio is in mulaw format for Whisper. Whisper API prefers WAV. Transcription might fail or be inaccurate without conversion if raw mulaw is not directly supported by the API for the specified model.`);
      }

      transcribedText = await transcribeWithOpenAIWhisperAPI(
        tempFilePath, // Send path to (potentially converted) audio
        apiKey,
        model,
        language,
        undefined,
        callLogger.child({ component: 'AsyncTranscriber-OpenAI' })
      );

    } else if (provider === 'google_speech_v1') {
      const languageCode = appRecogConf.asyncSttGoogleLanguageCode || 'es-ES';
      const googleCredentials = appRecogConf.asyncSttGoogleCredentials;

      let encoding: 'MULAW' | 'LINEAR16' = 'LINEAR16';
      // Determine encoding based on finalAudioBuffer's assumed format (after potential conversion)
      // If conversion to PCM happened for Vosk, and Google is chosen, we'd need to know that.
      // For now, this logic relies on the original audioFormat.
      if (audioFormat === 'mulaw' && sampleRate === 8000) { // Original format was mulaw
        encoding = 'MULAW';
        callLogger.info('[AsyncTranscriber] Using MULAW encoding for Google Speech.');
      } else if (audioFormat === 'pcm_s16le' || audioFormat === 'wav') { // Original was PCM/WAV
        encoding = 'LINEAR16';
        callLogger.info(`[AsyncTranscriber] Using LINEAR16 encoding for Google Speech. Sample rate: ${sampleRate}`);
      } else {
        callLogger.error(`[AsyncTranscriber] Unsupported original audioFormat "${audioFormat}" for Google Speech. Defaulting to LINEAR16, but this may fail with unconverted audio.`);
      }

      try {
        transcribedText = await transcribeWithGoogleSpeechV1(
          finalAudioBuffer, // Use finalAudioBuffer
          languageCode,
          sampleRate, // This should be the sample rate of finalAudioBuffer
          encoding,
          callLogger.child({ component: 'AsyncTranscriber-Google' }),
          googleCredentials
        );
      } catch (e: any) {
        if (e.message.includes("Cannot find module '@google-cloud/speech'")) {
          callLogger.error("[AsyncTranscriber] Google Speech SDK not installed. Please install '@google-cloud/speech'.");
        }
        throw e;
      }
    } else if (provider === 'vosk') {
      const voskServerUrl = process.env.VOSK_SERVER_URL || appRecogConf.voskServerUrl;
      if (!voskServerUrl) {
        callLogger.error('[AsyncTranscriber] Vosk server URL is not configured (VOSK_SERVER_URL env var or voskServerUrl in config). Transcription via Vosk skipped.');
        // Log to Redis that Vosk was skipped due to missing URL
        await logConversationToRedis(callId, {
            timestamp: new Date().toISOString(),
            actor: 'system',
            type: 'error_message',
            content: `Async STT (Vosk) skipped: VOSK_SERVER_URL not configured. Turn was at ${originalTurnTimestamp}.`,
            callId: callId,
            originalTurnTimestamp: originalTurnTimestamp,
        } as ConversationTurn);
        return; // Explicitly return to stop processing for Vosk if URL is missing
      }
      // The transcribeWithVosk function should handle the audio format.
      // We've already logged a warning if mulaw to PCM conversion is missing.
      // Vosk typically expects PCM s16le.
      const { transcribeWithVosk } = await import('./vosk-transcriber');
      transcribedText = await transcribeWithVosk({
        callId,
        audioBuffer: finalAudioBuffer, // Use the (potentially to-be-converted) buffer
        sampleRate: sampleRate, // This MUST be the sample rate of finalAudioBuffer
        voskServerUrl,
        callLogger,
      });
    } else {
      callLogger.error(`[AsyncTranscriber] Unknown async STT provider: ${provider}`);
      throw new Error(`Unknown async STT provider: ${provider}`);
    }

    if (transcribedText) {
      callLogger.info(`[AsyncTranscriber] Async transcription successful for call ${callId}. Text: "${transcribedText}"`);
      const turnData: ConversationTurn = {
        timestamp: new Date().toISOString(), // Add timestamp here
        actor: 'caller',
        type: 'async_transcript_result', // Use a specific type
        content: transcribedText,
        callId: callId, // Include callId
        originalTurnTimestamp: originalTurnTimestamp,
      };
      await logConversationToRedis(callId, turnData);
    } else {
      callLogger.warn(`[AsyncTranscriber] Async transcription failed or returned no text for call ${callId}. Provider: ${provider}`);
      await logConversationToRedis(callId, {
        timestamp: new Date().toISOString(),
        actor: 'system',
        type: 'error_message',
        content: `Async STT (${provider}) failed or returned no text for turn originally at ${originalTurnTimestamp}.`,
        callId: callId,
        originalTurnTimestamp: originalTurnTimestamp,
      } as ConversationTurn);
    }

  } catch (error: any) {
    callLogger.error(`[AsyncTranscriber] Error during async transcription process for call ${callId} with provider ${provider}: ${error.message}`, error);
    await logConversationToRedis(callId, {
      timestamp: new Date().toISOString(),
      actor: 'system',
      type: 'error_message',
      content: `Async STT (${provider}) critical error for turn at ${originalTurnTimestamp}: ${error.message}.`,
      callId: callId,
      originalTurnTimestamp: originalTurnTimestamp,
    } as ConversationTurn);
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
