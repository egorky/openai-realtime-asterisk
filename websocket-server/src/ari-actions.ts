// Este archivo contendrá funciones de acción que modifican el estado de la llamada o interactúan con ARI/OpenAI.

import { CallResources } from './ari-call-resources';
import { AriClientService } from './ari-service'; // Para 'this' y acceso a activeCalls, client, etc.
import * as sessionManager from './sessionManager';
import { logConversationToRedis } from './redis-client';
import { _fullCleanup } from './ari-cleanup'; // Asumiendo que ari-cleanup.ts existe
import { Playback } from 'ari-client';

// Activa el streaming de OpenAI, manejando VAD y timers.
export async function _activateOpenAIStreaming(
    serviceInstance: AriClientService,
    callId: string,
    reason: string,
    isExpectingUserSpeechNext: boolean = true
): Promise<void> {
    const call = serviceInstance.activeCalls.get(callId);
    if (!call) {
      serviceInstance.logger.error(`[${callId}] _activateOpenAIStreaming: Call object not found. Reason: ${reason}`);
      return;
    }
    if (call.openAIStreamingActive && reason !== "vad_speech_during_delay_window_flush_attempt") {
        call.callLogger.debug(`[${callId}] _activateOpenAIStreaming called (Reason: ${reason}, ExpectUser: ${isExpectingUserSpeechNext}), but stream already active. No action.`);
        return;
    }
    if (call.isCleanupCalled) {
        call.callLogger.warn(`[${callId}] _activateOpenAIStreaming called (Reason: ${reason}, ExpectUser: ${isExpectingUserSpeechNext}), but cleanup already in progress. Aborting activation.`);
        return;
    }

    call.callLogger.info(`[${callId}] _activateOpenAIStreaming called. Reason: ${reason}, ExpectUser: ${isExpectingUserSpeechNext}. Current stream active: ${call.openAIStreamingActive}`);

    try {
      await sessionManager.startOpenAISession(callId, serviceInstance, call.config);
      call.callLogger.info(`[${callId}] Session manager ensured OpenAI session is active.`);
      call.openAIStreamingActive = true;
      serviceInstance.sendEventToFrontend({
        type: 'openai_stream_activated',
        callId: callId,
        timestamp: new Date().toISOString(),
        source: 'ARI_ACTIONS',
        payload: { reason: reason, expectingUserSpeech: isExpectingUserSpeechNext },
        logLevel: 'INFO'
      });

      if (call.pendingVADBufferFlush && call.vadAudioBuffer.length > 0) {
        call.callLogger.info(`[${callId}] Flushing ${call.vadAudioBuffer.length} VAD audio packets to OpenAI.`);
        call.isVADBufferingActive = false;
        for (const audioPayload of call.vadAudioBuffer) {
          sessionManager.sendAudioToOpenAI(callId, audioPayload);
        }
        call.vadAudioBuffer = [];
        call.pendingVADBufferFlush = false;
        call.isFlushingVADBuffer = false;
      } else {
        call.pendingVADBufferFlush = false;
        call.isFlushingVADBuffer = false;
        call.isVADBufferingActive = false;
      }

      if (isExpectingUserSpeechNext && !call.speechHasBegun) {
        call.callLogger.info(`[${callId}] Setting up timers for user speech detection.`);
        const noSpeechTimeout = call.config.appConfig.appRecognitionConfig.noSpeechBeginTimeoutSeconds;
        if (noSpeechTimeout > 0) {
          if (call.noSpeechBeginTimer) {
            clearTimeout(call.noSpeechBeginTimer);
          }
          call.callLogger.info(`[${callId}] Setting noSpeechBeginTimer for ${noSpeechTimeout}s.`);
          call.noSpeechBeginTimer = setTimeout(() => {
            const currentCallState = serviceInstance.activeCalls.get(callId);
            if (currentCallState && (currentCallState.isCleanupCalled || currentCallState.speechHasBegun)) {
              return;
            }
            call.callLogger.warn(`[${callId}] NoSpeechBeginTimer Fired! No speech detected by OpenAI in ${noSpeechTimeout}s.`);
            logConversationToRedis(callId, { actor: 'system', type: 'system_message', content: `No speech from OpenAI timeout (${noSpeechTimeout}s).`})
              .catch(e => call.callLogger.error(`RedisLog Error: ${e.message}`));
            sessionManager.stopOpenAISession(callId, "no_speech_timeout_in_ari");
            _fullCleanup(serviceInstance, callId, true, "NO_SPEECH_BEGIN_TIMEOUT");
          }, noSpeechTimeout * 1000);
        }

        const streamIdleTimeout = call.config.appConfig.appRecognitionConfig.initialOpenAIStreamIdleTimeoutSeconds ?? 10;
        if (streamIdleTimeout > 0) {
            if (call.initialOpenAIStreamIdleTimer) {
              clearTimeout(call.initialOpenAIStreamIdleTimer);
            }
            call.callLogger.info(`[${callId}] Setting initialOpenAIStreamIdleTimer for ${streamIdleTimeout}s.`);
            call.initialOpenAIStreamIdleTimer = setTimeout(() => {
               const currentCallState = serviceInstance.activeCalls.get(callId);
               if (currentCallState && (currentCallState.isCleanupCalled || currentCallState.speechHasBegun)) {
                 return;
               }
               call.callLogger.warn(`[${callId}] InitialOpenAIStreamIdleTimer Fired! OpenAI stream idle for ${streamIdleTimeout}s.`);
               logConversationToRedis(callId, { actor: 'system', type: 'system_message', content: `OpenAI stream idle timeout (${streamIdleTimeout}s).`})
                 .catch(e => call.callLogger.error(`RedisLog Error: ${e.message}`));
               sessionManager.stopOpenAISession(callId, "initial_stream_idle_timeout_in_ari");
               _fullCleanup(serviceInstance, callId, true, "OPENAI_STREAM_IDLE_TIMEOUT");
            }, streamIdleTimeout * 1000);
        }
      } else if (!isExpectingUserSpeechNext) {
        call.callLogger.info(`[${callId}] Not expecting user speech next. Timers for user speech detection are deferred.`);
      } else if (call.speechHasBegun) {
        call.callLogger.info(`[${callId}] Speech already begun, not starting NoSpeechBeginTimer or InitialOpenAIStreamIdleTimer.`);
      }

    } catch (error: any) {
        call.callLogger.error(`[${callId}] Error during _activateOpenAIStreaming: ${(error instanceof Error ? error.message : String(error))}`);
        serviceInstance.sendEventToFrontend({
            type: 'openai_stream_activation_failed',
            callId: callId,
            timestamp: new Date().toISOString(),
            source: 'ARI_ACTIONS',
            payload: { reason: reason, errorMessage: error.message },
            logLevel: 'ERROR'
        });
        logConversationToRedis(callId, { actor: 'system', type: 'error_message', content: `Error activating OpenAI stream: ${error.message}`})
          .catch(e => call.callLogger.error(`RedisLog Error: ${e.message}`));
        call.openAIStreamingActive = false;
        // _onOpenAIError se llamará desde sessionManager si el error es de ahí, o aquí directamente.
        // Esto necesita ser manejado por el manejador de errores de OpenAI.
        serviceInstance._onOpenAIError(callId, error); // Asumiendo que _onOpenAIError está en AriClientService o es importable
    }
}

// Detiene todos los playbacks activos para una llamada.
export async function _stopAllPlaybacks(serviceInstance: AriClientService, call: CallResources): Promise<void> {
    let wasPlaying = false;
    const playbacksToStop: (Playback | undefined)[] = [call.mainPlayback, call.waitingPlayback, call.postRecognitionWaitingPlayback, call.currentPlayingSoundId ? {id: call.currentPlayingSoundId} as Playback : undefined];
    for (const playback of playbacksToStop) {
      if (playback && playback.id) { // Verificar playback.id también
        wasPlaying = true; // Assume something was playing if we attempt to stop
        try {
          call.callLogger.debug(`Stopping playback ${playback.id}.`);
          // Verificar si serviceInstance.client existe
          if (serviceInstance.client) {
            await serviceInstance.client.playbacks.stop({ playbackId: playback.id });
          } else {
            call.callLogger.warn(`ARI client not available, cannot stop playback ${playback.id}`);
          }
        } catch (e:any) {
            // Comprobar si el error es porque el playback no existe
            if (e && e.message && (e.message.includes("404") || e.message.toLowerCase().includes("not found"))) {
                call.callLogger.info(`Playback ${playback.id} not found or already stopped: ${e.message}`);
            } else {
                call.callLogger.warn(`Error stopping playback ${playback.id}: ${(e instanceof Error ? e.message : String(e))}`);
            }
        }
      }
    }
    if(wasPlaying){
        serviceInstance.sendEventToFrontend({
            type: 'playback_all_stopped_action',
            callId: call.channel.id,
            timestamp: new Date().toISOString(),
            source: 'ARI_ACTIONS',
            payload: { reason: "Explicit stop all playbacks call from _stopAllPlaybacks" },
            logLevel: 'DEBUG'
          });
    }
    call.mainPlayback = undefined;
    call.waitingPlayback = undefined;
    call.postRecognitionWaitingPlayback = undefined;
    call.currentPlayingSoundId = null; // Ensure this is also cleared
}


// Finaliza la entrada DTMF y realiza la limpieza.
export async function _finalizeDtmfInput(serviceInstance: AriClientService, callId: string, reason: string): Promise<void> {
    const call = serviceInstance.activeCalls.get(callId);
    if (!call || call.isCleanupCalled || !call.dtmfModeActive) {
      if (call && !call.dtmfModeActive) {
        call.callLogger.debug(`_finalizeDtmfInput called for ${callId} but DTMF mode no longer active. Reason: ${reason}. Ignoring.`);
      }
      return;
    }

    call.callLogger.info(`Finalizing DTMF input for call ${callId}. Reason: ${reason}. Collected digits: '${call.collectedDtmfDigits}'`);
    serviceInstance.sendEventToFrontend({
        type: 'dtmf_input_finalized',
        callId: call.channel.id,
        timestamp: new Date().toISOString(),
        source: 'ARI_ACTIONS',
        payload: { finalDigits: call.collectedDtmfDigits, reason: reason },
        logLevel: 'INFO'
    });

    logConversationToRedis(callId, {
      actor: 'dtmf',
      type: 'dtmf_input',
      content: call.collectedDtmfDigits,
    }).catch(e => call.callLogger.error(`RedisLog Error (DTMF input): ${e.message}`));

    if (call.dtmfInterDigitTimer) { clearTimeout(call.dtmfInterDigitTimer); call.dtmfInterDigitTimer = null; }
    if (call.dtmfFinalTimer) { clearTimeout(call.dtmfFinalTimer); call.dtmfFinalTimer = null; }

    if (call.collectedDtmfDigits.length > 0) {
      try {
        await call.channel.setChannelVar({ variable: 'DTMF_RESULT', value: call.collectedDtmfDigits });
        call.callLogger.info(`DTMF_RESULT set to '${call.collectedDtmfDigits}' for channel ${call.channel.id}.`);
      } catch (e: any) {
        call.callLogger.error(`Error setting DTMF_RESULT for channel ${call.channel.id}: ${(e instanceof Error ? e.message : String(e))}`);
        logConversationToRedis(callId, { actor: 'system', type: 'error_message', content: `Error setting DTMF_RESULT: ${e.message}`})
          .catch(redisErr => call.callLogger.error(`RedisLog Error (DTMF set var fail): ${redisErr.message}`));
      }
    } else {
      call.callLogger.info(`No DTMF digits collected for channel ${call.channel.id} to set in DTMF_RESULT.`);
    }
    // _fullCleanup debe ser importado o parte de AriClientService
    _fullCleanup(serviceInstance, call.channel.id, false, `DTMF_FINALIZED_${reason}`);
}

// Reproduce audio (desde base64 o URI) al canal.
// Esta función ya estaba en AriClientService, se mueve aquí.
// Necesita acceso a serviceInstance._handlePlaybackFinished y serviceInstance.client
export async function playbackAudio(
    serviceInstance: AriClientService,
    channelId: string,
    audioPayloadB64?: string | null,
    mediaUri?: string | null
): Promise<void> {
    const call = serviceInstance.activeCalls.get(channelId);
    if (!call || call.isCleanupCalled || !serviceInstance.client) {
      (call?.callLogger || serviceInstance.logger).warn(`Cannot playback audio for call ${channelId}, call not active or client missing.`);
      return;
    }

    let mediaToPlay: string;
    if (mediaUri) {
      mediaToPlay = mediaUri;
      call.callLogger.info(`Attempting to play audio from media URI: ${mediaUri}`);
    } else if (audioPayloadB64) {
      call.callLogger.warn(`Playing audio via base64 for call ${channelId}. Length: ${audioPayloadB64.length}. This might fail for long audio strings if not using file playback.`);
      mediaToPlay = `sound:base64:${audioPayloadB64}`; // Esta sintaxis podría no ser universalmente soportada o eficiente.
    } else {
      call.callLogger.error(`playbackAudio called for ${channelId} without audioPayloadB64 or mediaUri.`);
      return;
    }

    const appRecogConf = call.config.appConfig.appRecognitionConfig;

    // If an overall TTS response is active, VAD/TALK_DETECT for barge-in is managed
    // at a higher level (when the queue processing starts/ends).
    // playbackAudio for individual chunks should not interfere with this overall management.
    if (call.isOverallTtsResponseActive) {
        call.callLogger.debug(`VAD Mode: Overall TTS response active. TALK_DETECT management for TTS stream handled by queue processor.`);
        // isVADBufferingActive should already be true if TALK_DETECT was set for the overall stream.
        // We don't want to reset vadAudioBuffer here for every chunk.
    } else {
        // Original logic for standalone playbacks (e.g., greetings) or if not in overall TTS stream
        if (!call.dtmfModeActive && appRecogConf.recognitionActivationMode === 'vad') {
            try {
                const talkThresholdForAri = appRecogConf.vadTalkThreshold;
                const silenceThresholdMsForAri = appRecogConf.vadSilenceThresholdMs;
                const talkDetectValue = `${talkThresholdForAri},${silenceThresholdMsForAri}`;

                call.callLogger.info(`VAD Mode: Ensuring TALK_DETECT is active for standalone playback barge-in. Value: '${talkDetectValue}'`);
                await call.channel.setChannelVar({ variable: 'TALK_DETECT(set)', value: talkDetectValue });
                call.isVADBufferingActive = true;
                call.vadAudioBuffer = []; // Clear buffer for a new standalone VAD session with playback
                call.pendingVADBufferFlush = false;
                call.isFlushingVADBuffer = false;
            } catch (e: any) {
                call.callLogger.warn(`Error setting TALK_DETECT for standalone playback barge-in on channel ${call.channel.id}: ${e.message}.`);
            }
        } else { // Not VAD mode or DTMF active for this standalone playback
            call.isVADBufferingActive = false;
            // call.vadAudioBuffer = []; // Consider if buffer should always be cleared if not VAD buffering
        }
    }

    try {
      if (call.waitingPlayback) {
        try {
          await call.waitingPlayback.stop(); // Usa el objeto playback directamente
          call.callLogger.debug(`Stopped previous waiting playback for ${channelId}.`);
        }
        catch(e:any) { call.callLogger.warn(`Error stopping previous waiting playback for ${channelId}: ${e.message}`);}
        call.waitingPlayback = undefined;
      }

      call.waitingPlayback = serviceInstance.client.Playback(); // Crea un nuevo objeto Playback
      const playbackId = call.waitingPlayback.id;
      call.callLogger.debug(`Created playback object ${playbackId} for ${channelId} (OpenAI TTS). Media: ${mediaToPlay.substring(0,60)}...`);

      const waitingPlaybackFinishedCb = () => {
        const currentCall = serviceInstance.activeCalls.get(channelId);
        if (!currentCall || currentCall.isCleanupCalled) return;
        currentCall.callLogger.debug(`OpenAI TTS Playback ${playbackId} finished for ${channelId}.`);
        if(currentCall.waitingPlayback && currentCall.waitingPlayback.id === playbackId) {
          currentCall.waitingPlayback = undefined;
        }
        if (serviceInstance.client && currentCall.waitingPlaybackFailedHandler) {
          serviceInstance.client.removeListener('PlaybackFailed' as any, currentCall.waitingPlaybackFailedHandler);
          currentCall.waitingPlaybackFailedHandler = null;
        }
        serviceInstance._handlePlaybackFinished(channelId, 'openai_tts_finished');
      };
      if (call.waitingPlayback) { // Asegurarse de que waitingPlayback se creó correctamente
          call.waitingPlayback.once('PlaybackFinished', waitingPlaybackFinishedCb);
      }


      const waitingPlaybackFailedCb = (event: any, failedPlayback: Playback) => {
        if (serviceInstance.client && failedPlayback.id === playbackId) { // Comparar con el playbackId capturado
          const currentCall = serviceInstance.activeCalls.get(channelId);
          if (!currentCall || currentCall.isCleanupCalled) return;
          currentCall.callLogger.error(`OpenAI TTS Playback ${playbackId} FAILED for ${channelId}: ${failedPlayback?.state}, Reason: ${event?.message || (event?.playback?.reason || 'Unknown')}`);
          if(currentCall.waitingPlayback && currentCall.waitingPlayback.id === playbackId) {
            currentCall.waitingPlayback = undefined;
          }
          // Asegurarse de que el handler que se remueve es el correcto.
          if (serviceInstance.client && currentCall.waitingPlaybackFailedHandler === waitingPlaybackFailedCb) {
            serviceInstance.client.removeListener('PlaybackFailed' as any, waitingPlaybackFailedCb);
            currentCall.waitingPlaybackFailedHandler = null;
          }
          serviceInstance._handlePlaybackFinished(channelId, 'openai_tts_failed');
        }
      };
      call.waitingPlaybackFailedHandler = waitingPlaybackFailedCb;
      serviceInstance.client.on('PlaybackFailed' as any, call.waitingPlaybackFailedHandler);


      await call.channel.play({ media: mediaToPlay }, call.waitingPlayback); // Pasar el objeto playback
      call.callLogger.info(`OpenAI TTS Playback ${playbackId} started for ${channelId}.`);
      serviceInstance.sendEventToFrontend({
        type: 'playback_started',
        callId: channelId,
        timestamp: new Date().toISOString(),
        source: 'ARI_ACTIONS',
        payload: {
          playbackId: playbackId, // Use the captured playbackId
          mediaUri: mediaToPlay.startsWith('sound:') ? mediaToPlay : 'base64_payload_or_direct_file',
          purpose: 'openai_tts' // Differentiate from greeting
        },
        logLevel: 'INFO'
      });
    } catch (err: any) {
      call.callLogger.error(`Error playing OpenAI TTS audio for ${channelId}: ${err.message || JSON.stringify(err)}`);
      serviceInstance.sendEventToFrontend({
        type: 'playback_failed_to_start',
        callId: channelId,
        timestamp: new Date().toISOString(),
        source: 'ARI_ACTIONS',
        payload: { mediaUri: mediaToPlay, errorMessage: err.message, purpose: 'openai_tts' },
        logLevel: 'ERROR'
      });
      if (call.waitingPlayback) { // Limpiar si el playback se creó pero play falló
        if (call.waitingPlaybackFailedHandler && serviceInstance.client) {
            serviceInstance.client.removeListener('PlaybackFailed' as any, call.waitingPlaybackFailedHandler); // Remover handler
            call.waitingPlaybackFailedHandler = null;
        }
        call.waitingPlayback = undefined;
      }
       serviceInstance._handlePlaybackFinished(channelId, 'openai_tts_playback_exception');
    }
}

// Procesar la cola de reproducción de TTS para el modo stream
export async function _processTtsPlaybackQueue(serviceInstance: AriClientService, callId: string): Promise<void> {
  const call = serviceInstance.activeCalls.get(callId);
  if (!call || call.isCleanupCalled) {
    (call?.callLogger || serviceInstance.logger).warn(`_processTtsPlaybackQueue: Call ${callId} not active or cleanup called. Aborting queue processing.`);
    return;
  }

  if (call.isTtsPlaying) {
    call.callLogger.debug(`_processTtsPlaybackQueue: TTS is already playing for call ${callId}. Queue will be processed once current playback finishes.`);
    return;
  }

  if (call.ttsPlaybackQueue.length === 0) {
    call.callLogger.debug(`_processTtsPlaybackQueue: TTS playback queue is empty for call ${callId}.`);
    call.isTtsPlaying = false; // Asegurarse de que esté false si la cola está vacía
    return;
  }

  call.isTtsPlaying = true;
  const mediaUriToPlay = call.ttsPlaybackQueue.shift(); // Obtener y remover el primer elemento

  if (!mediaUriToPlay) { // Debería ser redundante por el check de length, pero es una salvaguarda
    call.callLogger.warn(`_processTtsPlaybackQueue: Dequeued a null/undefined media URI for call ${callId}. This shouldn't happen.`);
    call.isTtsPlaying = false;
    // Intentar procesar el siguiente si la cola aún tiene elementos
    if (call.ttsPlaybackQueue.length > 0) {
        _processTtsPlaybackQueue(serviceInstance, callId);
    }
    return;
  }

  call.callLogger.info(`_processTtsPlaybackQueue: Playing next TTS chunk from queue for call ${callId}: ${mediaUriToPlay}. Queue size: ${call.ttsPlaybackQueue.length}`);
  serviceInstance.sendEventToFrontend({
    type: 'tts_playback_queue_processing_started',
    callId: callId,
    timestamp: new Date().toISOString(),
    source: 'ARI_ACTIONS',
    payload: { playingUri: mediaUriToPlay, remainingInQueue: call.ttsPlaybackQueue.length },
    logLevel: 'DEBUG'
  });

  try {
    // Usar la función playbackAudio existente, que ya maneja la creación de Playback y los eventos.
    // La diferencia clave es que _handlePlaybackFinished para TTS necesitará llamar a _processTtsPlaybackQueue.
    // Aquí no pasamos audioPayloadB64, solo mediaUri.
    await playbackAudio(serviceInstance, callId, null, mediaUriToPlay);
    // El ID del playback se asignará dentro de playbackAudio a call.waitingPlayback
    // y se usará para el currentPlayingSoundId si se decide que waitingPlayback es el correcto para esto.
    // Por ahora, playbackAudio ya maneja la lógica de "waitingPlayback".
    // Si se necesita un ID específico para el sonido de la cola, podría requerir un ajuste en playbackAudio
    // o almacenar el ID aquí si playbackAudio lo devuelve.
    // Asumimos que _handlePlaybackFinished se encargará de llamar a _processTtsPlaybackQueue de nuevo.
    // El evento 'playback_started' se emite desde dentro de playbackAudio.

  } catch (error: any) {
    call.callLogger.error(`_processTtsPlaybackQueue: Error initiating playback for ${mediaUriToPlay} on call ${callId}: ${error.message}`);
    call.isTtsPlaying = false;
    // Intentar el siguiente en la cola si falla uno. Podría ser una opción o llevar a un bucle si todos fallan.
    // Considerar una lógica de reintentos o de error máximo.
    if (call.ttsPlaybackQueue.length > 0) {
      setTimeout(() => _processTtsPlaybackQueue(serviceInstance, callId), 100); // Pequeño delay para evitar bucles rápidos en fallos persistentes
    }
  }
}


// Termina una llamada específica.
export async function endCall(serviceInstance: AriClientService, channelId: string): Promise<void> {
    const call = serviceInstance.activeCalls.get(channelId);
    if (!call) {
      serviceInstance.logger.warn(`Attempted to end non-existent call: ${channelId}`);
      serviceInstance.sendEventToFrontend({
        type: 'call_end_failed_not_found',
        callId: channelId,
        timestamp: new Date().toISOString(),
        source: 'ARI_ACTIONS',
        payload: { reason: "Call to end not found in active calls." },
        logLevel: 'WARN'
      });
      return;
    }
    call.callLogger.info(`endCall invoked. Initiating full cleanup.`);
    serviceInstance.sendEventToFrontend({
      type: 'call_ending_action_triggered',
      callId: channelId,
      timestamp: new Date().toISOString(),
      source: 'ARI_ACTIONS',
      payload: { reason: "Explicit endCall request" },
      logLevel: 'INFO'
    });
    // _fullCleanup debe ser importado o parte de AriClientService
    await _fullCleanup(serviceInstance, channelId, true, "EXPLICIT_ENDCALL_REQUEST");
}

// Reproduce TTS al llamante (parece ser un método alternativo o antiguo de TTS).
// Esta función también estaba en AriClientService.
// Necesita acceso a sessionManager.synthesizeSpeechOpenAI y this.playbackAudio (que ahora es local)
export async function _playTTSToCaller(serviceInstance: AriClientService, callId: string, textToSpeak: string): Promise<void> {
    const call = serviceInstance.activeCalls.get(callId);
    if (!call || call.isCleanupCalled) {
      (call?.callLogger || serviceInstance.logger).warn(`Cannot play TTS, call not active or cleanup called.`);
      return;
    }
    call.callLogger.info(`Requesting TTS for text: "${textToSpeak}"`);

    try {
      // @ts-ignore // synthesizeSpeechOpenAI puede no estar disponible en sessionManager o tener otra firma
      const audioBuffer = await sessionManager.synthesizeSpeechOpenAI(call.config, textToSpeak, call.callLogger);

      if (audioBuffer && audioBuffer.length > 0) {
        call.callLogger.warn("_playTTSToCaller was invoked. This path might be deprecated for Realtime API.");
        // Si se va a usar, debería guardar el audio y usar playbackAudio con mediaUri.
        // Por ejemplo:
        // const filePath = await saveAudioBufferToFile(audioBuffer, callId, call.config); // Necesitaría una función para esto
        // await playbackAudio(serviceInstance, callId, null, `sound:${filePath}`);
      } else {
        call.callLogger.error(`TTS synthesis (via _playTTSToCaller) failed or returned empty audio.`);
      }
    } catch (error: any) {
      call.callLogger.error(`Error during TTS synthesis or playback (via _playTTSToCaller): ${error.message}`, error);
    }
}
