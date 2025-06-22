import Ari, { Channel, Bridge, Playback, PlaybackFinished, ChannelTalkingStarted, ChannelTalkingFinished, ChannelDtmfReceived } from 'ari-client';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { RtpServer } from './rtp-server';
import * as sessionManager from './sessionManager';
import {
  AriClientInterface,
  CallSpecificConfig,
  RuntimeConfig,
  AppRecognitionConfig,
  DtmfConfig,
  LoggerInstance,
  OpenAIRealtimeAPIConfig
} from './types';
import { sendGenericEventToFrontend } from './server';

dotenv.config();

let baseConfig: RuntimeConfig;
let currentCallSpecificConfig: CallSpecificConfig;

try {
  const configFilePath = process.env.CONFIG_FILE_PATH || path.join(__dirname, '../config/default.json');
  const rawConfig = fs.readFileSync(configFilePath, 'utf-8');
  baseConfig = JSON.parse(rawConfig) as RuntimeConfig;
} catch (e: unknown) {
  console.error(`Failed to load base config from ${process.env.CONFIG_FILE_PATH || path.join(__dirname, '../config/default.json')}, using hardcoded fallbacks: ${e instanceof Error ? e.message : String(e)}`);
  baseConfig = {
    appConfig: {
      appRecognitionConfig: {
        recognitionActivationMode: "VAD", noSpeechBeginTimeoutSeconds: 3, speechCompleteTimeoutSeconds: 5,
        vadConfig: { vadSilenceThresholdMs: 250, vadRecognitionActivationMs: 40 },
        maxRecognitionDurationSeconds: 30, greetingAudioPath: 'sound:hello-world', bargeInDelaySeconds: 0.5,
        vadRecogActivation: 'afterPrompt', vadInitialSilenceDelaySeconds: 0, vadActivationDelaySeconds: 0, vadMaxWaitAfterPromptSeconds: 5,
      },
      dtmfConfig: { dtmfEnabled: true, dtmfInterdigitTimeoutSeconds: 2, dtmfMaxDigits: 16, dtmfTerminatorDigit: "#", dtmfFinalTimeoutSeconds: 3 },
      bargeInConfig: { bargeInModeEnabled: true, bargeInDelaySeconds: 0.5, noSpeechBargeInTimeoutSeconds: 5 },
    },
    openAIRealtimeAPI: { model: "gpt-4o-mini-realtime-preview-2024-12-17", inputAudioFormat: "g711_ulaw", inputAudioSampleRate: 8000, outputAudioFormat: "g711_ulaw", outputAudioSampleRate: 8000, responseModalities: ["audio", "text"], instructions: "Eres un asistente de IA amigable y servicial. Responde de manera concisa." },
    logging: { level: "info" },
  };
}
currentCallSpecificConfig = JSON.parse(JSON.stringify(baseConfig));


const moduleLogger: LoggerInstance = (() => {
  const loggerInstance: any = {};
  const levels: { [key: string]: number } = { silly: 0, debug: 1, info: 2, warn: 3, error: 4 };
  const getEffectiveLogLevel = (configForLevel?: CallSpecificConfig | RuntimeConfig) => {
    const conf = configForLevel || currentCallSpecificConfig || baseConfig;
    return process.env.LOG_LEVEL?.toLowerCase() || conf?.logging?.level || 'info';
  };
  loggerInstance.isLevelEnabled = (level: string, configOverride?: CallSpecificConfig | RuntimeConfig): boolean => {
    const effectiveLogLevel = getEffectiveLogLevel(configOverride);
    const configuredLevelNum = levels[effectiveLogLevel] ?? levels.info;
    return levels[level] >= configuredLevelNum;
  };
  (['info', 'error', 'warn', 'debug', 'silly'] as const).forEach(levelKey => {
    loggerInstance[levelKey] = (...args: any[]) => {
      if (loggerInstance.isLevelEnabled(levelKey)) {
        const logFunction = console[levelKey === 'silly' ? 'log' : levelKey] || console.log;
        logFunction(...args);
      }
    };
  });
  loggerInstance.child = (bindings: object, callSpecificLogLevel?: string): LoggerInstance => {
    const childLogger: any = {};
    childLogger.isLevelEnabled = (level: string): boolean => {
      const levelsMap: { [key: string]: number } = { silly: 0, debug: 1, info: 2, warn: 3, error: 4 };
      const effectiveCallLogLevel = callSpecificLogLevel || getEffectiveLogLevel();
      const configuredLevelNum = levelsMap[effectiveCallLogLevel] ?? levelsMap.info;
      return levelsMap[level] >= configuredLevelNum;
    };
    (['info', 'error', 'warn', 'debug', 'silly'] as const).forEach(levelKey => {
      childLogger[levelKey] = (...args: any[]) => {
        if (childLogger.isLevelEnabled(levelKey)) {
          const prefix = Object.entries(bindings).map(([k,v]) => `${k}=${v}`).join(' ');
          const originalLogFn = console[levelKey === 'silly' ? 'log' : levelKey] || console.log;
          if (typeof args[0] === 'string') {
            originalLogFn(`[${prefix}] ${args[0]}`, ...args.slice(1));
          } else {
            originalLogFn(`[${prefix}]`, ...args);
          }
        }
      };
    });
    childLogger.child = (newBindings: object, newCallSpecificLogLevel?: string) => {
      return loggerInstance.child({...bindings, ...newBindings}, newCallSpecificLogLevel || callSpecificLogLevel);
    };
    return childLogger as LoggerInstance;
  };
  return loggerInstance as LoggerInstance;
})();

function getVar(logger: any, channel: Channel | undefined, envVarName: string, defaultValue?: string, channelVarName?: string): string | undefined {
  const astVarName = channelVarName || `APP_${envVarName}`;
  let value: string | undefined;
  if (value === undefined) { value = process.env[envVarName]; }
  if (value === undefined) { value = defaultValue; }
  return value;
}
function getVarAsInt(logger: any, channel: Channel | undefined, envVarName: string, defaultValue?: number, channelVarName?: string): number | undefined {
  const value = getVar(logger, channel, envVarName, defaultValue?.toString(), channelVarName);
  if (value === undefined) return undefined;
  const intValue = parseInt(value, 10);
  if (isNaN(intValue)) { logger.warn(`Invalid int for ${envVarName}: ${value}, using default ${defaultValue}`); return defaultValue; }
  return intValue;
}
function getVarAsFloat(logger: any, channel: Channel | undefined, envVarName: string, defaultValue?: number, channelVarName?: string): number | undefined {
  const value = getVar(logger, channel, envVarName, defaultValue?.toString(), channelVarName);
  if (value === undefined) return undefined;
  const floatValue = parseFloat(value);
  if (isNaN(floatValue)) { logger.warn(`Invalid float for ${envVarName}: ${value}, using default ${defaultValue}`); return defaultValue; }
  return floatValue;
}
function getVarAsBoolean(logger: any, channel: Channel | undefined, envVarName: string, defaultValue?: boolean, channelVarName?: string): boolean | undefined {
  const value = getVar(logger, channel, envVarName, defaultValue?.toString(), channelVarName);
  if (value === undefined) return undefined;
  if (typeof value === 'string') { return value.toLowerCase() === 'true' || value === '1'; }
  return defaultValue;
}

function getCallSpecificConfig(logger: LoggerInstance, channel?: Channel): CallSpecificConfig {
  currentCallSpecificConfig = JSON.parse(JSON.stringify(baseConfig));
  currentCallSpecificConfig.logging.level = getVar(logger, channel, 'LOG_LEVEL', baseConfig.logging.level) as any || baseConfig.logging.level;
  const arc = currentCallSpecificConfig.appConfig.appRecognitionConfig = currentCallSpecificConfig.appConfig.appRecognitionConfig || {} as AppRecognitionConfig;
  const initialGreetingEnv = getVar(logger, channel, 'INITIAL_GREETING_AUDIO_PATH', undefined);
  const greetingEnv = getVar(logger, channel, 'GREETING_AUDIO_PATH', undefined);
  if (initialGreetingEnv !== undefined) { arc.greetingAudioPath = initialGreetingEnv; }
  else if (greetingEnv !== undefined) { arc.greetingAudioPath = greetingEnv; }
  else if (baseConfig.appConfig.appRecognitionConfig.greetingAudioPath !== undefined) { arc.greetingAudioPath = baseConfig.appConfig.appRecognitionConfig.greetingAudioPath; }
  else { arc.greetingAudioPath = 'sound:hello-world'; }
  arc.maxRecognitionDurationSeconds = getVarAsInt(logger, channel, 'MAX_RECOGNITION_DURATION_SECONDS', arc.maxRecognitionDurationSeconds) || 30;
  arc.noSpeechBeginTimeoutSeconds = getVarAsInt(logger, channel, 'NO_SPEECH_BEGIN_TIMEOUT_SECONDS', arc.noSpeechBeginTimeoutSeconds) ?? 3;
  arc.speechCompleteTimeoutSeconds = getVarAsInt(logger, channel, 'SPEECH_COMPLETE_TIMEOUT_SECONDS', arc.speechCompleteTimeoutSeconds) ?? 5;
  arc.bargeInDelaySeconds = getVarAsFloat(logger, channel, 'BARGE_IN_DELAY_SECONDS', arc.bargeInDelaySeconds ?? baseConfig.appConfig.bargeInConfig?.bargeInDelaySeconds) ?? 0.5;
  arc.vadRecogActivation = getVar(logger, channel, 'VAD_RECOG_ACTIVATION_MODE', arc.vadRecogActivation) as 'vadMode' | 'afterPrompt' || 'afterPrompt';
  arc.vadInitialSilenceDelaySeconds = getVarAsInt(logger, channel, 'VAD_INITIAL_SILENCE_DELAY_SECONDS', arc.vadInitialSilenceDelaySeconds) ?? 0;
  arc.vadActivationDelaySeconds = getVarAsInt(logger, channel, 'VAD_ACTIVATION_DELAY_SECONDS', arc.vadActivationDelaySeconds) ?? 0;
  arc.vadMaxWaitAfterPromptSeconds = getVarAsInt(logger, channel, 'VAD_MAX_WAIT_AFTER_PROMPT_SECONDS', arc.vadMaxWaitAfterPromptSeconds) ?? 5;
  arc.vadConfig = arc.vadConfig || { vadSilenceThresholdMs: 250, vadRecognitionActivationMs: 40 };
  arc.vadConfig.vadSilenceThresholdMs = getVarAsInt(logger, channel, 'VAD_SILENCE_THRESHOLD_MS', arc.vadConfig.vadSilenceThresholdMs) ?? 250;
  arc.vadConfig.vadRecognitionActivationMs = getVarAsInt(logger, channel, 'VAD_TALK_THRESHOLD_MS', arc.vadConfig.vadRecognitionActivationMs) ?? 40;
  const dtmfConf = currentCallSpecificConfig.appConfig.dtmfConfig = currentCallSpecificConfig.appConfig.dtmfConfig || {} as DtmfConfig;
  dtmfConf.dtmfEnabled = getVarAsBoolean(logger, channel, 'DTMF_ENABLED', dtmfConf.dtmfEnabled) ?? true;
  dtmfConf.dtmfInterdigitTimeoutSeconds = getVarAsInt(logger, channel, 'DTMF_INTERDIGIT_TIMEOUT_SECONDS', dtmfConf.dtmfInterdigitTimeoutSeconds) ?? 2;
  dtmfConf.dtmfMaxDigits = getVarAsInt(logger, channel, 'DTMF_MAX_DIGITS', dtmfConf.dtmfMaxDigits) ?? 16;
  dtmfConf.dtmfTerminatorDigit = getVar(logger, channel, 'DTMF_TERMINATOR_DIGIT', dtmfConf.dtmfTerminatorDigit) ?? "#";
  dtmfConf.dtmfFinalTimeoutSeconds = getVarAsInt(logger, channel, 'DTMF_FINAL_TIMEOUT_SECONDS', dtmfConf.dtmfFinalTimeoutSeconds) ?? 3;
  const oaiConf = currentCallSpecificConfig.openAIRealtimeAPI = currentCallSpecificConfig.openAIRealtimeAPI || {} as OpenAIRealtimeAPIConfig;
  oaiConf.model = getVar(logger, channel, 'OPENAI_REALTIME_MODEL', oaiConf.model, 'APP_OPENAI_REALTIME_MODEL') || "gpt-4o-mini-realtime-preview-2024-12-17";
  oaiConf.language = getVar(logger, channel, 'OPENAI_LANGUAGE', oaiConf.language) ?? "en";
  oaiConf.inputAudioFormat = getVar(logger, channel, 'OPENAI_INPUT_AUDIO_FORMAT', oaiConf.inputAudioFormat) ?? "mulaw_8000hz";
  oaiConf.inputAudioSampleRate = getVarAsInt(logger, channel, 'OPENAI_INPUT_AUDIO_SAMPLE_RATE', oaiConf.inputAudioSampleRate) ?? 8000;
  oaiConf.ttsVoice = getVar(logger, channel, 'APP_OPENAI_TTS_VOICE', oaiConf.ttsVoice) ?? "alloy";
  oaiConf.outputAudioFormat = getVar(logger, channel, 'OPENAI_OUTPUT_AUDIO_FORMAT', oaiConf.outputAudioFormat);
  if (oaiConf.outputAudioFormat === undefined) { oaiConf.outputAudioFormat = baseConfig.openAIRealtimeAPI.outputAudioFormat || "g711_ulaw"; }
  oaiConf.outputAudioSampleRate = getVarAsInt(logger, channel, 'OPENAI_OUTPUT_AUDIO_SAMPLE_RATE', oaiConf.outputAudioSampleRate);
  if (oaiConf.outputAudioFormat === "g711_ulaw" || oaiConf.outputAudioFormat === "mulaw_8000hz") {
    if (!oaiConf.outputAudioSampleRate || oaiConf.outputAudioSampleRate !== 8000) { oaiConf.outputAudioSampleRate = 8000; }
  } else if (oaiConf.outputAudioSampleRate === undefined) { oaiConf.outputAudioSampleRate = baseConfig.openAIRealtimeAPI.outputAudioSampleRate || 24000; }
  oaiConf.instructions = getVar(logger, channel, 'OPENAI_INSTRUCTIONS', oaiConf.instructions, 'APP_OPENAI_INSTRUCTIONS');
  if (oaiConf.instructions === undefined) { oaiConf.instructions = "Eres un asistente de IA amigable y servicial. Responde de manera concisa.";}
  const baseModalities = baseConfig.openAIRealtimeAPI?.responseModalities?.join(',') || 'audio,text';
  const modalitiesStr = getVar(logger, channel, 'OPENAI_RESPONSE_MODALITIES', baseModalities, 'APP_OPENAI_RESPONSE_MODALITIES');
  if (modalitiesStr) {
    const validModalitiesSet = new Set(["audio", "text"]);
    const parsedModalities = modalitiesStr.split(',').map(m => m.trim().toLowerCase()).filter(m => validModalitiesSet.has(m)) as ("audio" | "text")[];
    if (parsedModalities.length > 0) { oaiConf.responseModalities = parsedModalities; }
    else { oaiConf.responseModalities = baseConfig.openAIRealtimeAPI?.responseModalities || ["audio", "text"]; }
  } else { oaiConf.responseModalities = baseConfig.openAIRealtimeAPI?.responseModalities || ["audio", "text"]; }
  if (!oaiConf.responseModalities) { oaiConf.responseModalities = ["audio", "text"]; }
  if (oaiConf.tools === undefined) { oaiConf.tools = []; }
  if (!process.env.OPENAI_API_KEY) { logger.error("CRITICAL: OPENAI_API_KEY is not set."); }
  return currentCallSpecificConfig;
}

const ASTERISK_ARI_URL = process.env.ASTERISK_ARI_URL || 'http://localhost:8088';
const ASTERISK_ARI_USERNAME = process.env.ASTERISK_ARI_USERNAME || 'asterisk';
const ASTERISK_ARI_PASSWORD = process.env.ASTERISK_ARI_PASSWORD || 'asterisk';
const ASTERISK_ARI_APP_NAME = process.env.ASTERISK_ARI_APP_NAME || 'openai-ari-app';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const DEFAULT_RTP_HOST_IP = process.env.RTP_HOST_IP || '127.0.0.1';
const MAX_VAD_BUFFER_PACKETS = 200;

if (!OPENAI_API_KEY) { moduleLogger.error("FATAL: OPENAI_API_KEY environment variable is not set."); }

interface CallResources {
  channel: Channel; config: CallSpecificConfig; callLogger: LoggerInstance; userBridge?: Bridge; snoopBridge?: Bridge;
  rtpServer?: RtpServer; externalMediaChannel?: Channel; snoopChannel?: Channel;
  mainPlayback?: Playback; waitingPlayback?: Playback; postRecognitionWaitingPlayback?: Playback;
  isCleanupCalled: boolean; promptPlaybackStoppedForInterim: boolean; fallbackAttempted: boolean;
  openAIStreamError: any; openAIStreamingActive: boolean; isOpenAIStreamEnding: boolean;
  speechHasBegun: boolean; finalTranscription: string; collectedDtmfDigits: string;
  dtmfModeActive: boolean; speechRecognitionDisabledDueToDtmf: boolean; dtmfInterruptedSpeech: boolean;
  vadSpeechDetected: boolean; vadAudioBuffer: Buffer[]; isVADBufferingActive: boolean;
  isFlushingVADBuffer: boolean; pendingVADBufferFlush: boolean; vadRecognitionTriggeredAfterInitialDelay: boolean;
  vadSpeechActiveDuringDelay: boolean; vadInitialSilenceDelayCompleted: boolean; vadActivationDelayCompleted: boolean;
  bargeInActivationTimer: NodeJS.Timeout | null; noSpeechBeginTimer: NodeJS.Timeout | null;
  initialOpenAIStreamIdleTimer: NodeJS.Timeout | null; speechEndSilenceTimer: NodeJS.Timeout | null;
  maxRecognitionDurationTimer: NodeJS.Timeout | null; dtmfInterDigitTimer: NodeJS.Timeout | null;
  dtmfFinalTimer: NodeJS.Timeout | null; vadMaxWaitAfterPromptTimer: NodeJS.Timeout | null;
  vadActivationDelayTimer: NodeJS.Timeout | null; vadInitialSilenceDelayTimer: NodeJS.Timeout | null;
  playbackFailedHandler?: ((event: any, failedPlayback: Playback) => void) | null;
  waitingPlaybackFailedHandler?: ((event: any, playback: Playback) => void) | null;
  ttsAudioChunks: string[];
  currentTtsResponseId?: string;
}

export class AriClientService implements AriClientInterface {
  private client: Ari.Client | null = null;
  private activeCalls = new Map<string, CallResources>();
  private appOwnedChannelIds = new Set<string>();
  public logger: LoggerInstance = moduleLogger;
  private currentPrimaryCallId: string | null = null;

  constructor() {
    this.logger = moduleLogger.child({ service: 'AriClientService' });
    if (!baseConfig) { throw new Error("Base configuration was not loaded."); }
  }

  private sendEventToFrontend(event: any) {
    // Add callId to all events sent from AriClientService for easier tracking, if not already present
    const eventToSend = { ...event };
    if (event.payload && !event.payload.callId && this.currentPrimaryCallId) {
      // Prefer callId from payload if it exists, otherwise use currentPrimaryCallId
      // This is a bit heuristic; ideally events should be constructed with callId where relevant.
      eventToSend.payload.callId = event.payload.callId || this.currentPrimaryCallId;
    } else if (!event.payload && this.currentPrimaryCallId) {
      // If no payload, but we have a primary callId, create a payload for it.
      // This might not be ideal for all event types.
      // eventToSend.payload = { callId: this.currentPrimaryCallId };
    }
    sendGenericEventToFrontend(eventToSend);
  }

  public getCurrentPrimaryCallId(): string | null { return this.currentPrimaryCallId; }

  public async updateActiveCallConfig(callId: string, newConfigData: { instructions?: string, ttsVoice?: string, tools?: any[] }) {
    const call = this.activeCalls.get(callId);
    if (!call || call.isCleanupCalled) {
      this.logger.warn(`updateActiveCallConfig: Call ${callId} not active or cleanup called.`);
      return;
    }
    call.callLogger.info(`Updating active call config for ${callId} with new data.`);
    let configChanged = false;
    if (newConfigData.instructions && call.config.openAIRealtimeAPI.instructions !== newConfigData.instructions) {
      call.config.openAIRealtimeAPI.instructions = newConfigData.instructions;
      configChanged = true;
      call.callLogger.info(`Instructions updated for call ${callId}.`);
    }
    if (newConfigData.ttsVoice && call.config.openAIRealtimeAPI.ttsVoice !== newConfigData.ttsVoice) {
      call.config.openAIRealtimeAPI.ttsVoice = newConfigData.ttsVoice;
      configChanged = true;
      call.callLogger.info(`TTS Voice updated to "${newConfigData.ttsVoice}" for call ${callId}.`);
    }
    if (newConfigData.tools) {
      if (JSON.stringify(call.config.openAIRealtimeAPI.tools) !== JSON.stringify(newConfigData.tools)) {
        call.config.openAIRealtimeAPI.tools = newConfigData.tools;
        configChanged = true;
        call.callLogger.info(`Tools configuration updated locally for call ${callId}.`);
      }
    }
    if (configChanged) {
      call.callLogger.info(`Configuration for call ${callId} has been updated. New relevant values -> Instructions: "${call.config.openAIRealtimeAPI.instructions}", Voice: "${call.config.openAIRealtimeAPI.ttsVoice}"`);
      try {
        const sessionManagerModule = await import('./sessionManager');
        sessionManagerModule.sendSessionUpdateToOpenAI(callId, call.config.openAIRealtimeAPI);
      } catch (e: any) {
        call.callLogger.error(`Error trying to send session.update to OpenAI for call ${callId} after config change: ${e.message}`);
      }
    } else {
      call.callLogger.info(`No effective changes applied to call ${callId} configuration.`);
    }
  }

  public async connect(): Promise<void> {
    try {
      this.client = await Ari.connect(ASTERISK_ARI_URL, ASTERISK_ARI_USERNAME, ASTERISK_ARI_PASSWORD);
      this.logger.info('Successfully connected to Asterisk ARI.');
      this.client.on('StasisStart', this.onStasisStart.bind(this));
      this.client.on('ChannelDtmfReceived', this._onDtmfReceived.bind(this));
      this.client.on('ChannelTalkingStarted', this._onChannelTalkingStarted.bind(this));
      this.client.on('ChannelTalkingFinished', this._onChannelTalkingFinished.bind(this));
      this.client.on('error' as any, (err: any) => { this.onAriError(err); });
      this.client.on('close' as any, () => { this.onAriClose(); });
      await this.client.start(ASTERISK_ARI_APP_NAME);
      this.logger.info(`ARI Stasis application '${ASTERISK_ARI_APP_NAME}' started and listening for calls.`);
    } catch (err: any) {
      this.logger.error('FATAL: Failed to connect/start Stasis app:', err instanceof Error ? err.message : String(err), err instanceof Error ? err.stack : '');
      throw err;
    }
  }

  public _onOpenAISpeechStarted(callId: string): void {
    const call = this.activeCalls.get(callId);
    if (!call || call.isCleanupCalled) return;
    call.callLogger.info(`OpenAI speech recognition started (or first transcript received).`);
    if (call.noSpeechBeginTimer) { clearTimeout(call.noSpeechBeginTimer); call.noSpeechBeginTimer = null; }
    if (call.initialOpenAIStreamIdleTimer) { clearTimeout(call.initialOpenAIStreamIdleTimer); call.initialOpenAIStreamIdleTimer = null; }
    call.speechHasBegun = true;
  }

  public _onOpenAIInterimResult(callId: string, transcript: string): void {
    const call = this.activeCalls.get(callId);
    if (!call || call.isCleanupCalled) return;
    call.callLogger.debug(`OpenAI interim transcript: "${transcript}"`);
    if (!call.speechHasBegun) {
        if (call.noSpeechBeginTimer) { clearTimeout(call.noSpeechBeginTimer); call.noSpeechBeginTimer = null; }
        if (call.initialOpenAIStreamIdleTimer) { clearTimeout(call.initialOpenAIStreamIdleTimer); call.initialOpenAIStreamIdleTimer = null; }
        call.speechHasBegun = true;
        call.callLogger.info(`Speech implicitly started with first interim transcript.`);
    }
    if (call.mainPlayback && !call.promptPlaybackStoppedForInterim && call.config.appConfig.bargeInConfig.bargeInModeEnabled) {
      call.callLogger.info(`Stopping main prompt due to interim transcript (barge-in).`);
      this._stopAllPlaybacks(call).catch(e => call.callLogger.error(`Error stopping playback on interim: ` + (e instanceof Error ? e.message : String(e))));
      call.promptPlaybackStoppedForInterim = true;
    }
    if (call.speechEndSilenceTimer) clearTimeout(call.speechEndSilenceTimer);
    const silenceTimeout = (call.config.appConfig.appRecognitionConfig.speechCompleteTimeoutSeconds ?? 5) * 1000;
    call.speechEndSilenceTimer = setTimeout(() => {
      if (call.isCleanupCalled || !call.openAIStreamingActive) return;
      call.callLogger.warn(`Silence detected for ${silenceTimeout}ms after interim transcript. Stopping OpenAI session for this turn.`);
      sessionManager.stopOpenAISession(callId, 'interim_result_silence_timeout');
    }, silenceTimeout);
  }

  public _onOpenAIFinalResult(callId: string, transcript: string): void {
    const call = this.activeCalls.get(callId);
    if (!call || call.isCleanupCalled) return;

    call.callLogger.info(`_onOpenAIFinalResult CALLED for callId: ${callId}. Current ttsAudioChunks.length: ${call.ttsAudioChunks?.length ?? 'N/A'}`);
    call.callLogger.info(`OpenAI final transcript received: "${transcript}"`);

    if (call.speechEndSilenceTimer) { clearTimeout(call.speechEndSilenceTimer); call.speechEndSilenceTimer = null; }
    call.finalTranscription = transcript;
    call.callLogger.info(`Final transcript processed. Requesting OpenAI response for text: "${transcript}"`);

    try {
      sessionManager.requestOpenAIResponse(callId, transcript, call.config);
    } catch (e: any) {
      call.callLogger.error(`Error calling sessionManager.requestOpenAIResponse: ${e.message}`, e);
    }
    call.callLogger.info(`Waiting for OpenAI to generate response (including potential audio).`);
  }

  public _onOpenAIAudioChunk(callId: string, audioChunkBase64: string, _isLastChunk_deprecated: boolean): void {
    const call = this.activeCalls.get(callId);
    const loggerToUse = call?.callLogger || this.logger;

    loggerToUse.info(
      `_onOpenAIAudioChunk CALLED for callId: ${callId}. ` +
      `Call object exists: ${!!call}. ` +
      `Chunk non-empty: ${!!(audioChunkBase64 && audioChunkBase64.length > 0)}. ` +
      `ttsAudioChunks exists on call: ${!!call?.ttsAudioChunks}. ` +
      `Initial ttsAudioChunks length: ${call?.ttsAudioChunks?.length ?? 'N/A'}.`
    );

    if (!call || call.isCleanupCalled) {
      loggerToUse.warn(`_onOpenAIAudioChunk: Call object not found or cleanup called for ${callId}. Ignoring audio chunk.`);
      return;
    }

    if (!call.ttsAudioChunks) {
      call.callLogger.error('_onOpenAIAudioChunk: CRITICAL - ttsAudioChunks was undefined. This indicates a prior initialization issue.');
      call.ttsAudioChunks = [];
    }

    if (audioChunkBase64 && audioChunkBase64.length > 0) {
       call.callLogger.debug(`Received TTS audio chunk, length: ${audioChunkBase64.length}. Accumulating. Previous #chunks: ${call.ttsAudioChunks.length}`);
       call.ttsAudioChunks.push(audioChunkBase64);
       call.callLogger.info(`_onOpenAIAudioChunk: AFTER PUSH for call ${callId}, ttsAudioChunks.length: ${call.ttsAudioChunks.length}`);
    } else {
       call.callLogger.warn('_onOpenAIAudioChunk: Received empty or null audioChunkBase64.');
    }
  }

  public async _onOpenAIAudioStreamEnd(callId: string): Promise<void> {
    const call = this.activeCalls.get(callId);
    const loggerToUse = call?.callLogger || this.logger;

    if (!call || call.isCleanupCalled) {
      loggerToUse.warn(`_onOpenAIAudioStreamEnd: Call ${callId} not active or cleanup called.`);
      return;
    }

    if (!call.ttsAudioChunks) {
        call.callLogger.error(`_onOpenAIAudioStreamEnd: CRITICAL - ttsAudioChunks is undefined for call ${callId}. This should have been initialized in onStasisStart.`);
        return;
    }

    call.callLogger.info(`_onOpenAIAudioStreamEnd: Checking ttsAudioChunks for call ${callId}. Length: ${call.ttsAudioChunks.length}`);
    if (call.ttsAudioChunks.length > 0) {
      call.callLogger.debug(`_onOpenAIAudioStreamEnd: First chunk content (first 50 chars): ${call.ttsAudioChunks[0]?.substring(0,50)}`);
    }

    if (call.ttsAudioChunks.length > 0) {
      call.callLogger.info(`Processing ${call.ttsAudioChunks.length} audio chunks for call ${callId}.`);
      const decodedBuffers: Buffer[] = [];
      let totalOriginalBase64Length = 0;

      for (let i = 0; i < call.ttsAudioChunks.length; i++) {
        const chunkBase64 = call.ttsAudioChunks[i];
        if (typeof chunkBase64 === 'string' && chunkBase64.length > 0) {
          totalOriginalBase64Length += chunkBase64.length;
          // Quitar el log detallado del contenido del chunk que es muy verboso para producción.
          // call.callLogger.debug(`Chunk ${i}: Original Length=${chunkBase64.length}, Type=${typeof chunkBase64}, Content (first 50): ${chunkBase64.substring(0, 50)}`);
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
        call.ttsAudioChunks = [];
        return;
      }

      const audioInputBuffer = Buffer.concat(decodedBuffers);
      call.callLogger.info(`Concatenated ${decodedBuffers.length} decoded buffer(s). Total audioInputBuffer length for call ${callId}: ${audioInputBuffer.length} bytes.`);

      if (audioInputBuffer.length === 0) {
          call.callLogger.warn(`Combined decoded audio data for call ${callId} is empty. Skipping playback and saving.`);
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
        let audioExtension = '.raw';
        const outputFormat = call.config.openAIRealtimeAPI.outputAudioFormat?.toLowerCase();
        if (outputFormat === 'g711_ulaw' || outputFormat === 'mulaw_8000hz' || outputFormat === 'ulaw') {
          audioExtension = '.ulaw';
        } else if (outputFormat?.startsWith('pcm')) {
          audioExtension = '.pcm';
        } else if (outputFormat === 'mp3') {
          audioExtension = '.mp3';
        } else if (outputFormat === 'opus') {
          audioExtension = '.opus';
        }

        const audioInputBuffer = Buffer.from(fullAudioBase64, 'base64');
        call.callLogger.info(`Decoded base64 audio. Buffer length: ${audioInputBuffer.length} bytes`);

        const currentOutputFormat = call.config.openAIRealtimeAPI.outputAudioFormat?.toLowerCase(); // Renombrada para claridad
        const outputSampleRate = call.config.openAIRealtimeAPI.outputAudioSampleRate || 8000;
        call.callLogger.info(`OpenAI outputAudioFormat configured: ${currentOutputFormat}, SampleRate: ${outputSampleRate}Hz`);

        let filenameOnly = `openai_tts_${callId}_${timestamp}`;
        let filenameWithExt: string;
        let finalAudioBuffer = audioInputBuffer; // Buffer que se guardará

        if (currentOutputFormat?.startsWith('pcm')) {
          call.callLogger.info(`Output format is PCM. Attempting to wrap with WAV header.`);
          if (audioInputBuffer.length > 0) {
            // Asumiendo 16-bit PCM (2 bytes por frame/sample para mono)
            // numFrames es el número total de muestras de audio.
            // Si es mono, 16-bit, cada muestra es de 2 bytes.
            // Entonces, numFrames = totalBytes / bytesPorMuestra.
            const bytesPerSample = 2; // Para PCM 16-bit
            const numChannels = 1;    // Asumimos mono

            const numFrames = audioInputBuffer.length / (bytesPerSample * numChannels);

            if (audioInputBuffer.length % (bytesPerSample * numChannels) !== 0) {
                call.callLogger.warn(`PCM audio buffer length (${audioInputBuffer.length}) is not a multiple of bytesPerSample*numChannels (${bytesPerSample * numChannels}). WAV header might be incorrect.`);
            }

            const wavHeader = createWavHeader({
              numFrames: numFrames,
              numChannels: numChannels,
              sampleRate: outputSampleRate,
              bytesPerSample: bytesPerSample
            });
            finalAudioBuffer = Buffer.concat([wavHeader, audioInputBuffer]);
            filenameWithExt = `${filenameOnly}.wav`;
            call.callLogger.info(`PCM data wrapped with WAV header. Final buffer length: ${finalAudioBuffer.length}. SampleRate for header: ${outputSampleRate}Hz. NumFrames for header: ${numFrames}.`);
          } else {
            call.callLogger.warn(`PCM audio buffer is empty. Cannot create WAV.`);
            call.ttsAudioChunks = []; // Limpiar para el siguiente turno
            return; // No hay nada que guardar o reproducir
          }
        } else if (currentOutputFormat === 'g711_ulaw' || currentOutputFormat === 'mulaw_8000hz' || currentOutputFormat === 'ulaw') {
          filenameWithExt = `${filenameOnly}.ulaw`;
          call.callLogger.info(`Output format is uLaw. Saving as .ulaw. SampleRate expected by Asterisk: 8000Hz.`);
        } else if (currentOutputFormat === 'mp3') {
           filenameWithExt = `${filenameOnly}.mp3`;
           call.callLogger.info(`Output format is MP3. Saving as .mp3.`);
        } else if (currentOutputFormat === 'opus') {
           filenameWithExt = `${filenameOnly}.opus`;
           call.callLogger.info(`Output format is Opus. Saving as .opus.`);
        } else {
          call.callLogger.warn(`Unknown or unhandled output audio format: '${currentOutputFormat}'. Saving as .raw`);
          filenameWithExt = `${filenameOnly}.raw`;
        }

        const absoluteFilepath = path.join(openaiRecordingsDir, filenameWithExt);
        fs.writeFileSync(absoluteFilepath, finalAudioBuffer);
        call.callLogger.info(`TTS audio for call ${callId} saved to ${absoluteFilepath} (${finalAudioBuffer.length} bytes)`);

        // Para Asterisk, al usar 'sound:', no se especifica la extensión si es un formato común como .wav o .ulaw
        // Asterisk intentará encontrar el archivo con la extensión más apropiada.
        soundPathForPlayback = `openai/${filenameOnly}`;

      } catch (saveError: any) {
        call.callLogger.error(`Failed to save or process TTS audio for call ${callId}: ${saveError.message}`, saveError);
      }

      if (soundPathForPlayback) {
        call.callLogger.info(`Playing accumulated TTS audio for call ${callId} from sound path: sound:${soundPathForPlayback}`);
        try {
          // Asegurarse de que no haya una reproducción anterior en curso que pueda interferir.
          if (call.waitingPlayback) {
            call.callLogger.debug(`Stopping potentially existing waitingPlayback before starting new TTS playback.`);
            await call.waitingPlayback.stop().catch(e => call.callLogger.warn(`Error stopping previous waitingPlayback: ${e.message}`));
            call.waitingPlayback = undefined; // Limpiar la referencia
          }

          await this.playbackAudio(callId, null, `sound:${soundPathForPlayback}`);
          call.callLogger.info(`TTS audio playback initiated for call ${callId} using file: sound:${soundPathForPlayback}.`);
        } catch (e: any) {
          call.callLogger.error(`Error initiating TTS audio playback from file for call ${callId}: ${e.message}`, e);
        }
      } else {
        call.callLogger.error(`TTS audio for call ${callId} was not saved correctly (soundPathForPlayback is null), cannot play from file.`);
        // No intentar fallback a base64 aquí si el objetivo era guardar y reproducir desde archivo.
        // Si saveError ocurrió, el problema es previo a la reproducción.
      }
    } else {
      call.callLogger.info(`TTS audio stream ended for call ${callId}, but no audio chunks were accumulated to play (length is 0).`);
    }
    call.ttsAudioChunks = []; // Limpiar siempre los chunks después de procesarlos (o intentar procesarlos)
  }

  public _onOpenAIError(callId: string, error: any): void {
    const call = this.activeCalls.get(callId);
    if (!call || call.isCleanupCalled) return;
    call.callLogger.error(`OpenAI stream error reported by sessionManager:`, error);
    call.openAIStreamError = error;
    this._fullCleanup(callId, true, "OPENAI_STREAM_ERROR");
  }

  public _onOpenAISessionEnded(callId: string, reason: string): void {
    const call = this.activeCalls.get(callId);
    if (!call || call.isCleanupCalled) return;
    call.callLogger.info(`OpenAI session ended event from sessionManager. Reason: ${reason}`);
    call.openAIStreamingActive = false;
    if (!call.finalTranscription && !call.openAIStreamError && !call.dtmfModeActive) {
        call.callLogger.warn(`OpenAI session ended (reason: ${reason}) without final transcript, error, or DTMF. Call may continue or timeout.`);
    } else {
        call.callLogger.info(`OpenAI session ended (reason: ${reason}). This is likely part of a normal flow (final result, DTMF, error, or explicit stop).`);
    }
  }

  private async _stopAllPlaybacks(call: CallResources): Promise<void> {
    const playbacksToStop = [call.mainPlayback, call.waitingPlayback, call.postRecognitionWaitingPlayback];
    for (const playback of playbacksToStop) {
      if (playback) {
        try {
          call.callLogger.debug(`Stopping playback ${playback.id}.`);
          await playback.stop();
        } catch (e:any) { call.callLogger.warn(`Error stopping playback ${playback.id}: ${(e instanceof Error ? e.message : String(e))}`); }
      }
    }
    call.mainPlayback = undefined;
    call.waitingPlayback = undefined;
    call.postRecognitionWaitingPlayback = undefined;
  }

  private async _onDtmfReceived(event: ChannelDtmfReceived, channel: Channel): Promise<void> {
    const call = this.activeCalls.get(channel.id);
    if (!call || call.isCleanupCalled) { return; }
    if (call.channel.id !== channel.id) { return; }
    call.callLogger.info(`DTMF digit '${event.digit}' received.`);
    if (!call.config.appConfig.dtmfConfig.dtmfEnabled) {
      call.callLogger.info(`DTMF disabled by config. Ignoring.`);
      return;
    }
    call.callLogger.info(`Entering DTMF mode: interrupting speech/VAD activities.`);
    call.dtmfModeActive = true;
    call.speechRecognitionDisabledDueToDtmf = true;
    call.isVADBufferingActive = false;
    call.vadAudioBuffer = [];
    call.pendingVADBufferFlush = false;
    await this._stopAllPlaybacks(call);

    if (call.openAIStreamingActive) {
      call.callLogger.info(`DTMF interrupting active OpenAI stream.`);
      call.dtmfInterruptedSpeech = true;
      sessionManager.stopOpenAISession(call.channel.id, 'dtmf_interrupt');
      call.openAIStreamingActive = false;
      if (call.noSpeechBeginTimer) { clearTimeout(call.noSpeechBeginTimer); call.noSpeechBeginTimer = null; }
      if (call.initialOpenAIStreamIdleTimer) { clearTimeout(call.initialOpenAIStreamIdleTimer); call.initialOpenAIStreamIdleTimer = null; }
      if (call.speechEndSilenceTimer) { clearTimeout(call.speechEndSilenceTimer); call.speechEndSilenceTimer = null; }
      call.speechHasBegun = false;
    }
    if(call.vadMaxWaitAfterPromptTimer) { clearTimeout(call.vadMaxWaitAfterPromptTimer); call.vadMaxWaitAfterPromptTimer = null; }
    if(call.vadActivationDelayTimer) { clearTimeout(call.vadActivationDelayTimer); call.vadActivationDelayTimer = null; }
    if(call.vadInitialSilenceDelayTimer) { clearTimeout(call.vadInitialSilenceDelayTimer); call.vadInitialSilenceDelayTimer = null; }

    call.collectedDtmfDigits += event.digit;
    call.callLogger.info(`Collected DTMF: ${call.collectedDtmfDigits}`);

    if (call.dtmfInterDigitTimer) clearTimeout(call.dtmfInterDigitTimer);
    const interDigitTimeout = (call.config.appConfig.dtmfConfig.dtmfInterdigitTimeoutSeconds ?? 2) * 1000;
    call.dtmfInterDigitTimer = setTimeout(() => { call.callLogger.info(`DTMF inter-digit timer expired.`); }, interDigitTimeout);

    if (call.dtmfFinalTimer) clearTimeout(call.dtmfFinalTimer);
    const finalTimeout = (call.config.appConfig.dtmfConfig.dtmfFinalTimeoutSeconds ?? 3) * 1000;
    call.dtmfFinalTimer = setTimeout(async () => {
      if (call.isCleanupCalled) return;
      call.callLogger.info(`DTMF final timeout. Digits: ${call.collectedDtmfDigits}`);
      if (call.dtmfModeActive && call.collectedDtmfDigits.length > 0) {
        try { await call.channel.setChannelVar({ variable: 'DTMF_RESULT', value: call.collectedDtmfDigits }); }
        catch (e: any) { call.callLogger.error(`Error setting DTMF_RESULT: ${(e instanceof Error ? e.message : String(e))}`); }
        this._fullCleanup(call.channel.id, false, "DTMF_FINAL_TIMEOUT");
      } else { this._fullCleanup(call.channel.id, false, "DTMF_FINAL_TIMEOUT_NO_DIGITS"); }
    }, finalTimeout);

    const dtmfConfig = call.config.appConfig.dtmfConfig;
    if (event.digit === dtmfConfig.dtmfTerminatorDigit) {
      call.callLogger.info(`DTMF terminator digit received.`);
      if (call.dtmfFinalTimer) clearTimeout(call.dtmfFinalTimer);
      try { await call.channel.setChannelVar({ variable: 'DTMF_RESULT', value: call.collectedDtmfDigits }); }
      catch (e:any) { call.callLogger.error(`Error setting DTMF_RESULT: ${(e instanceof Error ? e.message : String(e))}`); }
      this._fullCleanup(call.channel.id, false, "DTMF_TERMINATOR_RECEIVED");
    } else if (call.collectedDtmfDigits.length >= (dtmfConfig.dtmfMaxDigits ?? 16)) {
      call.callLogger.info(`Max DTMF digits reached.`);
      if (call.dtmfFinalTimer) clearTimeout(call.dtmfFinalTimer);
      try { await call.channel.setChannelVar({ variable: 'DTMF_RESULT', value: call.collectedDtmfDigits }); }
      catch (e:any) { call.callLogger.error(`Error setting DTMF_RESULT: ${(e instanceof Error ? e.message : String(e))}`); }
      this._fullCleanup(call.channel.id, false, "DTMF_MAX_DIGITS_REACHED");
    }
  }

  private async _activateOpenAIStreaming(callId: string, reason: string): Promise<void> {
    const call = this.activeCalls.get(callId);
    if (!call || call.isCleanupCalled || call.openAIStreamingActive) {
      if(call?.openAIStreamingActive) {
        call.callLogger.debug(`Activate called but stream already active. Reason: ${reason}`);
      }
      return;
    }
    call.callLogger.info(`Activating OpenAI streaming. Reason: ${reason}`);
    call.openAIStreamingActive = true;

    try {
      await sessionManager.startOpenAISession(callId, this, call.config);
      call.callLogger.info(`Session manager initiated OpenAI session for ${callId}.`);
      if (call.pendingVADBufferFlush && call.vadAudioBuffer.length > 0) {
        call.callLogger.info(`Flushing ${call.vadAudioBuffer.length} VAD audio packets to OpenAI.`);
        call.isVADBufferingActive = false;
        for (const audioPayload of call.vadAudioBuffer) { sessionManager.sendAudioToOpenAI(callId, audioPayload); }
        call.vadAudioBuffer = []; call.pendingVADBufferFlush = false;
      }
      const noSpeechTimeout = call.config.appConfig.appRecognitionConfig.noSpeechBeginTimeoutSeconds;
      if (noSpeechTimeout > 0 && !call.speechHasBegun) {
        call.noSpeechBeginTimer = setTimeout(() => {
          if (call.isCleanupCalled || call.speechHasBegun) return;
          call.callLogger.warn(`No speech from OpenAI in ${noSpeechTimeout}s. Stopping session & call.`);
          sessionManager.stopOpenAISession(callId, "no_speech_timeout_in_ari");
          this._fullCleanup(callId, true, "NO_SPEECH_BEGIN_TIMEOUT");
        }, noSpeechTimeout * 1000);
        call.callLogger.info(`NoSpeechBeginTimer started (${noSpeechTimeout}s).`);
      }
      const streamIdleTimeout = call.config.appConfig.appRecognitionConfig.initialOpenAIStreamIdleTimeoutSeconds ?? 10;
      call.initialOpenAIStreamIdleTimer = setTimeout(() => {
         if (call.isCleanupCalled || call.speechHasBegun) return;
         call.callLogger.warn(`OpenAI stream idle for ${streamIdleTimeout}s. Stopping session & call.`);
         sessionManager.stopOpenAISession(callId, "initial_stream_idle_timeout_in_ari");
         this._fullCleanup(callId, true, "OPENAI_STREAM_IDLE_TIMEOUT");
      }, streamIdleTimeout * 1000);
      call.callLogger.info(`InitialOpenAIStreamIdleTimer started (${streamIdleTimeout}s).`);
    } catch (error: any) {
        call.callLogger.error(`Error during _activateOpenAIStreaming for ${callId}: ${(error instanceof Error ? error.message : String(error))}`);
        call.openAIStreamingActive = false;
        this._onOpenAIError(callId, error);
    }
  }

  private _handleVADDelaysCompleted(callId: string): void {
    const call = this.activeCalls.get(callId);
    if (!call || call.isCleanupCalled || call.config.appConfig.appRecognitionConfig.recognitionActivationMode !== 'VAD' || call.config.appConfig.appRecognitionConfig.vadRecogActivation !== 'vadMode') {
      return;
    }
    call.callLogger.debug(`VAD delays completed. InitialSilence: ${call.vadInitialSilenceDelayCompleted}, ActivationDelay: ${call.vadActivationDelayCompleted}`);

    if (call.vadInitialSilenceDelayCompleted && call.vadActivationDelayCompleted) {
      call.callLogger.info(`VAD vadMode: All initial delays completed.`);
      if (call.vadRecognitionTriggeredAfterInitialDelay || call.openAIStreamingActive) { return; }

      if (call.vadSpeechActiveDuringDelay) {
        call.callLogger.info(`VAD vadMode: Speech detected during delays. Activating OpenAI stream.`);
        this._activateOpenAIStreaming(callId, "vad_speech_during_delay_window");
        call.pendingVADBufferFlush = true;
        if(call.channel) {
            call.channel.setChannelVar({ variable: 'TALK_DETECT(remove)', value: 'true' })
                .catch(e => call.callLogger.warn(`VAD: Error removing TALK_DETECT: ${e.message}`));
        }
      } else {
        call.callLogger.info(`VAD vadMode: Delays completed, no prior speech. Listening via TALK_DETECT.`);
        this._handlePostPromptVADLogic(callId);
      }
    }
  }

  private _handlePostPromptVADLogic(callId: string): void {
    const call = this.activeCalls.get(callId);
    if (!call || call.isCleanupCalled || call.config.appConfig.appRecognitionConfig.recognitionActivationMode !== 'VAD') {
      return;
    }
    call.callLogger.info(`VAD: Handling post-prompt/no-prompt logic for mode '${call.config.appConfig.appRecognitionConfig.vadRecogActivation}'.`);

    const vadRecogActivation = call.config.appConfig.appRecognitionConfig.vadRecogActivation;

    if (vadRecogActivation === 'afterPrompt') {
      if (call.vadRecognitionTriggeredAfterInitialDelay || call.openAIStreamingActive) { return; }
      if (call.vadSpeechDetected) {
        call.callLogger.info(`VAD (afterPrompt): Speech previously detected. Activating OpenAI stream.`);
        this._activateOpenAIStreaming(callId, "vad_afterPrompt_speech_during_prompt");
        call.pendingVADBufferFlush = true;
        if(call.channel) {
            call.channel.setChannelVar({ variable: 'TALK_DETECT(remove)', value: 'true' })
                .catch(e => call.callLogger.warn(`VAD: Error removing TALK_DETECT: ${e.message}`));
        }
      } else {
        call.callLogger.info(`VAD (afterPrompt): No speech during prompt. Starting max wait timer.`);
        const maxWait = call.config.appConfig.appRecognitionConfig.vadMaxWaitAfterPromptSeconds ?? 5;
        if (maxWait > 0) {
          if(call.vadMaxWaitAfterPromptTimer) clearTimeout(call.vadMaxWaitAfterPromptTimer);
          call.vadMaxWaitAfterPromptTimer = setTimeout(() => {
            if (call.isCleanupCalled || call.vadRecognitionTriggeredAfterInitialDelay || call.openAIStreamingActive) return;
            call.callLogger.warn(`VAD (afterPrompt): Max wait ${maxWait}s reached. Ending call.`);
            if(call.channel) { call.channel.setChannelVar({ variable: 'TALK_DETECT(remove)', value: 'true' }).catch(e => call.callLogger.warn(`VAD: Error removing TALK_DETECT: ${e.message}`)); }
            this._fullCleanup(callId, true, "VAD_MAX_WAIT_TIMEOUT");
          }, maxWait * 1000);
        } else {
            call.callLogger.info(`VAD (afterPrompt): Max wait is 0 and no speech during prompt. Ending call.`);
            if(call.channel) { call.channel.setChannelVar({ variable: 'TALK_DETECT(remove)', value: 'true' }).catch(e => call.callLogger.warn(`VAD: Error removing TALK_DETECT: ${e.message}`)); }
            this._fullCleanup(callId, true, "VAD_MAX_WAIT_0_NO_SPEECH");
        }
      }
    } else if (vadRecogActivation === 'vadMode') {
      call.callLogger.info(`VAD vadMode: Delays completed, no speech during delay. Actively listening via TALK_DETECT.`);
    }
  }

  private async _onChannelTalkingStarted(event: ChannelTalkingStarted, channel: Channel): Promise<void> {
    const call = this.activeCalls.get(channel.id);
    if (!call || call.channel.id !== channel.id || call.isCleanupCalled || call.config.appConfig.appRecognitionConfig.recognitionActivationMode !== 'VAD') {
      return;
    }
    call.callLogger.info(`TALK_DETECT: Speech started on channel ${channel.id}.`);

    if (call.vadRecognitionTriggeredAfterInitialDelay || call.openAIStreamingActive) { return; }

    const vadRecogActivation = call.config.appConfig.appRecognitionConfig.vadRecogActivation;
    if (vadRecogActivation === 'vadMode') {
      if (!call.vadInitialSilenceDelayCompleted || !call.vadActivationDelayCompleted) {
        call.callLogger.debug(`VAD (vadMode): Speech detected during initial VAD delays.`);
        call.vadSpeechActiveDuringDelay = true;
        call.vadSpeechDetected = true;
        return;
      }
    } else if (vadRecogActivation === 'afterPrompt') {
      if (call.mainPlayback) {
        call.callLogger.debug(`VAD (afterPrompt): Speech detected during main prompt.`);
        call.vadSpeechDetected = true;
        return;
      }
    }

    call.callLogger.info(`VAD: Speech detected, proceeding to activate stream.`);
    call.vadSpeechDetected = true;
    call.vadRecognitionTriggeredAfterInitialDelay = true;

    if (call.mainPlayback && !call.promptPlaybackStoppedForInterim) {
      try {
        call.callLogger.info(`VAD: Stopping main prompt due to speech.`);
        await call.mainPlayback.stop();
        call.promptPlaybackStoppedForInterim = true;
      } catch (e: any) { call.callLogger.warn(`VAD: Error stopping main playback: ${e.message}`); }
    }

    if(call.bargeInActivationTimer) { clearTimeout(call.bargeInActivationTimer); call.bargeInActivationTimer = null; }
    if(call.vadMaxWaitAfterPromptTimer) { clearTimeout(call.vadMaxWaitAfterPromptTimer); call.vadMaxWaitAfterPromptTimer = null; }

    this._activateOpenAIStreaming(call.channel.id, "vad_speech_detected_direct");
    call.pendingVADBufferFlush = true;

    try {
      call.callLogger.info(`VAD: Removing TALK_DETECT from channel after confirmed speech.`);
      await channel.setChannelVar({ variable: 'TALK_DETECT(remove)', value: 'true' });
    } catch (e: any) { call.callLogger.warn(`VAD: Error removing TALK_DETECT: ${e.message}`); }
  }

  private async _onChannelTalkingFinished(event: ChannelTalkingFinished, channel: Channel): Promise<void> {
    const call = this.activeCalls.get(channel.id);
    if (!call || call.channel.id !== channel.id || call.isCleanupCalled || call.config.appConfig.appRecognitionConfig.recognitionActivationMode !== 'VAD') {
      return;
    }
    call.callLogger.info(`TALK_DETECT: Speech finished. Duration: ${event.duration}ms`);
    call.vadSpeechDetected = false;
    if (!call.vadInitialSilenceDelayCompleted || !call.vadActivationDelayCompleted) {
        call.vadSpeechActiveDuringDelay = false;
    }
  }

  private _handlePlaybackFinished(callId: string, reason: string): void {
    const call = this.activeCalls.get(callId);
    if (!call || call.isCleanupCalled) {
      return;
    }
    if (reason.startsWith('main_greeting_')) {
      call.callLogger.info(`Handling post-greeting logic for call ${callId}. Reason: ${reason}`);
      call.mainPlayback = undefined;

      const activationMode = call.config.appConfig.appRecognitionConfig.recognitionActivationMode;
      if (activationMode === 'VAD') {
        this._handlePostPromptVADLogic(callId);
      } else if (activationMode === 'FIXED_DELAY') {
        const delaySeconds = call.config.appConfig.appRecognitionConfig.bargeInDelaySeconds ?? 0.5;
        call.callLogger.info(`FixedDelay mode: Greeting finished/failed. Barge-in delay: ${delaySeconds}s.`);
        if (delaySeconds > 0) {
          if (call.bargeInActivationTimer) clearTimeout(call.bargeInActivationTimer);
          call.bargeInActivationTimer = setTimeout(() => {
            if (call.isCleanupCalled) return;
            this._activateOpenAIStreaming(callId, "fixedDelay_barge_in_timer_expired_post_greeting");
          }, delaySeconds * 1000);
        } else {
          this._activateOpenAIStreaming(callId, "fixedDelay_immediate_activation_post_greeting");
        }
      }
    }
  }

  private async onStasisStart(event: any, incomingChannel: Channel): Promise<void> {
    const callId = incomingChannel.id;
    const localCallConfig = getCallSpecificConfig(moduleLogger.child({ callId, channelName: incomingChannel.name, context: 'configLoad' }), incomingChannel);
    const callLogger = moduleLogger.child({ callId, channelName: incomingChannel.name });

    if (incomingChannel.name.startsWith('UnicastRTP/') || incomingChannel.name.startsWith('Snoop/')) {
      callLogger.info(`StasisStart for utility channel ${incomingChannel.name} (${incomingChannel.id}). Answering if needed and ignoring further setup.`);
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

    if (this.appOwnedChannelIds.has(callId)) {
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
      vadInitialSilenceDelayCompleted: false, vadActivationDelayCompleted: false,
      bargeInActivationTimer: null, noSpeechBeginTimer: null, initialOpenAIStreamIdleTimer: null,
      speechEndSilenceTimer: null, maxRecognitionDurationTimer: null,
      dtmfInterDigitTimer: null, dtmfFinalTimer: null,
      vadMaxWaitAfterPromptTimer: null, vadActivationDelayTimer: null, vadInitialSilenceDelayTimer: null,
      ttsAudioChunks: [],
      currentTtsResponseId: undefined,
    };
    this.activeCalls.set(callId, callResources);
    this.currentPrimaryCallId = callId;
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
      incomingChannel.once('StasisEnd', () => {
        callLogger.info(`Primary channel ${callId} StasisEnd. Cleanup.`);
        this._fullCleanup(callId, false, "PRIMARY_CHANNEL_STASIS_ENDED");
      });

      if (!this.client) { throw new Error("ARI client not connected."); }

      callResources.userBridge = await this.client.bridges.create({ type: 'mixing', name: `user_b_${callId}` });
      callLogger.info(`Successfully created userBridge ${callResources.userBridge.id} for call ${callId}.`);
      await callResources.userBridge.addChannel({ channel: callId });
      callLogger.info(`Successfully added channel ${callId} to userBridge ${callResources.userBridge.id}.`);

      callResources.snoopBridge = await this.client.bridges.create({ type: 'mixing', name: `snoop_b_${callId}` });
      callLogger.info(`Successfully created snoopBridge ${callResources.snoopBridge.id} for call ${callId}.`);

      callResources.rtpServer = new RtpServer(callLogger.child({ component: 'RtpServer'}));
      const rtpServerAddress = await callResources.rtpServer.start(0, DEFAULT_RTP_HOST_IP);
      callLogger.info(`RTP Server started for call ${callId}, listening on ${rtpServerAddress.host}:${rtpServerAddress.port}.`);

      const externalMediaFormat = 'ulaw';
      callResources.externalMediaChannel = await this.client.channels.externalMedia({
        app: ASTERISK_ARI_APP_NAME,
        external_host: `${rtpServerAddress.host}:${rtpServerAddress.port}`,
        format: externalMediaFormat,
        encapsulation: 'rtp'
      });
      callLogger.info(`Successfully created externalMediaChannel ${callResources.externalMediaChannel.id} for call ${callId} with format ${externalMediaFormat}.`);
      this.appOwnedChannelIds.add(callResources.externalMediaChannel.id);

      const snoopDirection = 'in' as ('in' | 'out' | 'both');
      callResources.snoopChannel = await this.client.channels.snoopChannelWithId({ channelId: callId, snoopId: `snoop_${callId}`, app: ASTERISK_ARI_APP_NAME, spy: snoopDirection });
      callLogger.info(`Successfully created snoopChannel ${callResources.snoopChannel.id} for call ${callId} with direction '${snoopDirection}'.`);
      this.appOwnedChannelIds.add(callResources.snoopChannel.id);

      await callResources.snoopBridge.addChannel({ channel: callResources.externalMediaChannel.id });
      callLogger.info(`Successfully added externalMediaChannel ${callResources.externalMediaChannel.id} to snoopBridge ${callResources.snoopBridge.id}.`);
      await callResources.snoopBridge.addChannel({ channel: callResources.snoopChannel.id });
      callLogger.info(`Successfully added snoopChannel ${callResources.snoopChannel.id} to snoopBridge ${callResources.snoopBridge.id}.`);

      callResources.rtpServer.on('audioPacket', (audioPayload: Buffer) => {
        const call = this.activeCalls.get(callId);
        if (call && !call.isCleanupCalled) {
          call.callLogger.silly?.(`Received raw audio packet from Asterisk, length: ${audioPayload.length}.`);
          if (call.openAIStreamingActive && !call.pendingVADBufferFlush) {
            sessionManager.sendAudioToOpenAI(callId, audioPayload);
          }
          if (call.isVADBufferingActive) {
            if (call.vadAudioBuffer.length < MAX_VAD_BUFFER_PACKETS) {
              call.vadAudioBuffer.push(audioPayload);
            } else {
              call.callLogger.warn(`VAD buffer limit. Shift.`);
              call.vadAudioBuffer.shift();
              call.vadAudioBuffer.push(audioPayload);
            }
          }
        }
      });

      sessionManager.handleCallConnection(callId, this);
      callLogger.info(`Call connection details passed to SessionManager.`);

      const appRecogConf = localCallConfig.appConfig.appRecognitionConfig;
      if (appRecogConf.maxRecognitionDurationSeconds && appRecogConf.maxRecognitionDurationSeconds > 0) {
        callResources.maxRecognitionDurationTimer = setTimeout(() => { this._fullCleanup(callId, true, "MAX_RECOGNITION_DURATION_TIMEOUT"); }, appRecogConf.maxRecognitionDurationSeconds * 1000);
      }

      const activationMode = appRecogConf.recognitionActivationMode;
      if (activationMode === 'IMMEDIATE') { this._activateOpenAIStreaming(callId, "immediate_mode_on_start"); }
      else if (activationMode === 'VAD') {
        callResources.isVADBufferingActive = true;
        const vadConfig = appRecogConf.vadConfig;
        const talkDetectValue = `${vadConfig.vadRecognitionActivationMs},${vadConfig.vadSilenceThresholdMs}`;
        callLogger.info(`Attempting to set TALK_DETECT on channel ${callId} with value: ${talkDetectValue}.`);
        await incomingChannel.setChannelVar({ variable: 'TALK_DETECT(set)', value: talkDetectValue });
        callLogger.info(`Successfully set TALK_DETECT on channel ${callId}.`);

        if (appRecogConf.vadRecogActivation === 'vadMode') {
          callResources.vadInitialSilenceDelayCompleted = (appRecogConf.vadInitialSilenceDelaySeconds ?? 0) <= 0;
          callResources.vadActivationDelayCompleted = (appRecogConf.vadActivationDelaySeconds ?? 0) <= 0;
          if (!callResources.vadInitialSilenceDelayCompleted) {
            callResources.vadInitialSilenceDelayTimer = setTimeout(() => { if(callResources.isCleanupCalled) return; callResources.vadInitialSilenceDelayCompleted = true; this._handleVADDelaysCompleted(callId); }, (appRecogConf.vadInitialSilenceDelaySeconds ?? 0) * 1000);
          }
          if (!callResources.vadActivationDelayCompleted) {
            callResources.vadActivationDelayTimer = setTimeout(() => { if(callResources.isCleanupCalled) return; callResources.vadActivationDelayCompleted = true; this._handleVADDelaysCompleted(callId); }, (appRecogConf.vadActivationDelaySeconds ?? 0) * 1000);
          }
          if (callResources.vadInitialSilenceDelayCompleted && callResources.vadActivationDelayCompleted) { this._handleVADDelaysCompleted(callId); }
        }
      }

      const greetingAudio = appRecogConf.greetingAudioPath;
      if (greetingAudio && this.client) {
        callLogger.info(`Playing greeting audio: ${greetingAudio}`);
        callResources.mainPlayback = this.client.Playback();
        if (callResources.mainPlayback) {
          const mainPlaybackId = callResources.mainPlayback.id;
          const playbackFailedHandler = (event: any, failedPlayback: Playback) => {
            if (this.client && failedPlayback.id === mainPlaybackId) {
              const currentCall = this.activeCalls.get(callId);
              if (currentCall?.mainPlayback?.id === mainPlaybackId) {
                currentCall.callLogger.warn(`Main greeting playback ${failedPlayback.id} FAILED.`);
                this._handlePlaybackFinished(callId, 'main_greeting_failed');
              }
              if (currentCall?.playbackFailedHandler) {
                this.client?.removeListener('PlaybackFailed' as any, currentCall.playbackFailedHandler);
                currentCall.playbackFailedHandler = null;
              }
            }
          };
          callResources.playbackFailedHandler = playbackFailedHandler;
          this.client.on('PlaybackFailed' as any, callResources.playbackFailedHandler);
          callResources.mainPlayback.once('PlaybackFinished', (evt: any, instance: Playback) => {
            const currentCall = this.activeCalls.get(callId);
            if (currentCall?.playbackFailedHandler && this.client && instance.id === currentCall.mainPlayback?.id) {
              this.client.removeListener('PlaybackFailed' as any, currentCall.playbackFailedHandler);
              currentCall.playbackFailedHandler = null;
            }
            if (currentCall?.mainPlayback?.id === instance.id) {
              currentCall.callLogger.info(`Main greeting playback ${instance.id} FINISHED.`);
              this._handlePlaybackFinished(callId, 'main_greeting_finished');
            }
          });
          await callResources.channel.play({ media: greetingAudio }, callResources.mainPlayback);
          callLogger.info(`Successfully started main greeting playback ${callResources.mainPlayback.id}.`);
        } else {
           callLogger.error(`Failed to create mainPlayback object.`);
           this._handlePlaybackFinished(callId, 'main_greeting_creation_failed');
        }
      } else {
        callLogger.info(greetingAudio ? `Client not available for greeting playback.` : `No greeting audio specified.`);
        if (activationMode === 'FIXED_DELAY') {
            const delaySeconds = appRecogConf.bargeInDelaySeconds ?? 0.5;
            if(delaySeconds > 0) { callResources.bargeInActivationTimer = setTimeout(() => { if(!callResources.isCleanupCalled) this._activateOpenAIStreaming(callId, "fixedDelay_no_greeting_timer"); }, delaySeconds * 1000); }
            else { this._activateOpenAIStreaming(callId, "fixedDelay_no_greeting_immediate");}
        } else if (activationMode === 'VAD') {
            this._handlePostPromptVADLogic(callId);
        }
      }
      callLogger.info(`StasisStart setup complete for call ${callId}.`);

      this.sendEventToFrontend({
        type: "ari_call_status_update",
        payload: {
          status: "active",
          callId: callId,
          callerId: incomingChannel.caller?.number || "Unknown"
        }
      });

    } catch (err: any) {
      callLogger.error(`Error in StasisStart for ${callId}: ${(err instanceof Error ? err.message : String(err))}`);
      this.sendEventToFrontend({
        type: "ari_call_status_update",
        payload: {
          status: "error",
          callId: callId,
          callerId: incomingChannel.caller?.number || "Unknown",
          errorMessage: (err instanceof Error ? err.message : String(err))
        }
      });
      await this._fullCleanup(callId, true, "STASIS_START_ERROR");
    }
  }

  private onAppOwnedChannelStasisEnd(event: any, channel: Channel): void { /* ... */ }
  private async onStasisEnd(event: any, channel: Channel): Promise<void> { /* ... */ }
  private _clearCallTimers(call: CallResources): void {
    if (call.bargeInActivationTimer) clearTimeout(call.bargeInActivationTimer);
    if (call.noSpeechBeginTimer) clearTimeout(call.noSpeechBeginTimer);
    if (call.initialOpenAIStreamIdleTimer) clearTimeout(call.initialOpenAIStreamIdleTimer);
    if (call.speechEndSilenceTimer) clearTimeout(call.speechEndSilenceTimer);
    if (call.maxRecognitionDurationTimer) clearTimeout(call.maxRecognitionDurationTimer);
    if (call.dtmfInterDigitTimer) clearTimeout(call.dtmfInterDigitTimer);
    if (call.dtmfFinalTimer) clearTimeout(call.dtmfFinalTimer);
    if (call.vadMaxWaitAfterPromptTimer) clearTimeout(call.vadMaxWaitAfterPromptTimer);
    if (call.vadActivationDelayTimer) clearTimeout(call.vadActivationDelayTimer);
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
  }
  private async _fullCleanup(callId: string, hangupMainChannel: boolean, reason: string): Promise<void> {
    const call = this.activeCalls.get(callId);
    if (call && call.isCleanupCalled) {
      return;
    }
    if (call) {
      if (call.isCleanupCalled) { // Evitar doble limpieza o envío de eventos duplicados
        // call.callLogger.debug(`_fullCleanup for ${callId} already called or in progress. Skipping.`);
        return;
      }
      call.isCleanupCalled = true;
      call.callLogger.info(`Full cleanup initiated for call ${callId}. Reason: ${reason}. Hangup main: ${hangupMainChannel}`);

      // Send event before clearing currentPrimaryCallId if this IS the primary call
      if (this.currentPrimaryCallId === callId) {
        this.sendEventToFrontend({
          type: "ari_call_status_update",
          payload: {
            status: "ended",
            callId: callId,
            callerId: call.channel?.caller?.number || "Unknown",
            reason: reason
          }
        });
        this.currentPrimaryCallId = null;
        call.callLogger.info(`Cleared as current primary call.`);
      } else if (callId) { // If it's a different callId (e.g. if logic changes to allow multiple non-primary calls)
         this.sendEventToFrontend({
          type: "ari_call_status_update",
          payload: {
            status: "ended",
            callId: callId,
            callerId: call.channel?.caller?.number || "Unknown",
            reason: `secondary_call_cleanup: ${reason}`
          }
        });
      }


      if (call.playbackFailedHandler && this.client) {
        this.client.removeListener('PlaybackFailed' as any, call.playbackFailedHandler);
        call.playbackFailedHandler = null;
      }
      if (call.waitingPlaybackFailedHandler && this.client) {
        this.client.removeListener('PlaybackFailed' as any, call.waitingPlaybackFailedHandler);
        call.waitingPlaybackFailedHandler = null;
      }

      this._clearCallTimers(call);

      if (call.openAIStreamingActive || call.isOpenAIStreamEnding) {
        call.callLogger.info(`Stopping OpenAI session due to cleanup.`);
        try {
          sessionManager.stopOpenAISession(callId, `cleanup_${reason}`);
        } catch (e:any) { call.callLogger.error(`Error stopping OpenAI session during cleanup: ${e.message}`); }
      }
      call.openAIStreamingActive = false;
      call.isOpenAIStreamEnding = true;

      await this.cleanupCallResources(callId, hangupMainChannel, false, call.callLogger);

    } else {
      moduleLogger.warn(`_fullCleanup called for non-existent callId: ${callId}`);
    }
  }
  private async cleanupCallResources(channelId: string, hangupChannel: boolean = false, isAriClosing: boolean = false, loggerInstance?: LoggerInstance ): Promise<void> {
    const call = this.activeCalls.get(channelId);
    const resolvedLogger = loggerInstance || this.logger.child({ callId: channelId, context: 'cleanupCallResources' });

    resolvedLogger.info(`Starting cleanupCallResources.`);

    if (call?.rtpServer) {
      resolvedLogger.info(`Stopping RTP server.`);
      try { await call.rtpServer.stop(); }
      catch (e:any) { resolvedLogger.error(`Error stopping RTP server: ${e.message}`); }
      call.rtpServer = undefined;
    }

    const channelsToHangup: (Channel | undefined)[] = [];
    if (call?.snoopChannel) {
      resolvedLogger.info(`Cleaning up snoopChannel ${call.snoopChannel.id}.`);
      if (!isAriClosing) { channelsToHangup.push(call.snoopChannel); }
      this.appOwnedChannelIds.delete(call.snoopChannel.id);
      call.snoopChannel = undefined;
    }
    if (call?.externalMediaChannel) {
      resolvedLogger.info(`Cleaning up externalMediaChannel ${call.externalMediaChannel.id}.`);
      if (!isAriClosing) { channelsToHangup.push(call.externalMediaChannel); }
      this.appOwnedChannelIds.delete(call.externalMediaChannel.id);
      call.externalMediaChannel = undefined;
    }

    for (const ch of channelsToHangup) {
      if (ch) {
        try {
          resolvedLogger.info(`Attempting to hangup app-owned channel ${ch.id}.`);
          await ch.hangup();
          resolvedLogger.info(`Successfully hung up app-owned channel ${ch.id}.`);
        } catch (e:any) { resolvedLogger.warn(`Error hanging up app-owned channel ${ch.id}: ${e.message} (might be already hung up).`); }
      }
    }

    if (call?.snoopBridge) {
      resolvedLogger.info(`Destroying snoopBridge ${call.snoopBridge.id}.`);
      try { await call.snoopBridge.destroy(); }
      catch (e:any) { resolvedLogger.error(`Error destroying snoopBridge: ${e.message}`); }
      call.snoopBridge = undefined;
    }
    if (call?.userBridge) {
      resolvedLogger.info(`Destroying userBridge ${call.userBridge.id}.`);
      try { await call.userBridge.destroy(); }
      catch (e:any) { resolvedLogger.error(`Error destroying userBridge: ${e.message}`); }
      call.userBridge = undefined;
    }

    if (hangupChannel && call?.channel) {
      try {
        resolvedLogger.info(`Attempting to hangup main channel ${call.channel.id}.`);
        await call.channel.hangup();
        resolvedLogger.info(`Main channel ${call.channel.id} hung up successfully.`);
      } catch (e: any) {
        resolvedLogger.error(`Error hanging up main channel ${call.channel.id}: ${e.message} (might be already hung up or StasisEnd occurred).`);
      }
    }

    if (call) {
        this.activeCalls.delete(channelId);
        sessionManager.handleAriCallEnd(channelId);
        resolvedLogger.info(`Call resources fully cleaned up and removed from active sessions.`);
    } else if (!isAriClosing) {
        resolvedLogger.warn(`cleanupCallResources: No call object found for channelId ${channelId} during cleanup.`);
    }
  }
  private onAriError(err: any): void {
    this.logger.error('General ARI Client Error:', err);
   }
  private onAriClose(): void {
    this.logger.info('ARI connection closed. Cleaning up all active calls.');
    const callIds = Array.from(this.activeCalls.keys());
    for (const callId of callIds) {
        const call = this.activeCalls.get(callId);
        if (call) {
            call.callLogger.warn(`ARI connection closed, forcing cleanup for this call.`);
            this._fullCleanup(callId, true, "ARI_CONNECTION_CLOSED");
        }
    }
    this.activeCalls.clear();
    this.appOwnedChannelIds.clear();
   }
  public async playbackAudio(channelId: string, audioPayloadB64?: string | null, mediaUri?: string | null): Promise<void> {
    const call = this.activeCalls.get(channelId);
    if (!call || call.isCleanupCalled || !this.client) {
      (call?.callLogger || this.logger).warn(`Cannot playback audio for call ${channelId}, call not active or client missing.`);
      return;
    }

    let mediaToPlay: string;
    if (mediaUri) {
      mediaToPlay = mediaUri;
      call.callLogger.info(`Attempting to play audio from media URI: ${mediaUri}`);
    } else if (audioPayloadB64) {
      call.callLogger.warn(`Playing audio via base64 for call ${channelId}. Length: ${audioPayloadB64.length}. This might fail for long audio strings if not using file playback.`);
      mediaToPlay = `sound:base64:${audioPayloadB64}`;
    } else {
      call.callLogger.error(`playbackAudio called for ${channelId} without audioPayloadB64 or mediaUri.`);
      return;
    }

    try {
      if (call.waitingPlayback) {
        try {
          await call.waitingPlayback.stop();
          call.callLogger.debug(`Stopped previous waiting playback for ${channelId}.`);
        }
        catch(e:any) { call.callLogger.warn(`Error stopping previous waiting playback for ${channelId}: ${e.message}`);}
        call.waitingPlayback = undefined;
      }

      call.waitingPlayback = this.client.Playback();
      const playbackId = call.waitingPlayback.id;
      call.callLogger.debug(`Created playback object ${playbackId} for ${channelId}. Media: ${mediaToPlay.substring(0,60)}...`);

      const waitingPlaybackFinishedCb = () => {
        const currentCall = this.activeCalls.get(channelId);
        if (!currentCall) return;
        currentCall.callLogger.debug(`Playback ${playbackId} finished for ${channelId}.`);
        if(currentCall.waitingPlayback && currentCall.waitingPlayback.id === playbackId) {
          currentCall.waitingPlayback = undefined;
        }
        if (this.client && currentCall.waitingPlaybackFailedHandler) {
          this.client.removeListener('PlaybackFailed' as any, currentCall.waitingPlaybackFailedHandler);
          currentCall.waitingPlaybackFailedHandler = null;
        }
      };
      if (call.waitingPlayback) {
          call.waitingPlayback.once('PlaybackFinished', waitingPlaybackFinishedCb);
      }

      const waitingPlaybackFailedCb = (event: any, failedPlayback: Playback) => {
        if (this.client && failedPlayback.id === playbackId) {
          const currentCall = this.activeCalls.get(channelId);
          if (!currentCall) return;
          currentCall.callLogger.error(`Playback ${playbackId} FAILED for ${channelId}: ${failedPlayback?.state}, Reason: ${event?.message || (event?.playback?.reason || 'Unknown')}`);
          if(currentCall.waitingPlayback && currentCall.waitingPlayback.id === playbackId) {
            currentCall.waitingPlayback = undefined;
          }
          if (this.client && currentCall.waitingPlaybackFailedHandler === waitingPlaybackFailedCb) {
            this.client.removeListener('PlaybackFailed' as any, waitingPlaybackFailedCb);
            currentCall.waitingPlaybackFailedHandler = null;
          }
        }
      };
      call.waitingPlaybackFailedHandler = waitingPlaybackFailedCb;
      this.client.on('PlaybackFailed' as any, call.waitingPlaybackFailedHandler);

      await call.channel.play({ media: mediaToPlay }, call.waitingPlayback);
      call.callLogger.info(`Playback ${playbackId} started for ${channelId}.`);
    } catch (err: any) {
      call.callLogger.error(`Error playing audio for ${channelId}: ${err.message || JSON.stringify(err)}`);
      if (call.waitingPlayback) {
        if (call.waitingPlaybackFailedHandler && this.client) {
            this.client.removeListener('PlaybackFailed' as any, call.waitingPlaybackFailedHandler);
            call.waitingPlaybackFailedHandler = null;
        }
        call.waitingPlayback = undefined;
      }
    }
  }
  public async endCall(channelId: string): Promise<void> {
    const call = this.activeCalls.get(channelId);
    if (!call) {
      this.logger.warn(`Attempted to end non-existent call: ${channelId}`);
      return;
    }
    call.callLogger.info(`endCall invoked. Initiating full cleanup.`);
    await this._fullCleanup(channelId, true, "EXPLICIT_ENDCALL_REQUEST");
  }

  private async _playTTSToCaller(callId: string, textToSpeak: string): Promise<void> {
    const call = this.activeCalls.get(callId);
    if (!call || call.isCleanupCalled) {
      (call?.callLogger || this.logger).warn(`Cannot play TTS, call not active or cleanup called.`);
      return;
    }
    call.callLogger.info(`Requesting TTS for text: "${textToSpeak}"`);

    try {
      // @ts-ignore
      const audioBuffer = await sessionManager.synthesizeSpeechOpenAI(call.config, textToSpeak, call.callLogger); // This function might not exist or be intended for this flow.

      if (audioBuffer && audioBuffer.length > 0) {
        // This part is problematic if synthesizeSpeechOpenAI is not actually fetching audio for Realtime API.
        // The Realtime API sends audio via _onOpenAIAudioChunk.
        // This _playTTSToCaller seems like a remnant of a different TTS approach.
        call.callLogger.warn("_playTTSToCaller was invoked, but TTS audio for Realtime API should arrive via _onOpenAIAudioChunk and be handled by _onOpenAIAudioStreamEnd. This path might be deprecated or for a non-realtime TTS flow.");
        // If it *were* to play audio, it should use the file-based playback like _onOpenAIAudioStreamEnd.
        // For example, it would need to save the audioBuffer to a file (potentially as WAV) and then call this.playbackAudio(callId, null, 'sound:path/to/file').
      } else {
        call.callLogger.error(`TTS synthesis (via _playTTSToCaller) failed or returned empty audio.`);
      }
    } catch (error: any) {
      call.callLogger.error(`Error during TTS synthesis or playback (via _playTTSToCaller): ${error.message}`, error);
    }
  }
}

// Helper function to create WAV header (can be moved to a utils file if preferred)
interface WavHeaderOptions {
  numFrames: number;
  numChannels: number;
  sampleRate: number;
  bytesPerSample: number;
}

function createWavHeader(opts: WavHeaderOptions): Buffer {
  const numFrames = opts.numFrames;
  const numChannels = opts.numChannels || 1;
  const sampleRate = opts.sampleRate || 8000;
  const bytesPerSample = opts.bytesPerSample || 2; // 16-bit
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numFrames * blockAlign;

  const buffer = Buffer.alloc(44);

  // RIFF identifier
  buffer.write('RIFF', 0);
  // RIFF chunk length (36 + dataSize)
  buffer.writeUInt32LE(36 + dataSize, 4);
  // RIFF type
  buffer.write('WAVE', 8);
  // format chunk identifier
  buffer.write('fmt ', 12);
  // format chunk length
  buffer.writeUInt32LE(16, 16);
  // sample format (1 for PCM)
  buffer.writeUInt16LE(1, 20);
  // channel count
  buffer.writeUInt16LE(numChannels, 22);
  // sample rate
  buffer.writeUInt32LE(sampleRate, 24);
  // byte rate (sampleRate * blockAlign)
  buffer.writeUInt32LE(byteRate, 28);
  // block align (numChannels * bytesPerSample)
  buffer.writeUInt16LE(blockAlign, 32);
  // bits per sample (bytesPerSample * 8)
  buffer.writeUInt16LE(bytesPerSample * 8, 34);
  // data chunk identifier
  buffer.write('data', 36);
  // data chunk length (dataSize)
  buffer.writeUInt32LE(dataSize, 40);

  return buffer;
}


let ariClientServiceInstance: AriClientService | null = null;

export async function initializeAriClient(): Promise<AriClientService> {
  if (!OPENAI_API_KEY) {
      moduleLogger.error("FATAL: Cannot initialize AriClientService - OPENAI_API_KEY is not set.");
      throw new Error("OPENAI_API_KEY is not set. Server cannot start.");
  }
  if (!ariClientServiceInstance) {
    ariClientServiceInstance = new AriClientService();
    await ariClientServiceInstance.connect();
  }
  return ariClientServiceInstance;
}

export { ariClientServiceInstance };
