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
import { _activateOpenAIStreaming, _stopAllPlaybacks, _finalizeDtmfInput } from './ari-actions';
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

    if (call.speechEndSilenceTimer) { clearTimeout(call.speechEndSilenceTimer); call.speechEndSilenceTimer = null; }
    call.finalTranscription = transcript;
    call.callLogger.info(`Final transcript processed. Requesting OpenAI response for text: "${transcript}"`);

    logConversationToRedis(callId, {
      actor: 'caller',
      type: 'transcript',
      content: transcript,
    }).catch(e => call.callLogger.error(`RedisLog Error (caller transcript): ${e.message}`));

    try {
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

    if (playbackMode === "stream") {
      loggerToUse.debug(`Streaming TTS audio chunk, length: ${audioChunkBase64.length}.`);
      try {
        const audioBuffer = Buffer.from(audioChunkBase64, 'base64');
        if (audioBuffer.length === 0) {
          loggerToUse.warn(`[StreamPlayback] Decoded audio chunk is empty for call ${callId}. Skipping playback of this chunk.`);
          return;
        }

        const recordingsBaseDir = '/var/lib/asterisk/sounds';
        const openaiRecordingsDir = path.join(recordingsBaseDir, 'openai_stream_chunks');
        if (!fs.existsSync(openaiRecordingsDir)) {
          fs.mkdirSync(openaiRecordingsDir, { recursive: true });
        }
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const chunkFilename = `openai_tts_chunk_${callId}_${timestamp}.ulaw`;
        const absoluteChunkPath = path.join(openaiRecordingsDir, chunkFilename);

        fs.writeFileSync(absoluteChunkPath, audioBuffer);
        loggerToUse.info(`[StreamPlayback] Saved TTS chunk to ${absoluteChunkPath}`);

        call.streamedTtsChunkFiles.push(absoluteChunkPath);
        // playbackAudio ahora está en ari-actions.ts y necesita serviceInstance
        await serviceInstance.playbackAudio(callId, null, `sound:openai_stream_chunks/${chunkFilename.replace(/\.ulaw$/, '')}`);
        loggerToUse.info(`[StreamPlayback] Initiated playback for TTS chunk ${chunkFilename}`);

      } catch (e: any) {
        loggerToUse.error(`[StreamPlayback] Error processing or playing TTS chunk for call ${callId}: ${e.message}`);
      }
    } else { // full_chunk mode
      if (!call.ttsAudioChunks) {
        call.callLogger.error('_onOpenAIAudioChunk (full_chunk): CRITICAL - ttsAudioChunks was undefined.');
        call.ttsAudioChunks = [];
      }
      call.callLogger.debug(`(Full Chunk Mode) Received TTS audio chunk, length: ${audioChunkBase64.length}. Accumulating. Previous #chunks: ${call.ttsAudioChunks.length}`);
      call.ttsAudioChunks.push(audioChunkBase64);
    }
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

    if (playbackMode === "stream") {
      loggerToUse.info(`[StreamPlayback] Audio stream ended. All chunks should have been processed and played individually.`);
      return;
    }

    if (!call.ttsAudioChunks) {
      call.callLogger.error(`_onOpenAIAudioStreamEnd (full_chunk): CRITICAL - ttsAudioChunks is undefined.`);
      return;
    }
    call.callLogger.info(`(Full Chunk Mode) Checking accumulated ttsAudioChunks for call ${callId}. Length: ${call.ttsAudioChunks.length}`);

    if (call.ttsAudioChunks.length > 0) {
      call.callLogger.debug(`(Full Chunk Mode) First chunk content (first 50 chars): ${call.ttsAudioChunks[0]?.substring(0,50)}`);
      call.callLogger.info(`(Full Chunk Mode) Processing ${call.ttsAudioChunks.length} audio chunks for call ${callId}.`);
      const decodedBuffers: Buffer[] = [];
      let totalOriginalBase64Length = 0;

      for (let i = 0; i < call.ttsAudioChunks.length; i++) {
        const chunkBase64 = call.ttsAudioChunks[i];
        if (typeof chunkBase64 === 'string' && chunkBase64.length > 0) {
          totalOriginalBase64Length += chunkBase64.length;
          try {
            const decodedChunk = Buffer.from(chunkBase64, 'base64');
            decodedBuffers.push(decodedChunk);
            call.callLogger.debug(`Chunk ${i}: Original Length=${chunkBase64.length}, Decoded Length=${decodedChunk.length}.`);
          } catch (e: any) {
            call.callLogger.error(`Error decoding chunk ${i} (length ${chunkBase64.length}): ${e.message}. Chunk (first 50): ${chunkBase64.substring(0,50)}`);
          }
        } else {
          call.callLogger.warn(`Chunk ${i} is not a valid string or is empty. Skipping.`);
        }
      }
      call.callLogger.info(`Total original base64 length from all chunks for call ${callId}: ${totalOriginalBase64Length}`);

      if (decodedBuffers.length === 0) {
        call.callLogger.warn(`No audio chunks could be successfully decoded for call ${callId}. Skipping playback.`);
        logConversationToRedis(callId, { actor: 'system', type: 'error_message', content: 'TTS audio decoding failed, no chunks decoded.' })
          .catch(e => call.callLogger.error(`RedisLog Error: ${e.message}`));
        call.ttsAudioChunks = [];
        return;
      }

      const audioInputBuffer = Buffer.concat(decodedBuffers);
      call.callLogger.info(`Concatenated ${decodedBuffers.length} decoded buffer(s). Total audioInputBuffer length for call ${callId}: ${audioInputBuffer.length} bytes.`);

      if (audioInputBuffer.length === 0) {
          call.callLogger.warn(`Combined decoded audio data for call ${callId} is empty. Skipping playback and saving.`);
          logConversationToRedis(callId, { actor: 'system', type: 'system_message', content: 'Bot TTS audio was empty after decoding.' })
            .catch(e => call.callLogger.error(`RedisLog Error: ${e.message}`));
          call.ttsAudioChunks = [];
          return;
      }

      let soundPathForPlayback: string | null = null;
      try {
        const recordingsBaseDir = '/var/lib/asterisk/sounds';
        const openaiRecordingsDir = path.join(recordingsBaseDir, 'openai');

        if (!fs.existsSync(openaiRecordingsDir)){
            fs.mkdirSync(openaiRecordingsDir, { recursive: true });
            call.callLogger.info(`Created recordings directory: ${openaiRecordingsDir}`);
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const outputFormat = call.config.openAIRealtimeAPI.outputAudioFormat?.toLowerCase();
        let filenameOnly = `openai_tts_${callId}_${timestamp}`;
        let filenameWithExt: string;
        let finalAudioBuffer = audioInputBuffer;

        if (outputFormat?.startsWith('pcm')) {
          call.callLogger.info(`Output format is PCM. Attempting to wrap with WAV header.`);
          const bytesPerSample = 2;
          const numChannels = 1;
          const outputSampleRate = call.config.openAIRealtimeAPI.outputAudioSampleRate || 8000;
          const numFrames = audioInputBuffer.length / (bytesPerSample * numChannels);
          if (audioInputBuffer.length % (bytesPerSample * numChannels) !== 0) {
              call.callLogger.warn(`PCM audio buffer length issue for WAV header.`);
          }
          const wavHeader = createWavHeader({ numFrames, numChannels, sampleRate: outputSampleRate, bytesPerSample });
          finalAudioBuffer = Buffer.concat([wavHeader, audioInputBuffer]);
          filenameWithExt = `${filenameOnly}.wav`;
          call.callLogger.info(`PCM data wrapped with WAV header. File: ${filenameWithExt}`);
        } else if (outputFormat === 'g711_ulaw' || outputFormat === 'mulaw_8000hz' || outputFormat === 'ulaw') {
          filenameWithExt = `${filenameOnly}.ulaw`;
          call.callLogger.info(`Output format is uLaw. Saving as .ulaw.`);
        } else if (outputFormat === 'mp3') {
           filenameWithExt = `${filenameOnly}.mp3`;
        } else if (outputFormat === 'opus') {
           filenameWithExt = `${filenameOnly}.opus`;
        } else {
          call.callLogger.warn(`Unknown or unhandled output audio format: '${outputFormat}'. Saving as .raw`);
          filenameWithExt = `${filenameOnly}.raw`;
        }

        const absoluteFilepath = path.join(openaiRecordingsDir, filenameWithExt);
        fs.writeFileSync(absoluteFilepath, finalAudioBuffer);
        call.callLogger.info(`TTS audio for call ${callId} saved to ${absoluteFilepath}`);
        soundPathForPlayback = `openai/${filenameOnly}`;

      } catch (saveError: any) {
        call.callLogger.error(`Failed to save or process TTS audio for call ${callId}: ${saveError.message}`, saveError);
        logConversationToRedis(callId, { actor: 'system', type: 'error_message', content: `TTS audio save/process error: ${saveError.message}` })
          .catch(e => call.callLogger.error(`RedisLog Error: ${e.message}`));
      }

      if (soundPathForPlayback) {
        call.callLogger.info(`Playing accumulated TTS audio for call ${callId} from sound path: sound:${soundPathForPlayback}`);
        let ttsSpokenText = call.finalTranscription; // This needs review for accuracy.
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
          // playbackAudio ahora está en ari-actions.ts y necesita serviceInstance
          await serviceInstance.playbackAudio(callId, null, `sound:${soundPathForPlayback}`);
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
    }
    call.ttsAudioChunks = [];
}

export function _onOpenAIError(serviceInstance: AriClientService, callId: string, error: any): void {
    const call = serviceInstance.activeCalls.get(callId);
    if (!call || call.isCleanupCalled) return;
    const errorMessage = error.message || (typeof error === 'string' ? error : JSON.stringify(error));
    call.callLogger.error(`OpenAI stream error reported by sessionManager:`, errorMessage);
    call.openAIStreamError = error;

    logConversationToRedis(callId, {
      actor: 'error',
      type: 'error_message',
      content: `OpenAI Stream Error: ${errorMessage}`
    }).catch(e => call.callLogger.error(`RedisLog Error (OpenAI stream error): ${e.message}`));

    if (call.noSpeechBeginTimer) { clearTimeout(call.noSpeechBeginTimer); call.noSpeechBeginTimer = null; }
    if (call.initialOpenAIStreamIdleTimer) { clearTimeout(call.initialOpenAIStreamIdleTimer); call.initialOpenAIStreamIdleTimer = null; }
    if (call.speechEndSilenceTimer) { clearTimeout(call.speechEndSilenceTimer); call.speechEndSilenceTimer = null; }
    _fullCleanup(serviceInstance, callId, true, "OPENAI_STREAM_ERROR");
}

export function _onOpenAISessionEnded(serviceInstance: AriClientService, callId: string, reason: string): void {
    const call = serviceInstance.activeCalls.get(callId);
    if (!call || call.isCleanupCalled) return;
    call.callLogger.info(`OpenAI session ended event from sessionManager. Reason: ${reason}`);
    logConversationToRedis(callId, { actor: 'system', type: 'system_message', content: `OpenAI session ended. Reason: ${reason}`})
      .catch(e => call.callLogger.error(`RedisLog Error (OpenAI session ended): ${e.message}`));
    call.openAIStreamingActive = false;

    if (call.noSpeechBeginTimer) { clearTimeout(call.noSpeechBeginTimer); call.noSpeechBeginTimer = null; }
    if (call.initialOpenAIStreamIdleTimer) { clearTimeout(call.initialOpenAIStreamIdleTimer); call.initialOpenAIStreamIdleTimer = null; }
    if (call.speechEndSilenceTimer) { clearTimeout(call.speechEndSilenceTimer); call.speechEndSilenceTimer = null; }

    if (!call.finalTranscription && !call.openAIStreamError && !call.dtmfModeActive && reason !== 'dtmf_interrupt' && reason !== 'cleanup_DTMF_INTERDIGIT_TIMEOUT' && reason !== 'cleanup_DTMF_FINAL_TIMEOUT' && reason !== 'cleanup_DTMF_TERMINATOR_RECEIVED' && reason !== 'cleanup_DTMF_MAX_DIGITS_REACHED') {
        call.callLogger.warn(`OpenAI session ended (reason: ${reason}) without final transcript from OpenAI, error, or DTMF completion. Checking for async STT.`);

        const appRecogConf = call.config.appConfig.appRecognitionConfig;
        if (appRecogConf.asyncSttEnabled && call.callerAudioBufferForCurrentTurn.length > 0) {
          call.callLogger.info(`Initiating async STT as OpenAI did not provide a transcript for the last turn.`);
          logConversationToRedis(callId, {
            actor: 'system',
            type: 'system_message',
            content: `No transcript from OpenAI (reason: ${reason}). Attempting asynchronous STT.`,
            originalTurnTimestamp: call.currentTurnStartTime,
          } as ConversationTurn).catch(e => call.callLogger.error(`RedisLog Error: ${e.message}`));

          const audioBufferToTranscribe = Buffer.concat(call.callerAudioBufferForCurrentTurn);
          transcribeAudioAsync({
            callId: callId,
            audioBuffer: audioBufferToTranscribe,
            audioFormat: appRecogConf.asyncSttAudioFormat as any || 'mulaw',
            sampleRate: appRecogConf.asyncSttAudioSampleRate || 8000,
            config: call.config,
            callLogger: call.callLogger,
            originalTurnTimestamp: call.currentTurnStartTime,
          }).catch(e => {
            call.callLogger.error(`Async STT initiation failed: ${e.message}`);
            logConversationToRedis(callId, {
              actor: 'system',
              type: 'error_message',
              content: `Async STT process initiation error: ${e.message}`,
              originalTurnTimestamp: call.currentTurnStartTime,
            } as ConversationTurn).catch(redisErr => call.callLogger.error(`RedisLog Error: ${redisErr.message}`));
          });
        } else if (appRecogConf.asyncSttEnabled && call.callerAudioBufferForCurrentTurn.length === 0) {
          call.callLogger.warn(`Async STT enabled, but no audio was buffered for the last turn.`);
           logConversationToRedis(callId, {
            actor: 'system',
            type: 'system_message',
            content: `No transcript from OpenAI (reason: ${reason}). Async STT enabled but no audio buffered for this turn.`,
            originalTurnTimestamp: call.currentTurnStartTime,
          } as ConversationTurn).catch(e => call.callLogger.error(`RedisLog Error: ${e.message}`));
        }
    } else {
        call.callLogger.info(`OpenAI session ended (reason: ${reason}). This is likely part of a normal flow. Async STT not triggered.`);
    }
    call.callerAudioBufferForCurrentTurn = [];
}


// ###########################
// ##### ARI Event Handlers #####
// ###########################

export async function onStasisStart(serviceInstance: AriClientService, event: StasisStart, incomingChannel: Channel): Promise<void> {
    const callId = incomingChannel.id;
    const callerNumber = incomingChannel.caller?.number || 'UnknownCaller';
    // El logger para la llamada se crea usando el logger base de serviceInstance
    const callLogger = serviceInstance.logger.child({ callId: callId, callerId: callerNumber }, undefined, serviceInstance);

    const localCallConfig = getCallSpecificConfig(callLogger, incomingChannel);

    if (incomingChannel.name.startsWith('UnicastRTP/') || incomingChannel.name.startsWith('Snoop/')) {
      const utilityCallLogger = serviceInstance.logger.child({ callId: incomingChannel.id, callerId: `utility-${incomingChannel.name.split('/')[0]}` }, undefined, serviceInstance);
      utilityCallLogger.info(`StasisStart for utility channel ${incomingChannel.name} (${incomingChannel.id}). Answering if needed and ignoring further setup.`);
      try {
        if (incomingChannel.state === 'RINGING' || incomingChannel.state === 'RING') {
          await incomingChannel.answer();
          callLogger.info(`Answered utility channel ${incomingChannel.name}.`);
        }
      } catch (err: any) {
        callLogger.warn(`Error answering utility channel ${incomingChannel.name} (may already be up or hungup): ${err.message}`);
      }
      return;
    }

    callLogger.info(`StasisStart: New call entering application '${ASTERISK_ARI_APP_NAME}'.`);
    callLogger.info(`New call onStasisStart. Channel ID: ${incomingChannel.id}, Name: ${incomingChannel.name}, Caller: ${JSON.stringify(incomingChannel.caller)}, Dialplan: ${JSON.stringify(incomingChannel.dialplan)}`);

    if (serviceInstance.appOwnedChannelIds.has(callId)) {
      callLogger.info(`Channel ${callId} is app-owned. Ignoring StasisStart.`); return;
    }

    const callResources: CallResources = {
      channel: incomingChannel, config: localCallConfig, callLogger, isCleanupCalled: false,
      promptPlaybackStoppedForInterim: false, fallbackAttempted: false, openAIStreamError: null,
      openAIStreamingActive: false, isOpenAIStreamEnding: false, speechHasBegun: false,
      finalTranscription: "",
      collectedDtmfDigits: "", dtmfModeActive: false, speechRecognitionDisabledDueToDtmf: false, dtmfInterruptedSpeech: false,
      vadSpeechDetected: false, vadAudioBuffer: [], isVADBufferingActive: false, isFlushingVADBuffer: false,
      pendingVADBufferFlush: false, vadRecognitionTriggeredAfterInitialDelay: false, vadSpeechActiveDuringDelay: false,
      vadInitialSilenceDelayCompleted: false,
      vadActivationDelayCompleted: true,
      bargeInActivationTimer: null, noSpeechBeginTimer: null, initialOpenAIStreamIdleTimer: null,
      speechEndSilenceTimer: null, maxRecognitionDurationTimer: null,
      dtmfInterDigitTimer: null, dtmfFinalTimer: null,
      vadMaxWaitAfterPromptTimer: null, vadActivationDelayTimer: null, vadInitialSilenceDelayTimer: null,
      ttsAudioChunks: [],
      currentTtsResponseId: undefined,
      callerAudioBufferForCurrentTurn: [],
      currentTurnStartTime: new Date().toISOString(),
      isFirstInteraction: true,
      streamedTtsChunkFiles: [],
    };
    serviceInstance.activeCalls.set(callId, callResources);
    serviceInstance.currentPrimaryCallId = callId;
    serviceInstance.notifyActiveCallsChanged();
    callLogger.info(`Call resources initialized. Mode: ${localCallConfig.appConfig.appRecognitionConfig.recognitionActivationMode}. Set as current primary call.`);

    try {
      callLogger.info(`Attempting to answer incoming channel ${callId}.`);
      try {
        await incomingChannel.answer();
        callLogger.info(`Successfully answered incoming channel ${callId}.`);
      } catch (err: any) {
        callLogger.error(`FAILED to answer incoming channel ${callId}. Error: ${err.message || JSON.stringify(err)}`);
        throw err;
      }
      incomingChannel.once('StasisEnd', (endEvent: StasisEnd, endedChannel: Channel) => {
        callLogger.info(`Primary channel ${callId} StasisEnd. Cleanup.`);
        _fullCleanup(serviceInstance, callId, false, "PRIMARY_CHANNEL_STASIS_ENDED");
      });

      if (!serviceInstance.client) { throw new Error("ARI client not connected."); }

      callResources.userBridge = await serviceInstance.client.bridges.create({ type: 'mixing', name: `user_b_${callId}` });
      callLogger.info(`Successfully created userBridge ${callResources.userBridge.id} for call ${callId}.`);
      await callResources.userBridge.addChannel({ channel: callId });
      callLogger.info(`Successfully added channel ${callId} to userBridge ${callResources.userBridge.id}.`);

      callResources.snoopBridge = await serviceInstance.client.bridges.create({ type: 'mixing', name: `snoop_b_${callId}` });
      callLogger.info(`Successfully created snoopBridge ${callResources.snoopBridge.id} for call ${callId}.`);

      callResources.rtpServer = new RtpServer(callLogger.child({ component: 'RtpServer'}, undefined, serviceInstance));
      const rtpServerAddress = await callResources.rtpServer.start(0, DEFAULT_RTP_HOST_IP);
      callLogger.info(`RTP Server started for call ${callId}, listening on ${rtpServerAddress.host}:${rtpServerAddress.port}.`);

      const externalMediaFormat = 'ulaw';
      callResources.externalMediaChannel = await serviceInstance.client.channels.externalMedia({
        app: ASTERISK_ARI_APP_NAME,
        external_host: `${rtpServerAddress.host}:${rtpServerAddress.port}`,
        format: externalMediaFormat,
        encapsulation: 'rtp'
      });
      callLogger.info(`Successfully created externalMediaChannel ${callResources.externalMediaChannel.id} for call ${callId} with format ${externalMediaFormat}.`);
      serviceInstance.appOwnedChannelIds.add(callResources.externalMediaChannel.id);

      const snoopDirection = 'in' as ('in' | 'out' | 'both');
      callResources.snoopChannel = await serviceInstance.client.channels.snoopChannelWithId({ channelId: callId, snoopId: `snoop_${callId}`, app: ASTERISK_ARI_APP_NAME, spy: snoopDirection });
      callLogger.info(`Successfully created snoopChannel ${callResources.snoopChannel.id} for call ${callId} with direction '${snoopDirection}'.`);
      serviceInstance.appOwnedChannelIds.add(callResources.snoopChannel.id);

      await callResources.snoopBridge.addChannel({ channel: callResources.externalMediaChannel.id });
      callLogger.info(`Successfully added externalMediaChannel ${callResources.externalMediaChannel.id} to snoopBridge ${callResources.snoopBridge.id}.`);
      await callResources.snoopBridge.addChannel({ channel: callResources.snoopChannel.id });
      callLogger.info(`Successfully added snoopChannel ${callResources.snoopChannel.id} to snoopBridge ${callResources.snoopBridge.id}.`);

      callResources.rtpServer.on('audioPacket', (audioPayload: Buffer) => {
        const call = serviceInstance.activeCalls.get(callId);
        if (call && !call.isCleanupCalled) {
          call.callLogger.silly?.(`Received raw audio packet from Asterisk, length: ${audioPayload.length}.`);
          if (call.openAIStreamingActive && !call.dtmfModeActive) {
            if (call.callerAudioBufferForCurrentTurn.length < (MAX_VAD_BUFFER_PACKETS * 2) ) {
               call.callerAudioBufferForCurrentTurn.push(audioPayload);
            } else {
               call.callLogger.warn(`Caller audio buffer for async STT reached limit for call ${callId}. Further audio for this turn might be truncated.`);
            }
          }
          if (call.openAIStreamingActive && !call.isVADBufferingActive && !call.pendingVADBufferFlush && !call.isFlushingVADBuffer) {
            sessionManager.sendAudioToOpenAI(callId, audioPayload);
          }
          if (call.config.appConfig.appRecognitionConfig.recognitionActivationMode === 'vad' &&
              call.isVADBufferingActive &&
              !call.openAIStreamingActive) {
            if (call.vadAudioBuffer.length < MAX_VAD_BUFFER_PACKETS) {
              call.vadAudioBuffer.push(audioPayload);
            } else {
              call.callLogger.warn(`VAD audio buffer limit reached for call ${callId}. Oldest packet discarded.`);
              call.vadAudioBuffer.shift();
              call.vadAudioBuffer.push(audioPayload);
            }
          }
        }
      });

      sessionManager.handleCallConnection(callId, serviceInstance);
      callLogger.info(`Call connection details passed to SessionManager.`);

      const appRecogConf = localCallConfig.appConfig.appRecognitionConfig;
      if (appRecogConf.maxRecognitionDurationSeconds && appRecogConf.maxRecognitionDurationSeconds > 0) {
        callResources.maxRecognitionDurationTimer = setTimeout(() => {
            const currentCall = serviceInstance.activeCalls.get(callId);
            if(currentCall && !currentCall.isCleanupCalled) {
              currentCall.callLogger.warn(`Max recognition duration ${appRecogConf.maxRecognitionDurationSeconds}s reached.`);
              logConversationToRedis(callId, { actor: 'system', type: 'system_message', content: `Max recognition duration timeout (${appRecogConf.maxRecognitionDurationSeconds}s).`})
                .catch(e => currentCall.callLogger.error(`RedisLog Error: ${e.message}`));
              _fullCleanup(serviceInstance, callId, true, "MAX_RECOGNITION_DURATION_TIMEOUT");
            }
        }, appRecogConf.maxRecognitionDurationSeconds * 1000);
      }

      const activationMode = appRecogConf.recognitionActivationMode;
      const initialUserPromptIsSet = !!appRecogConf.initialUserPrompt && appRecogConf.initialUserPrompt.trim() !== "";
      callLogger.info(`Recognition Activation Mode: ${activationMode}, InitialUserPrompt Set: ${initialUserPromptIsSet}`);

      let effectiveActivationMode = activationMode;
      const firModeStasis = appRecogConf.firstInteractionRecognitionMode;
      if (callResources.isFirstInteraction && (firModeStasis === "fixedDelay" || firModeStasis === "Immediate" || firModeStasis === "vad")) {
        effectiveActivationMode = firModeStasis;
        callLogger.info(`Using FIRST_INTERACTION_RECOGNITION_MODE for StasisStart: ${effectiveActivationMode}`);
      } else {
        callLogger.info(`Using global RECOGNITION_ACTIVATION_MODE for StasisStart: ${effectiveActivationMode}`);
      }

      if (effectiveActivationMode === 'Immediate') {
        callLogger.info(`Immediate mode: Activating OpenAI stream on StasisStart. ExpectingUserSpeechNext: ${!initialUserPromptIsSet}`);
        _activateOpenAIStreaming(serviceInstance, callId, "Immediate_mode_on_start", !initialUserPromptIsSet);
      } else if (effectiveActivationMode === 'fixedDelay') {
        const delaySeconds = appRecogConf.bargeInDelaySeconds;
        callLogger.info(`fixedDelay mode: bargeInDelaySeconds = ${delaySeconds}s.`);
        if (delaySeconds > 0) {
          callResources.bargeInActivationTimer = setTimeout(() => {
            if (callResources.isCleanupCalled || callResources.openAIStreamingActive) return;
            callLogger.info(`fixedDelay: bargeInDelaySeconds (${delaySeconds}s) elapsed. Activating OpenAI stream.`);
            const currentAppRecogConf = serviceInstance.activeCalls.get(callId)?.config.appConfig.appRecognitionConfig;
            const stillExpectInitialPrompt = !!currentAppRecogConf?.initialUserPrompt && currentAppRecogConf.initialUserPrompt.trim() !== "";
            _activateOpenAIStreaming(serviceInstance, callId, "fixedDelay_barge_in_timer_expired", !stillExpectInitialPrompt);
          }, delaySeconds * 1000);
        } else {
          _activateOpenAIStreaming(serviceInstance, callId, "fixedDelay_immediate_activation (delay is 0)", !initialUserPromptIsSet);
        }
      } else if (effectiveActivationMode === 'vad') {
        callResources.isVADBufferingActive = true;
        const talkThresholdForAri = appRecogConf.vadTalkThreshold;
        const silenceThresholdMsForAri = appRecogConf.vadSilenceThresholdMs;
        const talkDetectValue = `${talkThresholdForAri},${silenceThresholdMsForAri}`;

        callLogger.info(`VAD mode: Attempting to set TALK_DETECT on channel ${callId} with value: '${talkDetectValue}' (EnergyThreshold,SilenceMs)`);
        try {
            await incomingChannel.setChannelVar({ variable: 'TALK_DETECT(set)', value: talkDetectValue });
            callLogger.info(`VAD mode: Successfully set TALK_DETECT on channel ${callId}.`);
        } catch (e:any) {
            callLogger.error(`VAD mode: FAILED to set TALK_DETECT on channel ${callId}: ${e.message}. Proceeding without local VAD events.`);
        }

        if (appRecogConf.vadRecogActivation === 'vadMode') {
          const initialSilenceDelayS = appRecogConf.vadInitialSilenceDelaySeconds;
          callResources.vadInitialSilenceDelayCompleted = (initialSilenceDelayS <= 0);

          if (!callResources.vadInitialSilenceDelayCompleted) {
            callLogger.info(`VAD (vadMode): Starting vadInitialSilenceDelaySeconds: ${initialSilenceDelayS}s.`);
            callResources.vadInitialSilenceDelayTimer = setTimeout(() => {
              if(callResources.isCleanupCalled) return;
              callResources.vadInitialSilenceDelayCompleted = true;
              callLogger.info(`VAD (vadMode): vadInitialSilenceDelaySeconds completed.`);
              _handleVADDelaysCompleted(serviceInstance, callId);
            }, initialSilenceDelayS * 1000);
          } else {
            _handleVADDelaysCompleted(serviceInstance, callId);
          }
        }
      }

      const greetingAudio = appRecogConf.greetingAudioPath;
      if (greetingAudio && serviceInstance.client) {
        callLogger.info(`Playing greeting/prompt audio: ${greetingAudio}`);
        logConversationToRedis(callId, { actor: 'bot', type: 'tts_prompt', content: `Playing greeting: ${greetingAudio}`})
          .catch(e => callLogger.error(`RedisLog Error (greeting): ${e.message}`));

        callResources.mainPlayback = serviceInstance.client.Playback();
        if (callResources.mainPlayback) {
          const mainPlaybackId = callResources.mainPlayback.id;
          const playbackFailedHandler = (pfEvent: any, failedPlayback: Playback) => {
            if (serviceInstance.client && failedPlayback.id === mainPlaybackId) {
              const currentCall = serviceInstance.activeCalls.get(callId);
              if (currentCall?.mainPlayback?.id === mainPlaybackId) {
                currentCall.callLogger.warn(`Main greeting playback ${failedPlayback.id} FAILED. State: ${failedPlayback.state}`);
                logConversationToRedis(callId, { actor: 'system', type: 'error_message', content: `Main greeting playback ${failedPlayback.id} FAILED.`})
                  .catch(e => currentCall.callLogger.error(`RedisLog Error (greeting fail): ${e.message}`));
                _handlePlaybackFinished(serviceInstance, callId, 'main_greeting_failed');
              }
              if (currentCall?.playbackFailedHandler) {
                serviceInstance.client?.removeListener('PlaybackFailed' as any, currentCall.playbackFailedHandler);
                currentCall.playbackFailedHandler = null;
              }
            }
          };
          callResources.playbackFailedHandler = playbackFailedHandler;
          serviceInstance.client.on('PlaybackFailed' as any, callResources.playbackFailedHandler);

          callResources.mainPlayback.once('PlaybackFinished', (pbFinishedEvent: PlaybackFinished, instance: Playback) => {
            const currentCall = serviceInstance.activeCalls.get(callId);
            if (currentCall?.playbackFailedHandler && serviceInstance.client && instance.id === currentCall.mainPlayback?.id) {
              serviceInstance.client.removeListener('PlaybackFailed' as any, currentCall.playbackFailedHandler);
              currentCall.playbackFailedHandler = null;
            }
            if (currentCall?.mainPlayback?.id === instance.id) {
              currentCall.callLogger.info(`Main greeting playback ${instance.id} FINISHED.`);
              _handlePlaybackFinished(serviceInstance, callId, 'main_greeting_finished');
            }
          });
          await callResources.channel.play({ media: greetingAudio }, callResources.mainPlayback);
          callLogger.info(`Successfully started main greeting playback ${callResources.mainPlayback.id}.`);
        } else {
           callLogger.error(`Failed to create mainPlayback object for greeting.`);
           logConversationToRedis(callId, { actor: 'system', type: 'error_message', content: `Failed to create mainPlayback for greeting.`})
             .catch(e => callLogger.error(`RedisLog Error (greeting creation fail): ${e.message}`));
           _handlePlaybackFinished(serviceInstance, callId, 'main_greeting_creation_failed');
        }
      } else {
        const logMsg = greetingAudio ? `ARI client not available for greeting playback.` : `No greeting audio specified. Proceeding to post-prompt logic directly.`;
        callLogger.info(logMsg);
        logConversationToRedis(callId, { actor: 'system', type: 'system_message', content: logMsg})
          .catch(e => callLogger.error(`RedisLog Error (no greeting): ${e.message}`));
        _handlePlaybackFinished(serviceInstance, callId, 'main_greeting_skipped_or_no_client');
      }
      callLogger.info(`StasisStart setup complete for call ${callId}.`);
      serviceInstance.sendEventToFrontend({ type: "ari_call_status_update", payload: { status: "active", callId: callId, callerId: incomingChannel.caller?.number || "Unknown" }});
    } catch (err: any) {
      callLogger.error(`Error in StasisStart for ${callId}: ${(err instanceof Error ? err.message : String(err))}`);
      serviceInstance.sendEventToFrontend({ type: "ari_call_status_update", payload: { status: "error", callId: callId, callerId: incomingChannel.caller?.number || "Unknown", errorMessage: (err instanceof Error ? err.message : String(err)) }});
      await _fullCleanup(serviceInstance, callId, true, "STASIS_START_ERROR");
    }
}

export async function _onDtmfReceived(serviceInstance: AriClientService, event: ChannelDtmfReceived, channel: Channel): Promise<void> {
    const call = serviceInstance.activeCalls.get(channel.id);
    if (!call || call.isCleanupCalled) { return; }
    if (call.channel.id !== channel.id) {
      call.callLogger.warn(`DTMF event for channel ${channel.id} but current call channel is ${call.channel.id}. Ignoring.`);
      return;
    }

    call.callLogger.info(`DTMF digit '${event.digit}' received on channel ${channel.id}.`);
    const dtmfConfig = call.config.appConfig.dtmfConfig;

    if (!dtmfConfig.enableDtmfRecognition) {
      call.callLogger.info(`DTMF recognition is disabled by configuration. Ignoring digit '${event.digit}'.`);
      return;
    }

    call.callLogger.info(`DTMF mode activated by digit '${event.digit}'. Interrupting other recognition activities.`);
    call.dtmfModeActive = true;
    call.speechRecognitionDisabledDueToDtmf = true;

    call.isVADBufferingActive = false;
    call.vadAudioBuffer = [];
    call.pendingVADBufferFlush = false;
    call.isFlushingVADBuffer = false;

    await _stopAllPlaybacks(serviceInstance, call);
    call.promptPlaybackStoppedForInterim = true;

    if (call.openAIStreamingActive) {
      call.callLogger.info(`DTMF: Interrupting active OpenAI stream for call ${call.channel.id}.`);
      call.dtmfInterruptedSpeech = true;
      sessionManager.stopOpenAISession(call.channel.id, 'dtmf_interrupt');
      call.openAIStreamingActive = false;
    }

    if (call.noSpeechBeginTimer) { clearTimeout(call.noSpeechBeginTimer); call.noSpeechBeginTimer = null; }
    if (call.initialOpenAIStreamIdleTimer) { clearTimeout(call.initialOpenAIStreamIdleTimer); call.initialOpenAIStreamIdleTimer = null; }
    if (call.speechEndSilenceTimer) { clearTimeout(call.speechEndSilenceTimer); call.speechEndSilenceTimer = null; }
    call.speechHasBegun = false;

    if (call.vadMaxWaitAfterPromptTimer) { clearTimeout(call.vadMaxWaitAfterPromptTimer); call.vadMaxWaitAfterPromptTimer = null; }
    if (call.vadInitialSilenceDelayTimer) { clearTimeout(call.vadInitialSilenceDelayTimer); call.vadInitialSilenceDelayTimer = null; }
    if (call.bargeInActivationTimer) { clearTimeout(call.bargeInActivationTimer); call.bargeInActivationTimer = null; }

    if (call.config.appConfig.appRecognitionConfig.recognitionActivationMode === 'vad') {
        try {
            call.callLogger.info(`DTMF: Removing TALK_DETECT from channel ${channel.id} as DTMF is now active.`);
            await channel.setChannelVar({ variable: 'TALK_DETECT(remove)', value: 'true' });
        } catch (e: any) {
            call.callLogger.warn(`DTMF: Error removing TALK_DETECT from channel ${channel.id}: ${e.message}`);
        }
    }

    call.collectedDtmfDigits += event.digit;
    call.callLogger.info(`Collected DTMF for call ${call.channel.id}: ${call.collectedDtmfDigits}`);

    if (call.dtmfInterDigitTimer) clearTimeout(call.dtmfInterDigitTimer);
    const interDigitTimeoutMs = (dtmfConfig.dtmfInterDigitTimeoutSeconds) * 1000;
    call.dtmfInterDigitTimer = setTimeout(() => {
      if (call.isCleanupCalled || !call.dtmfModeActive) return;
      call.callLogger.info(`DTMF inter-digit timeout for call ${call.channel.id}. Digits: '${call.collectedDtmfDigits}'. Finalizing.`);
      _finalizeDtmfInput(serviceInstance, call.channel.id, "DTMF_INTERDIGIT_TIMEOUT");
    }, interDigitTimeoutMs);

    if (call.dtmfFinalTimer) clearTimeout(call.dtmfFinalTimer);
    const finalTimeoutMs = (dtmfConfig.dtmfFinalTimeoutSeconds) * 1000;
    call.dtmfFinalTimer = setTimeout(() => {
      if (call.isCleanupCalled || !call.dtmfModeActive) return;
      call.callLogger.info(`DTMF final timeout for call ${call.channel.id}. Digits: '${call.collectedDtmfDigits}'. Finalizing.`);
      _finalizeDtmfInput(serviceInstance, call.channel.id, "DTMF_FINAL_TIMEOUT");
    }, finalTimeoutMs);

    const maxDigits = dtmfConfig.dtmfMaxDigits ?? 16;
    const terminatorDigit = dtmfConfig.dtmfTerminatorDigit ?? "#";

    if (event.digit === terminatorDigit) {
      call.callLogger.info(`DTMF terminator digit '${terminatorDigit}' received for call ${call.channel.id}. Finalizing.`);
      _finalizeDtmfInput(serviceInstance, call.channel.id, "DTMF_TERMINATOR_RECEIVED");
    } else if (call.collectedDtmfDigits.length >= maxDigits) {
      call.callLogger.info(`Max DTMF digits (${maxDigits}) reached for call ${call.channel.id}. Finalizing.`);
      _finalizeDtmfInput(serviceInstance, call.channel.id, "DTMF_MAX_DIGITS_REACHED");
    }
}

export function _handlePlaybackFinished(serviceInstance: AriClientService, callId: string, reason: string): void {
    const call = serviceInstance.activeCalls.get(callId);
    if (!call || call.isCleanupCalled) {
      return;
    }

    const appRecogConf = call.config.appConfig.appRecognitionConfig;
    let currentActivationMode = appRecogConf.recognitionActivationMode;

    const firModePlayback = appRecogConf.firstInteractionRecognitionMode;
    if (call.isFirstInteraction && (firModePlayback === "fixedDelay" || firModePlayback === "Immediate" || firModePlayback === "vad")) {
      currentActivationMode = firModePlayback;
      call.callLogger.info(`Using FIRST_INTERACTION_RECOGNITION_MODE: ${currentActivationMode}`);
    } else {
      call.callLogger.info(`Using global RECOGNITION_ACTIVATION_MODE: ${currentActivationMode}`);
    }

    if (reason.startsWith('main_greeting_')) {
      call.callLogger.info(`Main greeting/prompt finished or failed. Reason: ${reason}. Handling post-prompt logic for main greeting using mode: ${currentActivationMode}.`);
      call.mainPlayback = undefined;

      switch (currentActivationMode) {
        case 'fixedDelay':
          call.callLogger.info(`fixedDelay mode: Main greeting finished. Barge-in logic handled by onStasisStart timer or direct activation.`);
          if (!call.openAIStreamingActive && !call.bargeInActivationTimer) {
            call.callLogger.warn(`fixedDelay mode: Main greeting finished, stream not active, no pending barge-in timer. Safeguard activation.`);
            _activateOpenAIStreaming(serviceInstance, callId, "fixedDelay_safeguard_post_main_greeting");
          }
          break;
        case 'Immediate':
          call.callLogger.info(`Immediate mode: Main greeting finished. OpenAI stream should be active or activating.`);
          if (!call.openAIStreamingActive) {
            call.callLogger.warn(`Immediate mode: Main greeting finished, stream not active. Safeguard activation.`);
            const initialUserPromptIsSet = !!appRecogConf.initialUserPrompt && appRecogConf.initialUserPrompt.trim() !== "";
            _activateOpenAIStreaming(serviceInstance, callId, "Immediate_safeguard_post_main_greeting", !initialUserPromptIsSet);
          }
          break;
        case 'vad':
          if (appRecogConf.vadRecogActivation === 'afterPrompt') {
            call.callLogger.info(`VAD mode (afterPrompt): Main greeting finished. Activating VAD logic.`);
            _handlePostPromptVADLogic(serviceInstance, callId);
          } else if (appRecogConf.vadRecogActivation === 'vadMode') {
            call.callLogger.info(`VAD mode (vadMode): Main greeting finished. VAD logic (delays/TALK_DETECT) already in effect or starting.`);
            _handleVADDelaysCompleted(serviceInstance, callId);
            if (call.vadInitialSilenceDelayCompleted && !call.openAIStreamingActive && !call.vadRecognitionTriggeredAfterInitialDelay) {
                 _handlePostPromptVADLogic(serviceInstance, callId);
            }
          }
          break;
        default:
          call.callLogger.warn(`Unhandled recognitionActivationMode: ${currentActivationMode} after main_greeting.`);
      }
    } else if (reason.startsWith('openai_tts_')) {
      call.callLogger.info(`OpenAI TTS playback finished or failed. Reason: ${reason}. Preparing for next caller turn.`);

      if (call.isFirstInteraction) {
        call.callLogger.info("First interaction has concluded. Subsequent interactions will use global recognition mode.");
        call.isFirstInteraction = false;
        currentActivationMode = appRecogConf.recognitionActivationMode;
        call.callLogger.info(`Switching to global RECOGNITION_ACTIVATION_MODE for next turn: ${currentActivationMode}`);
      }

      call.speechHasBegun = false;
      call.finalTranscription = "";
      call.openAIStreamingActive = false;
      call.vadRecognitionTriggeredAfterInitialDelay = false;
      call.promptPlaybackStoppedForInterim = false;
      call.isVADBufferingActive = false;
      call.pendingVADBufferFlush = false;
      call.isFlushingVADBuffer = false;

      if (call.noSpeechBeginTimer) { clearTimeout(call.noSpeechBeginTimer); call.noSpeechBeginTimer = null; call.callLogger.debug("Cleared noSpeechBeginTimer post-TTS.");}
      if (call.speechEndSilenceTimer) { clearTimeout(call.speechEndSilenceTimer); call.speechEndSilenceTimer = null; call.callLogger.debug("Cleared speechEndSilenceTimer post-TTS.");}
      if (call.initialOpenAIStreamIdleTimer) { clearTimeout(call.initialOpenAIStreamIdleTimer); call.initialOpenAIStreamIdleTimer = null; call.callLogger.debug("Cleared initialOpenAIStreamIdleTimer post-TTS.");}

      call.currentTurnStartTime = new Date().toISOString();
      call.callerAudioBufferForCurrentTurn = [];

      call.callLogger.info(`OpenAI TTS done. Transitioning to listen for caller based on mode: ${currentActivationMode}. New turn start time: ${call.currentTurnStartTime}`);

      switch (currentActivationMode) {
        case 'fixedDelay':
          const delaySeconds = appRecogConf.bargeInDelaySeconds;
          call.callLogger.info(`fixedDelay mode: Post-TTS. Activating OpenAI stream after ${delaySeconds}s.`);
          if (call.bargeInActivationTimer) clearTimeout(call.bargeInActivationTimer);
          if (delaySeconds > 0) {
            call.bargeInActivationTimer = setTimeout(() => {
              if (call.isCleanupCalled || call.openAIStreamingActive) return;
              _activateOpenAIStreaming(serviceInstance, callId, "fixedDelay_post_tts_delay_expired");
            }, delaySeconds * 1000);
          } else {
            _activateOpenAIStreaming(serviceInstance, callId, "fixedDelay_post_tts_immediate");
          }
          break;
        case 'Immediate':
          call.callLogger.info(`Immediate mode: Post-TTS. Activating OpenAI stream immediately.`);
          _activateOpenAIStreaming(serviceInstance, callId, "Immediate_post_tts");
          break;
        case 'vad':
          call.callLogger.info(`VAD mode: Post-TTS. VAD logic (TALK_DETECT) should be active. Sub-mode: ${appRecogConf.vadRecogActivation}`);
          _handlePostPromptVADLogic(serviceInstance, callId);
          break;
        default:
          call.callLogger.warn(`Unhandled RECOGNITION_ACTIVATION_MODE: ${currentActivationMode} after OpenAI TTS.`);
      }
    } else {
      call.callLogger.debug(`_handlePlaybackFinished called for other reason: ${reason}`);
    }
}

export function _handleVADDelaysCompleted(serviceInstance: AriClientService, callId: string): void {
    const call = serviceInstance.activeCalls.get(callId);
    if (!call || call.isCleanupCalled ||
        call.config.appConfig.appRecognitionConfig.recognitionActivationMode !== 'vad' ||
        call.config.appConfig.appRecognitionConfig.vadRecogActivation !== 'vadMode') {
      return;
    }
    call.callLogger.debug(`VAD (vadMode) delays completed. InitialSilence: ${call.vadInitialSilenceDelayCompleted}, vadInitialSilenceDelaySeconds: ${call.config.appConfig.appRecognitionConfig.vadInitialSilenceDelaySeconds}s completed.`);

    if (call.vadInitialSilenceDelayCompleted) {
      call.callLogger.info(`VAD (vadMode): Initial silence delay completed.`);
      if (call.vadRecognitionTriggeredAfterInitialDelay || call.openAIStreamingActive) {
          call.callLogger.debug(`VAD (vadMode): Stream already active or VAD triggered. No action needed from delay completion.`);
          return;
      }

      if (call.vadSpeechActiveDuringDelay) {
        call.callLogger.info(`VAD (vadMode): Speech was detected *during* the initial silence delay. Activating OpenAI stream now.`);
        call.vadRecognitionTriggeredAfterInitialDelay = true;
        call.pendingVADBufferFlush = true;
        call.isFlushingVADBuffer = true;
        _activateOpenAIStreaming(serviceInstance, callId, "vad_speech_during_delay_window_flush_attempt");

        if(call.channel) {
            call.callLogger.info(`VAD (vadMode): Removing TALK_DETECT as stream is activating due to speech during delay.`);
            call.channel.setChannelVar({ variable: 'TALK_DETECT(remove)', value: 'true' })
                .catch(e => call.callLogger.warn(`VAD (vadMode): Error removing TALK_DETECT: ${e.message}`));
        }
      } else {
        call.callLogger.info(`VAD (vadMode): Initial silence delay completed, no prior speech detected during delay. TALK_DETECT is active and listening.`);
        const maxWait = call.config.appConfig.appRecognitionConfig.vadMaxWaitAfterPromptSeconds;
        if (maxWait > 0 && !call.openAIStreamingActive && !call.vadRecognitionTriggeredAfterInitialDelay) {
            if(call.vadMaxWaitAfterPromptTimer) clearTimeout(call.vadMaxWaitAfterPromptTimer);
            call.vadMaxWaitAfterPromptTimer = setTimeout(() => {
                if (call.isCleanupCalled || call.openAIStreamingActive || call.vadRecognitionTriggeredAfterInitialDelay) return;
                call.callLogger.warn(`VAD (vadMode): Max wait ${maxWait}s for speech (post-initial-delay) reached. Ending call.`);
                if(call.channel) { call.channel.setChannelVar({ variable: 'TALK_DETECT(remove)', value: 'true' }).catch(e => call.callLogger.warn(`VAD: Error removing TALK_DETECT on timeout: ${e.message}`)); }
                _fullCleanup(serviceInstance, callId, true, "VAD_MODE_MAX_WAIT_POST_INITIAL_DELAY_TIMEOUT");
            }, maxWait * 1000);
            call.callLogger.info(`VAD (vadMode): Started max wait timer (${maxWait}s) for speech to begin after initial delay.`);
        }
      }
    }
}

export function _handlePostPromptVADLogic(serviceInstance: AriClientService, callId: string): void {
    const call = serviceInstance.activeCalls.get(callId);
    if (!call || call.isCleanupCalled || call.config.appConfig.appRecognitionConfig.recognitionActivationMode !== 'vad') {
      return;
    }
    const appRecogConf = call.config.appConfig.appRecognitionConfig;
    call.callLogger.info(`VAD: Handling post-prompt logic for vadRecogActivation: '${appRecogConf.vadRecogActivation}'.`);

    if (appRecogConf.vadRecogActivation === 'afterPrompt') {
      if (call.vadRecognitionTriggeredAfterInitialDelay || call.openAIStreamingActive) {
        call.callLogger.debug(`VAD (afterPrompt): Stream already active or VAD triggered. No action from post-prompt logic.`);
        return;
      }

      if (call.vadSpeechDetected) {
        call.callLogger.info(`VAD (afterPrompt): Speech was detected *during* the prompt. Activating OpenAI stream now.`);
        call.vadRecognitionTriggeredAfterInitialDelay = true;
        _activateOpenAIStreaming(serviceInstance, callId, "vad_afterPrompt_speech_during_prompt_playback");
        call.pendingVADBufferFlush = true;

        if(call.channel) {
            call.callLogger.info(`VAD (afterPrompt): Removing TALK_DETECT as stream is activating due to speech during prompt.`);
            call.channel.setChannelVar({ variable: 'TALK_DETECT(remove)', value: 'true' })
                .catch(e => call.callLogger.warn(`VAD (afterPrompt): Error removing TALK_DETECT: ${e.message}`));
        }
      } else {
        call.callLogger.info(`VAD (afterPrompt): Prompt finished, no speech detected during prompt. TALK_DETECT is active. Starting vadMaxWaitAfterPromptSeconds timer.`);
        const maxWait = appRecogConf.vadMaxWaitAfterPromptSeconds;
        if (maxWait > 0) {
          if(call.vadMaxWaitAfterPromptTimer) clearTimeout(call.vadMaxWaitAfterPromptTimer);
          call.vadMaxWaitAfterPromptTimer = setTimeout(() => {
            if (call.isCleanupCalled || call.vadRecognitionTriggeredAfterInitialDelay || call.openAIStreamingActive) return;
            call.callLogger.warn(`VAD (afterPrompt): Max wait ${maxWait}s for speech (post-prompt) reached. Ending call.`);
            if(call.channel) { call.channel.setChannelVar({ variable: 'TALK_DETECT(remove)', value: 'true' }).catch(e => call.callLogger.warn(`VAD: Error removing TALK_DETECT on timeout: ${e.message}`)); }
            _fullCleanup(serviceInstance, callId, true, "VAD_AFTERPROMPT_MAX_WAIT_TIMEOUT");
          }, maxWait * 1000);
        }
      }
    } else if (appRecogConf.vadRecogActivation === 'vadMode') {
      call.callLogger.info(`VAD (vadMode): Post-prompt logic invoked. Initial silence delay should have been handled. TALK_DETECT is active.`);
      if (!call.openAIStreamingActive && !call.vadRecognitionTriggeredAfterInitialDelay && call.vadInitialSilenceDelayCompleted) {
          const maxWait = appRecogConf.vadMaxWaitAfterPromptSeconds;
          if (maxWait > 0 && !call.vadMaxWaitAfterPromptTimer) {
              call.vadMaxWaitAfterPromptTimer = setTimeout(() => {
                  if (call.isCleanupCalled || call.openAIStreamingActive || call.vadRecognitionTriggeredAfterInitialDelay) return;
                  call.callLogger.warn(`VAD (vadMode): Max wait ${maxWait}s for speech (after prompt/initial delays) reached. Ending call.`);
                  if(call.channel) { call.channel.setChannelVar({ variable: 'TALK_DETECT(remove)', value: 'true' }).catch(e => call.callLogger.warn(`VAD: Error removing TALK_DETECT on timeout: ${e.message}`)); }
                  _fullCleanup(serviceInstance, callId, true, "VAD_MODE_MAX_WAIT_POST_PROMPT_TIMEOUT");
              }, maxWait * 1000);
              call.callLogger.info(`VAD (vadMode): Started max wait timer (${maxWait}s) for speech after prompt/initial delay.`);
          }
      }
    }
}

export async function _onChannelTalkingStarted(serviceInstance: AriClientService, event: ChannelTalkingStarted, channel: Channel): Promise<void> {
    const call = serviceInstance.activeCalls.get(channel.id);
    if (!call || call.channel.id !== channel.id || call.isCleanupCalled ||
        call.config.appConfig.appRecognitionConfig.recognitionActivationMode !== 'vad') {
      return;
    }
    call.callLogger.info(`TALK_DETECT: Speech started on channel ${channel.id}.`);

    if (call.openAIStreamingActive) {
        call.callLogger.debug(`TALK_DETECT: Speech started, but OpenAI stream already active. Ignoring.`);
        return;
    }
    if (call.vadRecognitionTriggeredAfterInitialDelay && call.openAIStreamingActive) {
        call.callLogger.debug(`TALK_DETECT: Speech started, but VAD recognition already triggered and stream active. Ignoring.`);
        return;
    }

    const appRecogConf = call.config.appConfig.appRecognitionConfig;
    const vadRecogActivation = appRecogConf.vadRecogActivation;

    if (vadRecogActivation === 'vadMode') {
      if (!call.vadInitialSilenceDelayCompleted) {
        call.callLogger.debug(`VAD (vadMode): Speech detected (ChannelTalkingStarted) *during* vadInitialSilenceDelay. Marking vadSpeechActiveDuringDelay.`);
        call.vadSpeechActiveDuringDelay = true;
        call.vadSpeechDetected = true;
        return;
      }
      call.callLogger.info(`VAD (vadMode): Speech detected (ChannelTalkingStarted) *after* initial silence delay. This is the trigger to start OpenAI stream.`);
    } else if (vadRecogActivation === 'afterPrompt') {
      if (call.mainPlayback || call.waitingPlayback) {
        call.callLogger.info(`VAD (afterPrompt): Speech detected (ChannelTalkingStarted) *during* active playback. This is a barge-in attempt.`);
        call.vadSpeechDetected = true;
        await _stopAllPlaybacks(serviceInstance, call);
        call.promptPlaybackStoppedForInterim = true;
        return;
      }
      call.callLogger.info(`VAD (afterPrompt): Speech detected (ChannelTalkingStarted) and no prompt/TTS was playing. This is the trigger to start OpenAI stream.`);
    } else {
      call.callLogger.error(`VAD: Unhandled vadRecogActivation mode: ${vadRecogActivation} in _onChannelTalkingStarted.`);
      return;
    }

    call.vadSpeechDetected = true;
    call.vadRecognitionTriggeredAfterInitialDelay = true;

    const initialUserPromptIsSet = !!call.config.appConfig.appRecognitionConfig.initialUserPrompt && call.config.appConfig.appRecognitionConfig.initialUserPrompt.trim() !== "";
    let playbackToStop: Playback | undefined = undefined;
    let playbackType = "";

    if (call.mainPlayback && call.mainPlayback.id && !call.promptPlaybackStoppedForInterim) {
        const mainPlaybackId = call.mainPlayback.id;
        try {
            const currentMainPlaybackState = await serviceInstance.client?.playbacks.get({playbackId: mainPlaybackId});
            if (call.mainPlayback && call.mainPlayback.id === mainPlaybackId && !call.promptPlaybackStoppedForInterim) {
                if (currentMainPlaybackState && currentMainPlaybackState.state === 'playing') {
                    playbackToStop = call.mainPlayback;
                    playbackType = "main greeting";
                } else {
                    if (currentMainPlaybackState?.state !== 'playing') call.mainPlayback = undefined;
                }
            }
        } catch (e:any) {
            if (call.mainPlayback && call.mainPlayback.id === mainPlaybackId) call.mainPlayback = undefined;
        }
    }

    if (!playbackToStop && call.waitingPlayback && call.waitingPlayback.id && !call.promptPlaybackStoppedForInterim) {
        const waitingPlaybackId = call.waitingPlayback.id;
        try {
            const currentWaitingPlaybackState = await serviceInstance.client?.playbacks.get({playbackId: waitingPlaybackId});
            if (call.waitingPlayback && call.waitingPlayback.id === waitingPlaybackId && !call.promptPlaybackStoppedForInterim) {
                if (currentWaitingPlaybackState && currentWaitingPlaybackState.state === 'playing') {
                    playbackToStop = call.waitingPlayback;
                    playbackType = "OpenAI TTS";
                } else {
                    if (currentWaitingPlaybackState?.state !== 'playing') call.waitingPlayback = undefined;
                }
            }
        } catch (e:any) {
            if (call.waitingPlayback && call.waitingPlayback.id === waitingPlaybackId) call.waitingPlayback = undefined;
        }
    }

    if (playbackToStop && playbackToStop.id) {
      const playbackToStopId = playbackToStop.id;
      try {
        call.callLogger.info(`VAD: Barge-in: Stopping ${playbackType} playback (ID: ${playbackToStopId}) due to ChannelTalkingStarted.`);
        await playbackToStop.stop();
        call.promptPlaybackStoppedForInterim = true;
      } catch (e: any) {
         // Log less severely if playback already gone
      } finally {
        if (call.mainPlayback && call.mainPlayback.id === playbackToStopId) call.mainPlayback = undefined;
        else if (call.waitingPlayback && call.waitingPlayback.id === playbackToStopId) call.waitingPlayback = undefined;
      }
    }

    if(call.vadMaxWaitAfterPromptTimer) { clearTimeout(call.vadMaxWaitAfterPromptTimer); call.vadMaxWaitAfterPromptTimer = null; }

    if (playbackToStop) {
        call.pendingVADBufferFlush = true;
        call.callLogger.info(`[${channel.id}] VAD: Barge-in on ${playbackType} detected. Flagging VAD buffer for flush.`);
    }

    call.callLogger.info(`[${channel.id}] VAD: Activating OpenAI stream. ExpectingUserSpeechNext: ${!initialUserPromptIsSet}`);
    _activateOpenAIStreaming(serviceInstance, call.channel.id, "vad_channel_talking_started", !initialUserPromptIsSet);

    try {
      call.callLogger.info(`VAD: Removing TALK_DETECT from channel '${channel.id}' as speech confirmed and OpenAI stream activating.`);
      await channel.setChannelVar({ variable: 'TALK_DETECT(remove)', value: 'true' });
    } catch (e: any) { call.callLogger.warn(`VAD: Error removing TALK_DETECT from channel '${channel.id}': ${e.message}`); }
}

export async function _onChannelTalkingFinished(serviceInstance: AriClientService, event: ChannelTalkingFinished, channel: Channel): Promise<void> {
    const call = serviceInstance.activeCalls.get(channel.id);
    if (!call || call.channel.id !== channel.id || call.isCleanupCalled ||
        call.config.appConfig.appRecognitionConfig.recognitionActivationMode !== 'vad') {
      return;
    }
    call.callLogger.info(`TALK_DETECT: Speech finished on channel ${channel.id}. Last speech duration: ${event.duration}ms.`);
    call.vadSpeechDetected = false;

    const appRecogConf = call.config.appConfig.appRecognitionConfig;
    if (appRecogConf.vadRecogActivation === 'vadMode') {
        if (!call.vadInitialSilenceDelayCompleted) {
            call.vadSpeechActiveDuringDelay = false;
            call.callLogger.debug(`VAD (vadMode): Speech finished during initial silence delay. Resetting vadSpeechActiveDuringDelay.`);
        }
    }

    if (call.openAIStreamingActive) {
        call.callLogger.info(`TALK_DETECT: Speech finished, but OpenAI stream is active. OpenAI will manage end-of-turn.`);
    } else {
        call.callLogger.info(`TALK_DETECT: Speech finished, OpenAI stream is NOT active. State: vadSpeechDetected=${call.vadSpeechDetected}, vadRecognitionTriggered=${call.vadRecognitionTriggeredAfterInitialDelay}`);
    }
}

export function onAppOwnedChannelStasisEnd(serviceInstance: AriClientService, event: StasisEnd, channel: Channel): void {
    const callLogger = serviceInstance.logger.child({ callId: channel.id, callerId: `app-owned-${channel.name.split('/')[0]}` }, undefined, serviceInstance);
    callLogger.info(`App-owned channel ${channel.name} (${channel.id}) left Stasis. Cleaning up associated resources if any.`);
    // Potentially remove from appOwnedChannelIds if it was added.
    serviceInstance.appOwnedChannelIds.delete(channel.id);

    // Check if this app-owned channel was part of an active call and needs specific resource cleanup
    // (e.g., if it was an externalMediaChannel or snoopChannel for a call that's still active).
    // This is complex. For now, just log and remove from the set.
    // _fullCleanup handles removing these channels if the main call ends.
    // If an app-owned channel ends *before* the main call, its resources are usually tied to the main call's lifecycle.
}

export async function onStasisEnd(serviceInstance: AriClientService, event: StasisEnd, channel: Channel): Promise<void> {
    const call = serviceInstance.activeCalls.get(channel.id);
    if (call) {
        call.callLogger.info(`Main channel ${channel.id} StasisEnd event. Initiating cleanup.`);
        // El _fullCleanup ya está en el 'once' de StasisEnd en onStasisStart,
        // así que esta llamada podría ser redundante o causar doble limpieza.
        // Se comenta para evitarlo. Si el 'once' no cubre todos los casos, se puede reactivar.
        // await _fullCleanup(serviceInstance, channel.id, false, "MAIN_CHANNEL_STASIS_END_EVENT");
    } else {
        // serviceInstance.logger.info(`StasisEnd for unmanaged channel ${channel.id}. Ignoring.`);
    }
}

export function onAriError(serviceInstance: AriClientService, err: any): void {
    serviceInstance.logger.error('General ARI Client Error:', err);
}

export function onAriClose(serviceInstance: AriClientService): void {
    serviceInstance.logger.info('ARI connection closed. Cleaning up all active calls.');
    const callIds = Array.from(serviceInstance.activeCalls.keys());
    for (const callId of callIds) {
        const call = serviceInstance.activeCalls.get(callId);
        if (call) {
            call.callLogger.warn(`ARI connection closed, forcing cleanup for this call.`);
            // _fullCleanup es async, pero aquí no podemos hacer await en un bucle síncrono.
            // Se invoca y la limpieza procederá.
            _fullCleanup(serviceInstance, callId, true, "ARI_CONNECTION_CLOSED");
        }
    }
    if (serviceInstance.activeCalls.size > 0) { // Si _fullCleanup no los eliminó a todos (improbable si funciona bien)
        serviceInstance.activeCalls.clear();
        serviceInstance.notifyActiveCallsChanged();
    }
    serviceInstance.appOwnedChannelIds.clear();
}
