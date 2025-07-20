// Este archivo contendrá la clase principal AriClientService y la lógica de inicialización.
// Delegará gran parte de su funcionalidad a los módulos importados.

import Ari from 'ari-client';
import dotenv from 'dotenv';
import { RtpServer } from './rtp-server'; // Asumiendo que rtp-server.ts existe o se crea
import * as sessionManager from './sessionManager';
import {
  AriClientInterface,
  CallSpecificConfig,
  AppRecognitionConfig,
  DtmfConfig,
  LoggerInstance,
  OpenAIRealtimeAPIConfig
} from './types';
import { sendGenericEventToFrontend } from './server'; // Para notificaciones al frontend
import { moduleLogger as baseModuleLogger } from './ari-logger'; // Logger base
import {
    ASTERISK_ARI_URL,
    ASTERISK_ARI_USERNAME,
    ASTERISK_ARI_PASSWORD,
    ASTERISK_ARI_APP_NAME,
    OPENAI_API_KEY,
    // getCallSpecificConfig // No se usa directamente aquí, sino en onStasisStart
} from './ari-config';
import { CallResources, ActiveCallInfo } from './ari-call-resources';

// Importar manejadores de eventos y acciones de los nuevos módulos
import {
    onStasisStart,
    _onDtmfReceived,
    _onChannelTalkingStarted,
    _onChannelTalkingFinished,
    _handlePlaybackFinished, // Este es interno, pero la clase lo llama
    _onOpenAISpeechStarted,
    _onOpenAIInterimResult,
    _onOpenAIFinalResult,
    _onOpenAIAudioChunk,
    _onOpenAIAudioStreamEnd,
    _onOpenAIError,
    _onOpenAISessionEnded,
    onAriError,
    onAriClose,
    onAppOwnedChannelStasisEnd, // Añadido para cubrir todos los eventos
    onStasisEnd // Añadido para cubrir todos los eventos
} from './ari-events';

import {
    playbackAudio,
    endCall,
    // _activateOpenAIStreaming, // Estos son llamados por otros handlers, no directamente por la clase como API pública
    // _stopAllPlaybacks,
    // _finalizeDtmfInput,
    // _playTTSToCaller
} from './ari-actions';

import { _fullCleanup } from './ari-cleanup';

dotenv.config(); // Asegurar que dotenv se cargue

if (!OPENAI_API_KEY) {
    // Usar un console.error aquí porque el logger principal puede no estar completamente inicializado
    console.error("FATAL: OPENAI_API_KEY environment variable is not set in ari-service.ts.");
    // throw new Error("OPENAI_API_KEY is not set. Server cannot start."); // Lanzar error detiene el proceso
}

export class AriClientService implements AriClientInterface {
  public client: Ari.Client | null = null;
  public activeCalls = new Map<string, CallResources>();
  public appOwnedChannelIds = new Set<string>(); // Canales creados por la app (media, snoop)
  public logger: LoggerInstance;
  public currentPrimaryCallId: string | null = null; // Para rastrear la llamada principal (si aplica)
  private onActiveCallsChangedCallback: ((activeCalls: ActiveCallInfo[]) => void) | null = null;

  constructor() {
    // Crear el logger principal para este servicio, pasándole `this` para que pueda acceder a los recursos de llamada.
    this.logger = baseModuleLogger.child({ service: 'AriClientService' }, undefined, this);
    if (!OPENAI_API_KEY) { // Comprobación redundante, pero segura
        this.logger.error("FATAL: AriClientService constructor - OPENAI_API_KEY is not set.");
    }
    // La carga de baseConfig ahora está en ari-config.ts
    // if (!baseConfig) { throw new Error("Base configuration was not loaded."); }
  }

  // --- Métodos de gestión de callbacks y estado de llamadas (se mantienen en la clase) ---
  public setActiveCallsChangedCallback(callback: (activeCalls: ActiveCallInfo[]) => void) {
    this.onActiveCallsChangedCallback = callback;
  }

  public getFormattedActiveCalls(): ActiveCallInfo[] {
    const formattedCalls: ActiveCallInfo[] = [];
    this.activeCalls.forEach((call, callId) => {
      let status = 'active';
      if (call.isCleanupCalled) {
        status = 'ended';
      } else if (call.channel.state !== 'UP') {
        status = call.channel.state.toLowerCase();
      }
      let startTimeISO: string | undefined = undefined;
      try {
        if (call.channel && typeof call.channel.creationtime === 'string') {
          const dateObj = new Date(call.channel.creationtime);
          if (!isNaN(dateObj.getTime())) {
            startTimeISO = dateObj.toISOString();
          } else {
            startTimeISO = call.channel.creationtime;
          }
        } else if (call.channel && call.channel.creationtime) {
           startTimeISO = String(call.channel.creationtime);
        }
      } catch (e: any) {
        call.callLogger.warn(`Error processing creationtime for call ${callId}: ${e.message}`);
      }
      formattedCalls.push({
        callId: callId,
        callerId: call.channel?.caller?.number || call.channel?.name || 'Unknown',
        startTime: startTimeISO,
        status: status
      });
    });
    return formattedCalls;
  }

  public notifyActiveCallsChanged() {
    if (this.onActiveCallsChangedCallback) {
      this.onActiveCallsChangedCallback(this.getFormattedActiveCalls());
    }
  }

  public getActiveCallResource(callId: string): CallResources | undefined {
    return this.activeCalls.get(callId);
  }

  /**
   * Sends a standardized event object to the frontend via the central sendGenericEventToFrontend function.
   * Ensures that if a primary callId exists and the event payload doesn't specify one, it gets added.
   * Standard event format:
   * {
   *   type: "event_type_string",
   *   callId: "string | null",
   *   timestamp: "ISO8601_string",
   *   source: "SERVER_COMPONENT_STRING",
   *   payload: { ...event-specific_data... },
   *   logLevel: "INFO | WARN | ERROR | DEBUG | TRACE" (optional)
   * }
   */
  public sendEventToFrontend(event: any) {
    const eventToSend = { ...event };
    if (event.payload && !event.payload.callId && this.currentPrimaryCallId) {
      eventToSend.payload.callId = this.currentPrimaryCallId;
    }
    // Ensure a timestamp if not already present (though ideally it's set at point of origin)
    if (!eventToSend.timestamp) {
      eventToSend.timestamp = new Date().toISOString();
    }
    sendGenericEventToFrontend(eventToSend);
  }

  public getCurrentPrimaryCallId(): string | null { return this.currentPrimaryCallId; }

  public getSpecificCallConfiguration(callId: string): CallSpecificConfig | null {
    const call = this.activeCalls.get(callId);
    if (call && call.config) {
      return JSON.parse(JSON.stringify(call.config));
    }
    this.logger.warn(`getSpecificCallConfiguration: No active call or config found for callId ${callId}`);
    return null;
  }

  public async updateActiveCallConfig(
    callId: string,
    newConfigData: Partial<OpenAIRealtimeAPIConfig & AppRecognitionConfig & DtmfConfig & { tools?: any[] }>
  ) {
    const call = this.activeCalls.get(callId);
    if (!call || call.isCleanupCalled) {
      this.logger.warn(`updateActiveCallConfig: Call ${callId} not active or cleanup called.`);
      return;
    }
    call.callLogger.info(`Updating active call config for ${callId} with new data:`, newConfigData);
    let configChanged = false;

    // OpenAI Config
    if (newConfigData.instructions !== undefined && call.config.openAIRealtimeAPI.instructions !== newConfigData.instructions) {
      call.config.openAIRealtimeAPI.instructions = newConfigData.instructions; configChanged = true;
    }
    if (newConfigData.ttsVoice !== undefined && call.config.openAIRealtimeAPI.ttsVoice !== newConfigData.ttsVoice) {
      call.config.openAIRealtimeAPI.ttsVoice = newConfigData.ttsVoice; configChanged = true;
    }
    if (newConfigData.model !== undefined && call.config.openAIRealtimeAPI.model !== newConfigData.model) {
      call.config.openAIRealtimeAPI.model = newConfigData.model; configChanged = true;
    }

    // AppRecognitionConfig
    const arc = call.config.appConfig.appRecognitionConfig;
    if (newConfigData.recognitionActivationMode !== undefined && arc.recognitionActivationMode !== newConfigData.recognitionActivationMode) {
      arc.recognitionActivationMode = newConfigData.recognitionActivationMode; configChanged = true;
    }
    // ... (otros campos de AppRecognitionConfig)
    if (newConfigData.bargeInDelaySeconds !== undefined && arc.bargeInDelaySeconds !== newConfigData.bargeInDelaySeconds) {
      arc.bargeInDelaySeconds = newConfigData.bargeInDelaySeconds; configChanged = true;
    }
    if (newConfigData.vadRecogActivation !== undefined && arc.vadRecogActivation !== newConfigData.vadRecogActivation) {
      arc.vadRecogActivation = newConfigData.vadRecogActivation; configChanged = true;
    }
     if (newConfigData.vadInitialSilenceDelaySeconds !== undefined && arc.vadInitialSilenceDelaySeconds !== newConfigData.vadInitialSilenceDelaySeconds) {
      arc.vadInitialSilenceDelaySeconds = newConfigData.vadInitialSilenceDelaySeconds; configChanged = true;
    }
    if (newConfigData.noSpeechBeginTimeoutSeconds !== undefined && arc.noSpeechBeginTimeoutSeconds !== newConfigData.noSpeechBeginTimeoutSeconds) {
        arc.noSpeechBeginTimeoutSeconds = newConfigData.noSpeechBeginTimeoutSeconds; configChanged = true;
    }
    if (newConfigData.speechEndSilenceTimeoutSeconds !== undefined && arc.speechEndSilenceTimeoutSeconds !== newConfigData.speechEndSilenceTimeoutSeconds) {
        arc.speechEndSilenceTimeoutSeconds = newConfigData.speechEndSilenceTimeoutSeconds; configChanged = true;
    }
    if (newConfigData.maxRecognitionDurationSeconds !== undefined && arc.maxRecognitionDurationSeconds !== newConfigData.maxRecognitionDurationSeconds) {
        arc.maxRecognitionDurationSeconds = newConfigData.maxRecognitionDurationSeconds; configChanged = true;
    }
    if (newConfigData.vadSilenceThresholdMs !== undefined && arc.vadSilenceThresholdMs !== newConfigData.vadSilenceThresholdMs) {
        arc.vadSilenceThresholdMs = newConfigData.vadSilenceThresholdMs; arc.vadConfig.vadSilenceThresholdMs = newConfigData.vadSilenceThresholdMs; configChanged = true;
    }
    if (newConfigData.vadTalkThreshold !== undefined && arc.vadTalkThreshold !== newConfigData.vadTalkThreshold) {
        arc.vadTalkThreshold = newConfigData.vadTalkThreshold; configChanged = true;
    }
    if (newConfigData.vadMaxWaitAfterPromptSeconds !== undefined && arc.vadMaxWaitAfterPromptSeconds !== newConfigData.vadMaxWaitAfterPromptSeconds) {
        arc.vadMaxWaitAfterPromptSeconds = newConfigData.vadMaxWaitAfterPromptSeconds; configChanged = true;
    }


    // DtmfConfig
    const dtmfConf = call.config.appConfig.dtmfConfig;
    if (newConfigData.enableDtmfRecognition !== undefined && dtmfConf.enableDtmfRecognition !== newConfigData.enableDtmfRecognition) {
      dtmfConf.enableDtmfRecognition = newConfigData.enableDtmfRecognition; configChanged = true;
    }
    // ... (otros campos de DtmfConfig)
     if (newConfigData.dtmfInterDigitTimeoutSeconds !== undefined && dtmfConf.dtmfInterDigitTimeoutSeconds !== newConfigData.dtmfInterDigitTimeoutSeconds) {
      dtmfConf.dtmfInterDigitTimeoutSeconds = newConfigData.dtmfInterDigitTimeoutSeconds; configChanged = true;
    }
    if (newConfigData.dtmfFinalTimeoutSeconds !== undefined && dtmfConf.dtmfFinalTimeoutSeconds !== newConfigData.dtmfFinalTimeoutSeconds) {
      dtmfConf.dtmfFinalTimeoutSeconds = newConfigData.dtmfFinalTimeoutSeconds; configChanged = true;
    }


    // Tools
    if (newConfigData.tools !== undefined) {
      if (JSON.stringify(call.config.openAIRealtimeAPI.tools) !== JSON.stringify(newConfigData.tools)) {
        call.config.openAIRealtimeAPI.tools = newConfigData.tools; configChanged = true;
      }
    }

    if (configChanged) {
      call.callLogger.info(`Configuration for call ${callId} has been updated locally.`);
      // ... (logging de la nueva config)
      call.callLogger.info(`OpenAI Cfg -> Model: "${call.config.openAIRealtimeAPI.model}", Instr: "${call.config.openAIRealtimeAPI.instructions}", Voice: "${call.config.openAIRealtimeAPI.ttsVoice}"`);
      call.callLogger.info(`Recog Cfg -> Mode: ${arc.recognitionActivationMode}, BargeInDelay: ${arc.bargeInDelaySeconds}, VAD InitialDelay: ${arc.vadInitialSilenceDelaySeconds}`);
      call.callLogger.info(`DTMF Cfg -> Enabled: ${dtmfConf.enableDtmfRecognition}, InterDigit: ${dtmfConf.dtmfInterDigitTimeoutSeconds}`);


      try {
        const sessionManagerModule = await import('./sessionManager'); // Re-importar si es necesario para asegurar la última versión
        const openAIConfigUpdatePayload: Partial<OpenAIRealtimeAPIConfig> = {
            instructions: call.config.openAIRealtimeAPI.instructions,
            ttsVoice: call.config.openAIRealtimeAPI.ttsVoice,
            model: call.config.openAIRealtimeAPI.model,
            tools: call.config.openAIRealtimeAPI.tools,
        };
        sessionManagerModule.sendSessionUpdateToOpenAI(callId, openAIConfigUpdatePayload);
        call.callLogger.info(`Sent session.update to OpenAI for call ${callId} after config change.`);
      } catch (e: any) {
        call.callLogger.error(`Error trying to send session.update to OpenAI for call ${callId}: ${e.message}`);
      }
    } else {
      call.callLogger.info(`No effective changes applied to call ${callId} configuration from UI.`);
    }
  }


  // --- Conexión y manejo de eventos ARI (delegados a ari-events.ts) ---
  public async connect(): Promise<void> {
    try {
      this.client = await Ari.connect(ASTERISK_ARI_URL, ASTERISK_ARI_USERNAME, ASTERISK_ARI_PASSWORD);
      this.logger.info('Successfully connected to Asterisk ARI.');

      // Bind event handlers, pasando `this` (AriClientService instance) a las funciones importadas de ari-events.ts
      this.client.on('StasisStart', (event, channel) => onStasisStart(this, event, channel));
      this.client.on('ChannelDtmfReceived', (event, channel) => _onDtmfReceived(this, event, channel));
      this.client.on('ChannelTalkingStarted', (event, channel) => _onChannelTalkingStarted(this, event, channel));
      this.client.on('ChannelTalkingFinished', (event, channel) => _onChannelTalkingFinished(this, event, channel));

      this.client.on('StasisEnd', (event, channel) => {
        if (this.appOwnedChannelIds.has(channel.id)) {
            onAppOwnedChannelStasisEnd(this, event, channel);
        } else if (this.activeCalls.has(channel.id)) {
            onStasisEnd(this, event, channel);
        } else {
            this.logger.debug(`StasisEnd for unmanaged/unknown channel ${channel.id} (${channel.name}). Ignoring.`);
        }
      });

      this.client.on('error' as any, (err: any) => onAriError(this, err));
      this.client.on('close' as any, () => onAriClose(this));

      await this.client.start(ASTERISK_ARI_APP_NAME);
      this.logger.info(`ARI Stasis application '${ASTERISK_ARI_APP_NAME}' started and listening for calls.`);
      this.sendEventToFrontend({
        type: 'ari_connection_status',
        callId: null,
        timestamp: new Date().toISOString(),
        source: 'ARI_SERVICE',
        payload: { status: 'connected_and_app_started', appName: ASTERISK_ARI_APP_NAME },
        logLevel: 'INFO'
      });
    } catch (err: any) {
      this.logger.error('FATAL: Failed to connect/start Stasis app:', err instanceof Error ? err.message : String(err), err instanceof Error ? err.stack : '');
      // Send event for connection failure if it happens here before client error handlers are attached
      // This might be redundant if client.on('error') always catches it.
      sendGenericEventToFrontend({ // Use sendGenericEventToFrontend as 'this.sendEventToFrontend' might not be fully set up
        type: 'ari_connection_status',
        callId: null,
        timestamp: new Date().toISOString(),
        source: 'ARI_SERVICE',
        payload: { status: 'failed_to_connect_or_start_app', error: err.message },
        logLevel: 'FATAL' // Or ERROR
      });
      throw err;
    }
  }

  // --- Métodos de callback de OpenAI ---
  // Estos son llamados por sessionManager. SessionManager tiene una referencia a AriClientService (this).
  // Por lo tanto, estos métodos en AriClientService llaman a las funciones correspondientes en ari-events.ts, pasándoles `this`.
  public _onOpenAISpeechStarted(callId: string): void { _onOpenAISpeechStarted(this, callId); }
  public _onOpenAIInterimResult(callId: string, transcript: string): void { _onOpenAIInterimResult(this, callId, transcript); }
  public _onOpenAIFinalResult(callId: string, transcript: string): void { _onOpenAIFinalResult(this, callId, transcript); }
  public async _onOpenAIAudioChunk(callId: string, audioChunkBase64: string, isLastChunk_deprecated: boolean): Promise<void> {
    await _onOpenAIAudioChunk(this, callId, audioChunkBase64, isLastChunk_deprecated);
  }
  public async _onOpenAIAudioStreamEnd(callId: string): Promise<void> { await _onOpenAIAudioStreamEnd(this, callId); }
  public _onOpenAIError(callId: string, error: any): void { _onOpenAIError(this, callId, error); }
  public _onOpenAISessionEnded(callId: string, reason: string): void { _onOpenAISessionEnded(this, callId, reason); }

  // --- Métodos de acción públicos ---
  // Estos métodos llaman a las funciones correspondientes en ari-actions.ts, pasándoles `this`.
  public async playbackAudio(channelId: string, audioPayloadB64?: string | null, mediaUri?: string | null): Promise<void> {
    await playbackAudio(this, channelId, audioPayloadB64, mediaUri);
  }
  public async endCall(channelId: string): Promise<void> { await endCall(this, channelId); }

  // --- Métodos internos de manejo de lógica / limpieza ---
  // Estos son llamados internamente por otros métodos o manejadores de eventos dentro de esta clase o los módulos.
  // Delegan a funciones en ari-events.ts o ari-cleanup.ts, pasándoles `this`.
  public _handlePlaybackFinished(callId: string, reason: string): void {
    _handlePlaybackFinished(this, callId, reason);
  }

  public async _fullCleanup(callId: string, hangupMainChannel: boolean, reason: string): Promise<void> {
    await _fullCleanup(this, callId, hangupMainChannel, reason);
  }

  public async shutdownAllCalls(): Promise<void> {
    this.logger.info("Shutting down all active calls...");
    const callIds = Array.from(this.activeCalls.keys());
    for (const callId of callIds) {
      await this._fullCleanup(callId, true, "SERVER_SHUTDOWN");
    }
    if (this.client) {
      await this.client.stop();
    }
  }
}

// --- Inicialización del servicio ---
let ariClientServiceInstance: AriClientService | null = null;

export async function initializeAriClient(): Promise<AriClientService> {
  if (!OPENAI_API_KEY) {
      // Usar console.error porque el logger puede no estar listo o la instancia no creada.
      console.error("FATAL: Cannot initialize AriClientService - OPENAI_API_KEY is not set in initializeAriClient.");
      throw new Error("OPENAI_API_KEY is not set. Server cannot start.");
  }
  if (!ariClientServiceInstance) {
    ariClientServiceInstance = new AriClientService();
    await ariClientServiceInstance.connect(); // connect ahora es un método de instancia
  }
  return ariClientServiceInstance;
}

// Exportar la instancia para uso global si es necesario (como en el original)
export { ariClientServiceInstance };
