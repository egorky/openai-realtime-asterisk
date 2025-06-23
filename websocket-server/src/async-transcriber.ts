import axios from 'axios';
import FormData from 'form-data';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { uuid } from 'uuidv4';
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
  // Add other parameters as needed: response_format, temperature, etc.

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


export async function transcribeAudioAsync(params: AsyncTranscriberParams): Promise<void> {
  const { callId, audioBuffer, audioFormat, sampleRate, config, callLogger, originalTurnTimestamp } = params;

  if (!config.appConfig.appRecognitionConfig.asyncSttEnabled) {
    callLogger.info('[AsyncTranscriber] Async STT is disabled. Skipping.');
    return;
  }

  const provider = config.appConfig.appRecognitionConfig.asyncSttProvider;
  const tempDir = os.tmpdir();
  const tempFileName = `async_stt_audio_${callId}_${Date.now()}.${audioFormat === 'mulaw' ? 'ulaw' : 'raw'}`; // Adjust extension based on format
  const tempFilePath = path.join(tempDir, tempFileName);

  try {
    await fs.writeFile(tempFilePath, audioBuffer);
    callLogger.info(`[AsyncTranscriber] Temporary audio file saved to ${tempFilePath} for call ${callId}`);

    let transcribedText: string | null = null;

    if (provider === 'openai_whisper_api') {
      const apiKey = config.appConfig.appRecognitionConfig.asyncSttOpenaiApiKey || process.env.OPENAI_API_KEY;
      const model = config.appConfig.appRecognitionConfig.asyncSttOpenaiModel || 'whisper-1';
      const language = config.appConfig.appRecognitionConfig.asyncSttLanguage; // Optional

      if (!apiKey) {
        callLogger.error('[AsyncTranscriber] OpenAI API key for async STT is missing.');
        throw new Error('Missing OpenAI API key for async STT');
      }

      // Whisper API typically expects common formats like wav, mp3, m4a.
      // If our input is raw mulaw or pcm, we might need to convert it or ensure the API supports it.
      // For now, assuming direct upload might work or needs adjustment based on Whisper API requirements for raw formats.
      // If input is mulaw, we might need to indicate that or convert to WAV.
      // For this example, we'll assume the API can handle the raw format if specified correctly, or a conversion step is added.
      // A more robust solution would be to convert raw mulaw/pcm to WAV before sending.
      let effectiveFilePathForApi = tempFilePath;
      if (audioFormat === 'mulaw' && sampleRate === 8000) {
        // Whisper API doesn't directly support raw mulaw. It needs to be in a container like WAV or a supported codec.
        // This is a placeholder. In a real scenario, you'd use ffmpeg or a library to convert tempFilePath (ulaw) to a WAV file.
        callLogger.warn(`[AsyncTranscriber] Audio is in mulaw format. Whisper API prefers WAV. Transcription might fail or be inaccurate without conversion.`);
        // For a quick test, one might try to send it as is, but it's not ideal.
        // effectiveFilePathForApi = await convertToWav(tempFilePath, sampleRate, 1); // Example conversion function
      }


      transcribedText = await transcribeWithOpenAIWhisperAPI(
        effectiveFilePathForApi,
        apiKey,
        model,
        language,
        undefined, // No specific prompt for now
        callLogger.child({ component: 'AsyncTranscriber-OpenAI' })
      );

    } else if (provider === 'google_speech_v1') {
      // TODO: Implement Google Speech API client
      callLogger.warn(`[AsyncTranscriber] Google Speech API provider not yet implemented.`);
      transcribedText = "// Google STT not implemented //";
    } else {
      callLogger.error(`[AsyncTranscriber] Unknown async STT provider: ${provider}`);
      throw new Error(`Unknown async STT provider: ${provider}`);
    }

    if (transcribedText) {
      callLogger.info(`[AsyncTranscriber] Async transcription successful for call ${callId}. Text: "${transcribedText.substring(0, 100)}..."`);
      const turnData: Omit<ConversationTurn, 'timestamp' | 'callId'> & { originalTurnTimestamp?: string } = {
        actor: 'caller',
        type: 'transcript', // Using 'transcript' type, but could be 'async_transcript' to differentiate
        content: transcribedText,
        originalTurnTimestamp: originalTurnTimestamp, // Store the original turn's timestamp
      };
      await logConversationToRedis(callId, turnData);
    } else {
      callLogger.warn(`[AsyncTranscriber] Async transcription failed or returned no text for call ${callId}.`);
      await logConversationToRedis(callId, {
        actor: 'system',
        type: 'error_message',
        content: `Async STT failed for turn originally at ${originalTurnTimestamp}. Provider: ${provider}`,
        originalTurnTimestamp: originalTurnTimestamp,
      });
    }

  } catch (error: any) {
    callLogger.error(`[AsyncTranscriber] Error during async transcription process for call ${callId}: ${error.message}`, error);
    await logConversationToRedis(callId, {
      actor: 'system',
      type: 'error_message',
      content: `Async STT critical error for turn at ${originalTurnTimestamp}: ${error.message}`,
      originalTurnTimestamp: originalTurnTimestamp,
    });
  } finally {
    try {
      await fs.unlink(tempFilePath); // Clean up temporary file
      callLogger.info(`[AsyncTranscriber] Deleted temporary audio file: ${tempFilePath}`);
    } catch (cleanupError: any) {
      callLogger.warn(`[AsyncTranscriber] Failed to delete temporary audio file ${tempFilePath}: ${cleanupError.message}`);
    }
  }
}

// Placeholder for a conversion function if needed.
// async function convertToWav(inputPath: string, sampleRate: number, channels: number): Promise<string> {
//   // Implement conversion using ffmpeg or a library like 'fluent-ffmpeg' or 'sox-stream'
//   const outputPath = inputPath.replace(/\.\w+$/, '.wav');
//   // Example: execSync(`ffmpeg -f mulaw -ar ${sampleRate} -ac ${channels} -i ${inputPath} ${outputPath}`);
//   console.log(`[AsyncTranscriber] (Placeholder) Converted ${inputPath} to ${outputPath}`);
//   return outputPath;
// }
