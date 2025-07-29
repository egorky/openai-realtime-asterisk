// Este archivo contendrá la lógica para limpiar recursos de llamada y timers.

import { CallResources } from './ari-call-resources';
import { AriClientService } from './ari-service'; // Para 'this' y acceso a activeCalls, client, etc.
import * as sessionManager from './sessionManager';
import Ari from 'ari-client'; // Mover al principio
import fs from 'node:fs';
import { LoggerInstance } from './types';


// Limpia todos los temporizadores asociados a una llamada.
export function _clearCallTimers(call: CallResources): void {
    if (call.bargeInActivationTimer) clearTimeout(call.bargeInActivationTimer);
    if (call.noSpeechBeginTimer) clearTimeout(call.noSpeechBeginTimer);
    if (call.initialOpenAIStreamIdleTimer) clearTimeout(call.initialOpenAIStreamIdleTimer);
    if (call.speechEndSilenceTimer) clearTimeout(call.speechEndSilenceTimer);
    if (call.maxRecognitionDurationTimer) clearTimeout(call.maxRecognitionDurationTimer);
    if (call.dtmfInterDigitTimer) clearTimeout(call.dtmfInterDigitTimer);
    if (call.dtmfFinalTimer) clearTimeout(call.dtmfFinalTimer);
    if (call.vadMaxWaitAfterPromptTimer) clearTimeout(call.vadMaxWaitAfterPromptTimer);
    if (call.vadActivationDelayTimer) clearTimeout(call.vadActivationDelayTimer); // Obsoleto, pero se limpia por si acaso
    if (call.vadInitialSilenceDelayTimer) clearTimeout(call.vadInitialSilenceDelayTimer);

    call.bargeInActivationTimer = null;
    call.noSpeechBeginTimer = null;
    call.initialOpenAIStreamIdleTimer = null;
    call.speechEndSilenceTimer = null;
    call.maxRecognitionDurationTimer = null;
    call.dtmfInterDigitTimer = null;
    call.dtmfFinalTimer = null;
    call.vadMaxWaitAfterPromptTimer = null;
    call.vadActivationDelayTimer = null;
    call.vadInitialSilenceDelayTimer = null;
    // call.callLogger.debug('All call timers cleared.'); // El callLogger está en `call`
}

// Realiza una limpieza completa de la llamada, incluyendo colgar el canal principal si se especifica.
export async function _fullCleanup(
    serviceInstance: AriClientService,
    callId: string,
    hangupMainChannel: boolean,
    reason: string
): Promise<void> {
    const call = serviceInstance.activeCalls.get(callId);

    if (call) {
      if (call.isCleanupCalled) {
        // call.callLogger.debug(`_fullCleanup for ${callId} already called or in progress. Skipping.`);
        return;
      }
      call.isCleanupCalled = true; // Mark cleanup started immediately to prevent re-entry
      call.callLogger.info(`Full cleanup initiated for call ${callId}. Reason: ${reason}. Hangup main: ${hangupMainChannel}`);
      serviceInstance.sendEventToFrontend({
        type: 'call_cleanup_started',
        callId: callId,
        timestamp: new Date().toISOString(),
        source: 'ARI_CLEANUP',
        payload: { reason: reason, hangupMainChannel: hangupMainChannel },
        logLevel: 'INFO'
      });

      // Enviar evento al frontend antes de limpiar currentPrimaryCallId
      if (serviceInstance.currentPrimaryCallId === callId) {
        serviceInstance.sendEventToFrontend({
          type: "ari_call_status_update",
          payload: {
            status: "ended",
            callId: callId,
            callerId: call.channel?.caller?.number || "Unknown",
            reason: reason
          }
        });
        serviceInstance.currentPrimaryCallId = null;
        call.callLogger.info(`Cleared as current primary call.`);
      } else if (callId) {
         serviceInstance.sendEventToFrontend({
          type: "ari_call_status_update",
          payload: {
            status: "ended",
            callId: callId,
            callerId: call.channel?.caller?.number || "Unknown",
            reason: `secondary_call_cleanup: ${reason}` // Asumiendo que podría haber llamadas no primarias
          }
        });
      }

      // Limpiar listeners de eventos de playback
      if (call.playbackFailedHandler && serviceInstance.client) {
        serviceInstance.client.removeListener('PlaybackFailed' as any, call.playbackFailedHandler);
        call.playbackFailedHandler = null;
      }
      if (call.waitingPlaybackFailedHandler && serviceInstance.client) {
        serviceInstance.client.removeListener('PlaybackFailed' as any, call.waitingPlaybackFailedHandler);
        call.waitingPlaybackFailedHandler = null;
      }

      _clearCallTimers(call); // Limpiar todos los temporizadores

      if (call.googleSpeechService) {
        call.googleSpeechService.stopTranscriptionStream();
      }

      if (call.openAIStreamingActive || call.isOpenAIStreamEnding) {
        call.callLogger.info(`Stopping OpenAI session due to cleanup.`);
        try {
          sessionManager.stopOpenAISession(callId, `cleanup_${reason}`);
        } catch (e:any) { call.callLogger.error(`Error stopping OpenAI session during cleanup: ${e.message}`); }
      }
      call.openAIStreamingActive = false;
      call.isOpenAIStreamEnding = true; // Marcar que el stream está terminando o ha terminado.

      // Limpiar archivos de chunks TTS transmitidos
      if (call.streamedTtsChunkFiles && call.streamedTtsChunkFiles.length > 0) {
        call.callLogger.info(`Cleaning up ${call.streamedTtsChunkFiles.length} streamed TTS chunk files.`);
        for (const filePath of call.streamedTtsChunkFiles) {
          fs.unlink(filePath, (err) => {
            if (err) {
              call.callLogger.warn(`Failed to delete streamed TTS chunk file ${filePath}: ${err.message}`);
            } else {
              call.callLogger.debug(`Deleted streamed TTS chunk file: ${filePath}`);
            }
          });
        }
        call.streamedTtsChunkFiles = [];
      }

      // Llamar a cleanupCallResources que maneja los recursos de Asterisk
      await cleanupCallResources(serviceInstance, callId, hangupMainChannel, false, call.callLogger);

      call.callLogger.info(`Full cleanup COMPLETED for call ${callId}.`);
      serviceInstance.sendEventToFrontend({
        type: 'call_cleanup_completed',
        callId: callId,
        timestamp: new Date().toISOString(),
        source: 'ARI_CLEANUP',
        payload: { reason: reason },
        logLevel: 'INFO'
      });

    } else {
      // Usar el logger general de serviceInstance si call no existe
      serviceInstance.logger.warn(`_fullCleanup called for non-existent callId: ${callId}`);
    }
}


// Limpia los recursos de Asterisk (canales, puentes, servidor RTP).
export async function cleanupCallResources(
    serviceInstance: AriClientService,
    channelId: string,
    hangupChannel: boolean = false,
    isAriClosing: boolean = false, // Indica si la limpieza es por cierre de conexión ARI
    loggerInstance?: LoggerInstance // Pasar el logger específico de la llamada si está disponible
): Promise<void> {
    const call = serviceInstance.activeCalls.get(channelId);
    // Usar el logger de la llamada si existe, o el logger general de serviceInstance, o el loggerInstance pasado.
    const resolvedLogger = call?.callLogger || loggerInstance || serviceInstance.logger.child({ callId: channelId, context: 'cleanupCallResources' }, undefined, serviceInstance);

    resolvedLogger.info(`Starting cleanupCallResources for channel ${channelId}. Hangup: ${hangupChannel}, AriClosing: ${isAriClosing}`);

    if (call?.rtpServer) {
      resolvedLogger.info(`Stopping RTP server for call ${channelId}.`);
      try { await call.rtpServer.stop(); }
      catch (e:any) { resolvedLogger.error(`Error stopping RTP server for ${channelId}: ${e.message}`); }
      call.rtpServer = undefined;
    }

    // Solo intentar colgar canales si ARI no se está cerrando completamente
    // (ya que Asterisk podría manejarlos o ya estarían caídos)
    const channelsToHangup: (Ari.Channel | undefined)[] = [];
    if (call?.snoopChannel) {
      resolvedLogger.info(`Preparing to cleanup snoopChannel ${call.snoopChannel.id}.`);
      if (!isAriClosing) { channelsToHangup.push(call.snoopChannel); }
      serviceInstance.appOwnedChannelIds.delete(call.snoopChannel.id);
      call.snoopChannel = undefined;
    }
    if (call?.externalMediaChannel) {
      resolvedLogger.info(`Preparing to cleanup externalMediaChannel ${call.externalMediaChannel.id}.`);
      if (!isAriClosing) { channelsToHangup.push(call.externalMediaChannel); }
      serviceInstance.appOwnedChannelIds.delete(call.externalMediaChannel.id);
      call.externalMediaChannel = undefined;
    }

    if (!isAriClosing) {
        for (const ch of channelsToHangup) {
          if (ch && ch.id) { // Verificar ch.id
            try {
              resolvedLogger.info(`Attempting to hangup app-owned channel ${ch.id}.`);
              // Verificar si serviceInstance.client existe
              if (serviceInstance.client) {
                await serviceInstance.client.channels.hangup({ channelId: ch.id });
                resolvedLogger.info(`Successfully hung up app-owned channel ${ch.id}.`);
              } else {
                resolvedLogger.warn(`ARI client not available, cannot hangup channel ${ch.id}`);
              }
            } catch (e:any) { resolvedLogger.warn(`Error hanging up app-owned channel ${ch.id}: ${e.message} (might be already hung up).`); }
          }
        }
    }


    if (call?.snoopBridge) {
      resolvedLogger.info(`Destroying snoopBridge ${call.snoopBridge.id}.`);
      try {
        if (serviceInstance.client) {
          await serviceInstance.client.bridges.destroy({ bridgeId: call.snoopBridge.id });
        } else {
          resolvedLogger.warn(`ARI client not available, cannot destroy snoopBridge ${call.snoopBridge.id}`);
        }
      }
      catch (e:any) { resolvedLogger.error(`Error destroying snoopBridge ${call.snoopBridge.id}: ${e.message}`); }
      call.snoopBridge = undefined;
    }
    if (call?.userBridge) {
      resolvedLogger.info(`Destroying userBridge ${call.userBridge.id}.`);
      try {
        if (serviceInstance.client) {
          await serviceInstance.client.bridges.destroy({ bridgeId: call.userBridge.id });
        } else {
          resolvedLogger.warn(`ARI client not available, cannot destroy userBridge ${call.userBridge.id}`);
        }
      }
      catch (e:any) { resolvedLogger.error(`Error destroying userBridge ${call.userBridge.id}: ${e.message}`); }
      call.userBridge = undefined;
    }

    // Colgar el canal principal de la llamada si se especifica y ARI no se está cerrando
    if (hangupChannel && call?.channel && !isAriClosing) {
      try {
        resolvedLogger.info(`Attempting to hangup main channel ${call.channel.id}.`);
        if (serviceInstance.client) {
          await call.channel.continueInDialplan();
          resolvedLogger.info(`Main channel ${call.channel.id} will continue in dialplan.`);
        } else {
          resolvedLogger.warn(`ARI client not available, cannot continue in dialplan for main channel ${call.channel.id}`);
        }
      } catch (e: any) {
        resolvedLogger.warn(`Error continuing in dialplan for main channel ${call.channel.id}: ${e.message} (might be already hung up or StasisEnd occurred).`);
      }
    }

    // Eliminar la llamada del mapa de llamadas activas y notificar.
    // Esto debe hacerse después de que todos los recursos hayan sido liberados.
    if (serviceInstance.activeCalls.has(channelId)) { // Verificar antes de eliminar
        serviceInstance.activeCalls.delete(channelId);
        serviceInstance.notifyActiveCallsChanged(); // Notificar al frontend/UI
        sessionManager.handleAriCallEnd(channelId); // Notificar a sessionManager
        resolvedLogger.info(`Call ${channelId} resources fully cleaned up and removed from active sessions.`);
    } else if (!isAriClosing) { // No es un warning si ARI se está cerrando, ya que la llamada podría haber sido eliminada por otro cleanup.
        resolvedLogger.debug(`cleanupCallResources: Call object for channelId ${channelId} was already removed or not found during final step of cleanup.`);
    }
}

// Ari.Channel se usa en los tipos de channelsToHangup, Ari ya está importado arriba.
