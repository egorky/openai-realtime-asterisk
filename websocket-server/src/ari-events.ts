// Este archivo contendrá los manejadores de eventos de ARI y OpenAI.

import Ari, { Channel, Bridge, Playback, PlaybackFinished, ChannelTalkingStarted, ChannelTalkingFinished, ChannelDtmfReceived, StasisStart, StasisEnd } from 'ari-client';
import { CallSpecificConfig, LoggerInstance, AppRecognitionConfig } from './types';
import { CallResources } from './ari-call-resources';
import { AriClientService } from './ari-service'; // Necesario para 'this' y acceso a activeCalls, client, etc.
import * as sessionManager from './sessionManager';
import { logConversationToRedis, ConversationTurn } from './redis-client';
import { transcribeAudioAsync } from './async-transcriber';
import { getCallSpecificConfig, ASTERISK_ARI_APP_NAME, DEFAULT_RTP_HOST_IP, MAX_VAD_BUFFER_PACKETS } from './ari-config';
import { RtpServer } from './rtp-server'; // Asumiendo que rtp-server.ts existe
import { _activateOpenAIStreaming, _stopAllPlaybacks, _finalizeDtmfInput, playbackAudio as playbackAudioAction } from './ari-actions'; // Renamed playbackAudio to avoid conflict
import { _fullCleanup } from './ari-cleanup'; // Asumiendo que ari-cleanup.ts existe
import { sendGenericEventToFrontend } from './server'; // Para notificaciones al frontend
import fs from 'node:fs';
import path from 'node:path';
import { createWavHeader } from './ari-utils'; // Asumiendo que ari-utils.ts existe


// Los métodos aquí eran originalmente parte de la clase AriClientService.
// Necesitarán una instancia de AriClientService (`serviceInstance`) para acceder a
// `this.activeCalls`, `this.client`, `this.logger`, etc.

// ##############################
// ##### OpenAI Event Handlers #####
// ##############################

export function _onOpenAISpeechStarted(serviceInstance: AriClientService, callId: string): void {
    const call = serviceInstance.activeCalls.get(callId);
    if (!call || call.isCleanupCalled) return;
    call.callLogger.info(`[${callId}] _onOpenAISpeechStarted: OpenAI speech recognition started (or first transcript received).`);
    serviceInstance.sendEventToFrontend({
        type: 'openai_speech_started',
        callId: callId,
        timestamp: new Date().toISOString(),
        source: 'OPENAI_CALLBACKS',
        payload: {},
        logLevel: 'INFO'
    });

    // TTS Interruption Logic
    if (call.isTtsPlaying || call.ttsPlaybackQueue.length > 0) {
      call.callLogger.info(`[${callId}] OpenAI speech started, interrupting TTS playback queue.`);
      _stopAllPlaybacks(serviceInstance, call) // This should also stop currentPlayingSoundId if active
        .then(() => {
          call.callLogger.info(`[${callId}] TTS playbacks stopped due to user speech.`);
          serviceInstance.sendEventToFrontend({
            type: 'tts_playback_interrupted',
            callId: callId,
            timestamp: new Date().toISOString(),
            source: 'ARI_EVENTS',
            payload: { reason: 'user_speech_started' },
            logLevel: 'INFO'
          });
        })
        .catch(e => call.callLogger.error(`[${callId}] Error stopping TTS playbacks on speech interruption: ${e.message}`));
      call.ttsPlaybackQueue = [];
      call.isTtsPlaying = false;
      call.currentPlayingSoundId = null;
    }

    if (call.noSpeechBeginTimer) {
      call.callLogger.info(`[${callId}] Clearing noSpeechBeginTimer due to speech started.`);
      clearTimeout(call.noSpeechBeginTimer);
      call.noSpeechBeginTimer = null;
    }
    if (call.initialOpenAIStreamIdleTimer) {
      call.callLogger.info(`[${callId}] Clearing initialOpenAIStreamIdleTimer due to speech started.`);
      clearTimeout(call.initialOpenAIStreamIdleTimer);
      call.initialOpenAIStreamIdleTimer = null;
    }
    call.speechHasBegun = true;
}

export function _onOpenAIInterimResult(serviceInstance: AriClientService, callId: string, transcript: string): void {
    const call = serviceInstance.activeCalls.get(callId);
    if (!call || call.isCleanupCalled) return;
    call.callLogger.debug(`[${callId}] _onOpenAIInterimResult: OpenAI interim transcript: "${transcript}"`);
    serviceInstance.sendEventToFrontend({
        type: 'openai_interim_transcript',
        callId: callId,
        timestamp: new Date().toISOString(),
        source: 'OPENAI_CALLBACKS',
        payload: { transcript: transcript },
        logLevel: 'DEBUG'
    });

    if (!call.speechHasBegun) {
        if (call.noSpeechBeginTimer) {
            call.callLogger.info(`[${callId}] Clearing noSpeechBeginTimer due to interim transcript.`);
            clearTimeout(call.noSpeechBeginTimer);
            call.noSpeechBeginTimer = null;
        }
        if (call.initialOpenAIStreamIdleTimer) {
            call.callLogger.info(`[${callId}] Clearing initialOpenAIStreamIdleTimer due to interim transcript.`);
            clearTimeout(call.initialOpenAIStreamIdleTimer);
            call.initialOpenAIStreamIdleTimer = null;
        }
        call.speechHasBegun = true;
        call.callLogger.info(`[${callId}] Speech implicitly started with first interim transcript.`);
    }

    if (call.mainPlayback && !call.promptPlaybackStoppedForInterim) {
        call.callLogger.info(`Stopping main prompt due to OpenAI interim transcript (barge-in).`);
        _stopAllPlaybacks(serviceInstance, call).catch(e => call.callLogger.error(`Error stopping playback on interim: ` + (e instanceof Error ? e.message : String(e))));
        call.promptPlaybackStoppedForInterim = true;
    }

    if (call.speechEndSilenceTimer) clearTimeout(call.speechEndSilenceTimer);
    const silenceTimeout = (call.config.appConfig.appRecognitionConfig.speechEndSilenceTimeoutSeconds ?? 1.5) * 1000;
    call.speechEndSilenceTimer = setTimeout(() => {
      if (call.isCleanupCalled || !call.openAIStreamingActive) return;
      call.callLogger.warn(`OpenAI: Silence detected for ${silenceTimeout}ms after interim transcript. Stopping OpenAI session for this turn.`);
      sessionManager.stopOpenAISession(callId, 'interim_result_silence_timeout');
    }, silenceTimeout);
}

export function _onOpenAIFinalResult(serviceInstance: AriClientService, callId: string, transcript: string): void {
    const call = serviceInstance.activeCalls.get(callId);
    if (!call || call.isCleanupCalled) return;

    call.callLogger.info(`_onOpenAIFinalResult CALLED for callId: ${callId}. Current ttsAudioChunks.length: ${call.ttsAudioChunks?.length ?? 'N/A'}`);
    call.callLogger.info(`OpenAI final transcript received: "${transcript}"`);
    serviceInstance.sendEventToFrontend({
        type: 'openai_final_transcript',
        callId: callId,
        timestamp: new Date().toISOString(),
        source: 'OPENAI_CALLBACKS',
        payload: { transcript: transcript },
        logLevel: 'INFO'
    });

    if (call.speechEndSilenceTimer) { clearTimeout(call.speechEndSilenceTimer); call.speechEndSilenceTimer = null; }
    call.finalTranscription = transcript;
    call.callLogger.info(`Final transcript processed. Requesting OpenAI response for text: "${transcript}"`);

    logConversationToRedis(callId, {
      actor: 'caller',
      type: 'transcript',
      content: transcript,
    }).catch(e => call.callLogger.error(`RedisLog Error (caller transcript): ${e.message}`));

    try {
      serviceInstance.sendEventToFrontend({
        type: 'openai_requesting_response',
        callId: callId,
        timestamp: new Date().toISOString(),
        source: 'SESSION_MANAGER',
        payload: { triggeringTranscript: transcript },
        logLevel: 'INFO'
      });
      sessionManager.requestOpenAIResponse(callId, transcript, call.config);
    } catch (e: any) {
      call.callLogger.error(`Error calling sessionManager.requestOpenAIResponse: ${e.message}`, e);
      logConversationToRedis(callId, {
        actor: 'system',
        type: 'error_message',
        content: `Failed to request OpenAI response: ${e.message}`
      }).catch(redisErr => call.callLogger.error(`RedisLog Error (OpenAI request fail): ${redisErr.message}`));
    }
    call.callLogger.info(`Waiting for OpenAI to generate response (including potential audio).`);
}

export async function _onOpenAIAudioChunk(serviceInstance: AriClientService, callId: string, audioChunkBase64: string, _isLastChunk_deprecated: boolean): Promise<void> {
    const call = serviceInstance.activeCalls.get(callId);
    const loggerToUse = call?.callLogger || serviceInstance.logger;

    if (!call || call.isCleanupCalled) {
      loggerToUse.warn(`_onOpenAIAudioChunk: Call ${callId} not active or cleanup. Ignoring.`);
      return;
    }

    const playbackMode = call.config.appConfig.appRecognitionConfig.ttsPlaybackMode || "full_chunk";
    loggerToUse.info(`_onOpenAIAudioChunk for call ${callId}. Playback mode: ${playbackMode}. Chunk non-empty: ${!!(audioChunkBase64 && audioChunkBase64.length > 0)}.`);

    if (!(audioChunkBase64 && audioChunkBase64.length > 0)) {
      loggerToUse.warn('_onOpenAIAudioChunk: Received empty or null audioChunkBase64.');
      return;
    }

    if (!call.speechHasBegun) {
        call.speechHasBegun = true;
        loggerToUse.info(`[${callId}] Speech implicitly started upon receiving first audio chunk from OpenAI.`);
        if (call.noSpeechBeginTimer) {
            loggerToUse.info(`[${callId}] Clearing noSpeechBeginTimer due to receiving audio chunk.`);
            clearTimeout(call.noSpeechBeginTimer);
            call.noSpeechBeginTimer = null;
        }
        if (call.initialOpenAIStreamIdleTimer) {
            loggerToUse.info(`[${callId}] Clearing initialOpenAIStreamIdleTimer due to receiving audio chunk.`);
            clearTimeout(call.initialOpenAIStreamIdleTimer);
            call.initialOpenAIStreamIdleTimer = null;
        }
    }

    if (playbackMode === "stream") {
      loggerToUse.debug(`Streaming TTS audio chunk, length: ${audioChunkBase64.length}.`);
      try {
        const audioBuffer = Buffer.from(audioChunkBase64, 'base64');
        if (audioBuffer.length === 0) {
          loggerToUse.warn(`[StreamPlayback] Decoded audio chunk is empty for call ${callId}. Skipping queueing of this chunk.`);
          return;
        }

        call.fullTtsAudioBuffer.push(audioBuffer);

        const recordingsBaseDir = '/var/lib/asterisk/sounds';
        const openaiStreamChunksDir = path.join(recordingsBaseDir, 'openai_stream_chunks');
        if (!fs.existsSync(openaiStreamChunksDir)) {
          fs.mkdirSync(openaiStreamChunksDir, { recursive: true });
        }
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const chunkFilename = `tts_chunk_${callId}_${timestamp}_${call.ttsPlaybackQueue.length}.ulaw`;
        const absoluteChunkPath = path.join(openaiStreamChunksDir, chunkFilename);

        fs.writeFileSync(absoluteChunkPath, audioBuffer);
        loggerToUse.info(`[StreamPlayback] Saved TTS chunk to ${absoluteChunkPath}`);

        const soundUri = `sound:openai_stream_chunks/${chunkFilename.replace(/\.ulaw$/, '')}`;
        call.ttsPlaybackQueue.push(soundUri);
        call.streamedTtsChunkFiles.push(absoluteChunkPath);

        const { _processTtsPlaybackQueue } = await import('./ari-actions');
        _processTtsPlaybackQueue(serviceInstance, callId);

        serviceInstance.sendEventToFrontend({
          type: 'openai_tts_chunk_received_and_queued',
          callId: callId,
          timestamp: new Date().toISOString(),
          source: 'OPENAI_CALLBACKS',
          payload: {
            chunkUri: soundUri,
            queueSize: call.ttsPlaybackQueue.length,
            chunkSizeBytes: audioBuffer.length
          },
          logLevel: 'TRACE'
        });

      } catch (e: any) {
        loggerToUse.error(`[StreamPlayback] Error processing or queueing TTS chunk for call ${callId}: ${e.message}`);
      }
    } else {
      if (!call.ttsAudioChunks) {
        call.callLogger.error('_onOpenAIAudioChunk (full_chunk): CRITICAL - ttsAudioChunks was undefined.');
        call.ttsAudioChunks = [];
      }
      call.callLogger.debug(`(Full Chunk Mode) Received TTS audio chunk, length: ${audioChunkBase64.length}. Accumulating. Previous #chunks: ${call.ttsAudioChunks.length}`);
      call.ttsAudioChunks.push(audioChunkBase64);
      serviceInstance.sendEventToFrontend({
        type: 'openai_tts_chunk_accumulated',
        callId: callId,
        timestamp: new Date().toISOString(),
        source: 'OPENAI_CALLBACKS',
        payload: {
          accumulatedChunks: call.ttsAudioChunks.length,
          currentChunkSizeBytes: audioChunkBase64.length
        },
        logLevel: 'TRACE'
      });
    }
}

// Helper function to encapsulate full_chunk saving, to be placed within ari-events.ts or imported
async function saveAndPrepareFullChunkAudio(serviceInstance: AriClientService, call: CallResources, callId: string, loggerToUse: LoggerInstance) {
  let filenameOnly: string | undefined;
  let filenameWithExt: string | undefined;
  let soundPath: string | null = null;
  let savedPath: string | null = null;

    if (!call.ttsAudioChunks || call.ttsAudioChunks.length === 0) {
        loggerToUse.info(`No TTS chunks to save for call ${callId}`);
        return { filenameOnly, filenameWithExt, soundPath, savedPath };
    }
    const decodedBuffers: Buffer[] = call.ttsAudioChunks.map(chunk => Buffer.from(chunk, 'base64'));
    const audioInputBuffer = Buffer.concat(decodedBuffers);

    if (audioInputBuffer.length === 0) {
        loggerToUse.warn(`Combined decoded audio data for call ${callId} is empty.`);
        return { filenameOnly, filenameWithExt, soundPath, savedPath };
    }

    try {
        const recordingsBaseDir = '/var/lib/asterisk/sounds';
        const openaiRecordingsDir = path.join(recordingsBaseDir, 'openai');
        if (!fs.existsSync(openaiRecordingsDir)) fs.mkdirSync(openaiRecordingsDir, { recursive: true });

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const outputFormat = call.config.openAIRealtimeAPI.outputAudioFormat?.toLowerCase();
        filenameOnly = `openai_tts_${callId}_${timestamp}`;
        let finalAudioBuffer = audioInputBuffer;

        if (outputFormat?.startsWith('pcm')) {
            const bytesPerSample = 2; const numChannels = 1;
            const outputSampleRate = call.config.openAIRealtimeAPI.outputAudioSampleRate || 8000;
            const numFrames = audioInputBuffer.length / (bytesPerSample * numChannels);
            const wavHeader = createWavHeader({ numFrames, numChannels, sampleRate: outputSampleRate, bytesPerSample });
            finalAudioBuffer = Buffer.concat([wavHeader, audioInputBuffer]);
            filenameWithExt = `${filenameOnly}.wav`;
        } else if (outputFormat === 'g711_ulaw' || outputFormat === 'mulaw_8000hz' || outputFormat === 'ulaw') {
            filenameWithExt = `${filenameOnly}.ulaw`;
        } else if (outputFormat === 'mp3') {
            filenameWithExt = `${filenameOnly}.mp3`;
        } else if (outputFormat === 'opus') {
            filenameWithExt = `${filenameOnly}.opus`;
        } else {
            filenameWithExt = `${filenameOnly}.raw`;
        }
        const absoluteFilepath = path.join(openaiRecordingsDir, filenameWithExt);
        fs.writeFileSync(absoluteFilepath, finalAudioBuffer);
        loggerToUse.info(`TTS audio for call ${callId} saved to ${absoluteFilepath}`);
        soundPath = `openai/${filenameOnly}`;
        savedPath = absoluteFilepath;
    } catch (saveError: any) {
        loggerToUse.error(`Failed to save TTS audio for ${callId}: ${saveError.message}`, saveError);
    }

  return { filenameOnly, filenameWithExt, soundPath, savedPath };
}


export async function _onOpenAIAudioStreamEnd(serviceInstance: AriClientService, callId: string): Promise<void> {
    const call = serviceInstance.activeCalls.get(callId);
    const loggerToUse = call?.callLogger || serviceInstance.logger;

    if (!call || call.isCleanupCalled) {
      loggerToUse.warn(`_onOpenAIAudioStreamEnd: Call ${callId} not active or cleanup called.`);
      return;
    }

    const playbackMode = call.config.appConfig.appRecognitionConfig.ttsPlaybackMode || "full_chunk";
    loggerToUse.info(`_onOpenAIAudioStreamEnd for call ${callId}. Playback mode: ${playbackMode}.`);

    let eventPayloadBase: any = {
        playbackMode: playbackMode,
    };

    if (playbackMode === "stream") {
      let streamModeSavedFilePath: string | null = null;
      let streamModeConcatenatedLength = 0;
      loggerToUse.info(`[StreamPlayback] Audio stream ended. Processing fullTtsAudioBuffer.`);

      if (call.fullTtsAudioBuffer.length > 0) {
        const localFullAudioBuffer = Buffer.concat(call.fullTtsAudioBuffer);
        streamModeConcatenatedLength = localFullAudioBuffer.length;
        loggerToUse.info(`[StreamPlayback] Concatenated ${call.fullTtsAudioBuffer.length} streamed chunks. Total backup audio size: ${streamModeConcatenatedLength} bytes.`);

        if (streamModeConcatenatedLength > 0) {
          try {
            const recordingsBaseDir = '/var/lib/asterisk/sounds';
            const streamBackupDir = path.join(recordingsBaseDir, 'openai_stream_backup');
            if (!fs.existsSync(streamBackupDir)) {
              fs.mkdirSync(streamBackupDir, { recursive: true });
            }
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const outputFormat = call.config.openAIRealtimeAPI.outputAudioFormat?.toLowerCase();
            let backupFilenameOnly = `stream_backup_${callId}_${timestamp}`;
            let localFilenameWithExt: string;
            let finalBackupBuffer = localFullAudioBuffer;

            if (outputFormat?.startsWith('pcm')) {
              const bytesPerSample = 2; const numChannels = 1;
              const outputSampleRate = call.config.openAIRealtimeAPI.outputAudioSampleRate || 8000;
              const numFrames = localFullAudioBuffer.length / (bytesPerSample * numChannels);
              const wavHeader = createWavHeader({ numFrames, numChannels, sampleRate: outputSampleRate, bytesPerSample });
              finalBackupBuffer = Buffer.concat([wavHeader, localFullAudioBuffer]);
              localFilenameWithExt = `${backupFilenameOnly}.wav`;
            } else if (outputFormat === 'g711_ulaw' || outputFormat === 'mulaw_8000hz' || outputFormat === 'ulaw') {
              localFilenameWithExt = `${backupFilenameOnly}.ulaw`;
            } else if (outputFormat === 'mp3') {
               localFilenameWithExt = `${backupFilenameOnly}.mp3`;
            } else if (outputFormat === 'opus') {
               localFilenameWithExt = `${backupFilenameOnly}.opus`;
            } else {
              localFilenameWithExt = `${backupFilenameOnly}.raw`;
            }
            const absoluteBackupPath = path.join(streamBackupDir, localFilenameWithExt);
            fs.writeFileSync(absoluteBackupPath, finalBackupBuffer);
            loggerToUse.info(`[StreamPlayback] Full backup audio saved to ${absoluteBackupPath}`);
            streamModeSavedFilePath = absoluteBackupPath;
          } catch (saveError: any) {
            loggerToUse.error(`[StreamPlayback] Failed to save full backup audio for call ${callId}: ${saveError.message}`, saveError);
          }
        } else {
          loggerToUse.warn(`[StreamPlayback] Full backup audio buffer was empty after concatenation for call ${callId}. Nothing to save.`);
        }
      } else {
        loggerToUse.info(`[StreamPlayback] No audio chunks accumulated in fullTtsAudioBuffer for backup.`);
      }
      call.fullTtsAudioBuffer = [];

      eventPayloadBase.totalStreamedBytes = streamModeConcatenatedLength;
      eventPayloadBase.savedFilePath = streamModeSavedFilePath;

      serviceInstance.sendEventToFrontend({
        type: 'openai_tts_stream_ended',
        callId: callId,
        timestamp: new Date().toISOString(),
        source: 'OPENAI_CALLBACKS',
        payload: eventPayloadBase,
        logLevel: 'INFO'
      });
      return;
    }

    // Logic for "full_chunk" mode
    let accumulatedChunksCount = 0;
    let fullChunkSavedFilePath: string | null = null;

    if (!call.ttsAudioChunks) {
      call.callLogger.error(`_onOpenAIAudioStreamEnd (full_chunk): CRITICAL - ttsAudioChunks is undefined.`);
      serviceInstance.sendEventToFrontend({
        type: 'openai_tts_stream_ended_error',
        callId: callId,
        timestamp: new Date().toISOString(),
        source: 'OPENAI_CALLBACKS',
        payload: { ...eventPayloadBase, error: 'ttsAudioChunks was undefined for full_chunk mode' },
        logLevel: 'ERROR'
      });
      return;
    }

    accumulatedChunksCount = call.ttsAudioChunks.length;
    eventPayloadBase.totalAccumulatedChunks = accumulatedChunksCount;
    call.callLogger.info(`(Full Chunk Mode) Checking accumulated ttsAudioChunks for call ${callId}. Length: ${accumulatedChunksCount}`);

    if (accumulatedChunksCount > 0) {
      const { soundPath, savedPath } = await saveAndPrepareFullChunkAudio(serviceInstance, call, callId, loggerToUse);
      fullChunkSavedFilePath = savedPath;

      if (soundPath) {
          call.callLogger.info(`Playing accumulated TTS audio for call ${callId} from sound path: sound:${soundPath}`);
          let ttsSpokenText = call.finalTranscription;
          if (!ttsSpokenText) {
              ttsSpokenText = "[Bot audio response played]";
          }
          logConversationToRedis(callId, {
              actor: 'bot',
              type: 'tts_prompt',
              content: ttsSpokenText
          }).catch(e => call.callLogger.error(`RedisLog Error (bot TTS): ${e.message}`));

          try {
            if (call.waitingPlayback) {
              await call.waitingPlayback.stop().catch(e => call.callLogger.warn(`Error stopping previous waitingPlayback: ${e.message}`));
              call.waitingPlayback = undefined;
            }
            // Use the playbackAudioAction from ari-actions
            await playbackAudioAction(serviceInstance, callId, null, `sound:${soundPath}`);
            call.callLogger.info(`TTS audio playback initiated for call ${callId}.`);
          } catch (e: any) {
            call.callLogger.error(`Error initiating TTS audio playback for call ${callId}: ${e.message}`, e);
            logConversationToRedis(callId, { actor: 'system', type: 'error_message', content: `TTS playback error: ${e.message}` })
              .catch(redisErr => call.callLogger.error(`RedisLog Error: ${redisErr.message}`));
          }
        } else {
          call.callLogger.error(`TTS audio for call ${callId} not saved correctly, cannot play.`);
           logConversationToRedis(callId, { actor: 'system', type: 'error_message', content: 'TTS audio not saved, playback skipped.' })
             .catch(e => call.callLogger.error(`RedisLog Error: ${e.message}`));
        }
    } else {
      call.callLogger.info(`TTS audio stream ended for call ${callId}, but no audio chunks were accumulated.`);
      logConversationToRedis(callId, { actor: 'system', type: 'system_message', content: 'Bot TTS stream ended, no audio chunks.' })
        .catch(e => call.callLogger.error(`RedisLog Error: ${e.message}`));
      eventPayloadBase.error = 'No audio chunks accumulated';
    }
    call.ttsAudioChunks = [];
    eventPayloadBase.savedFilePath = fullChunkSavedFilePath;

    serviceInstance.sendEventToFrontend({
        type: 'openai_tts_stream_ended',
        callId: callId,
        timestamp: new Date().toISOString(),
        source: 'OPENAI_CALLBACKS',
        payload: eventPayloadBase,
        logLevel: accumulatedChunksCount > 0 && !eventPayloadBase.error ? 'INFO' : 'WARN'
      });
}

export function _onOpenAIError(serviceInstance: AriClientService, callId: string, error: any): void {
