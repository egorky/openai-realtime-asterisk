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
import { logConversationToRedis } from './redis-client';

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
        recognitionActivationMode: "fixedDelay",
        bargeInDelaySeconds: 0.2,
        noSpeechBeginTimeoutSeconds: 5.0,
        speechEndSilenceTimeoutSeconds: 1.5,
        maxRecognitionDurationSeconds: 30.0,
        vadSilenceThresholdMs: 2500,
        vadTalkThreshold: 256,
        vadRecogActivation: "vadMode",
        vadMaxWaitAfterPromptSeconds: 10.0,
        vadInitialSilenceDelaySeconds: 0.0,
        // vadConfig is nested, ensure it's included if used by getCallSpecificConfig or other logic
        vadConfig: { vadSilenceThresholdMs: 2500, vadRecognitionActivationMs: 40 }, // Default from old structure, might need adjustment
        greetingAudioPath: 'sound:hello-world', // Keep or make optional
      },
      dtmfConfig: {
        enableDtmfRecognition: true,
        dtmfInterDigitTimeoutSeconds: 3.0,
        dtmfFinalTimeoutSeconds: 5.0,
        // Fields from old DtmfConfig that might be expected by getCallSpecificConfig
        dtmfMaxDigits: 16,
        dtmfTerminatorDigit: "#"
      },
      // bargeInConfig might be obsolete or its properties merged into appRecognitionConfig
      bargeInConfig: { bargeInModeEnabled: true, bargeInDelaySeconds: 0.2, noSpeechBargeInTimeoutSeconds: 5.0 }, // Retain structure if getCallSpecificConfig expects it
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

  const formatLogMessage = (level: string, bindings: any, ...args: any[]): void => {
    if (!loggerInstance.isLevelEnabled(level, bindings.configOverride)) {
      return;
    }

    const timestamp = new Date().toISOString();
    // Try to get callerId from bindings first (for child loggers), then from activeCalls map.
    let effectiveCallId = bindings.callId || 'System'; // This is the Asterisk Channel ID / UNIQUEID
    let displayCallerId = bindings.callerId || 'N/A'; // This is the Caller's Number (e.g., CNUM)

    if (bindings.callId && ariClientServiceInstance) {
        const call = ariClientServiceInstance.getActiveCallResource(bindings.callId);
        if (call && call.channel) {
            effectiveCallId = call.channel.id; // Ensure we use the actual channel ID from the resource
            if (call.channel.caller && call.channel.caller.number) {
                displayCallerId = call.channel.caller.number;
            } else if (displayCallerId === 'N/A') { // If no callerId was bound and no CNUM
                displayCallerId = call.channel.name; // Fallback to channel name for displayCallerId
            }
        }
    }

    const prefixParts: string[] = [];
    if (bindings.service) prefixParts.push(`service=${bindings.service}`);
    if (bindings.component) prefixParts.push(`component=${bindings.component}`);

    // Construct the main log prefix with timestamp, the channel's UNIQUEID (effectiveCallId), and the displayCallerId (CNUM or name)
    const mainPrefix = `[${timestamp}] [uid:${effectiveCallId}] [cnum:${displayCallerId}]`;
    const contextPrefix = prefixParts.length > 0 ? ` [${prefixParts.join(' ')}]` : ''; // Keep this for additional context like service/component

    let logFunction: (...args: any[]) => void;
    switch (level) {
      case 'silly':
        logFunction = console.debug; // console.silly is not standard, using debug for it or log
        break;
      case 'debug':
        logFunction = console.debug;
        break;
      case 'warn':
        logFunction = console.warn;
        break;
      case 'error':
        logFunction = console.error;
        break;
      case 'info':
      default:
        logFunction = console.info;
        break;
    }

    if (args.length > 0 && typeof args[0] === 'string') {
      logFunction(`${mainPrefix}${contextPrefix} ${args[0]}`, ...args.slice(1));
    } else {
      logFunction(`${mainPrefix}${contextPrefix}`, ...args);
    }
  };

  (['info', 'error', 'warn', 'debug', 'silly'] as const).forEach(levelKey => {
    loggerInstance[levelKey] = (...args: any[]) => {
      // For top-level logger, bindings are empty or minimal.
      // Pass along an empty object for bindings, formatLogMessage will handle defaults.
      formatLogMessage(levelKey, {}, ...args);
    };
  });

  loggerInstance.child = (bindings: object, callSpecificLogLevel?: string): LoggerInstance => {
    const childLogger: any = {};
    const currentBindings = { ...bindings } as any; // Current bindings for this child instance

    if (callSpecificLogLevel) {
        currentBindings.configOverride = { logging: { level: callSpecificLogLevel } } as CallSpecificConfig;
    }

    childLogger.isLevelEnabled = (level: string): boolean => {
      const levelsMap: { [key: string]: number } = { silly: 0, debug: 1, info: 2, warn: 3, error: 4 };
      // Use currentBindings.configOverride for level checking for this specific child logger
      const effectiveCallLogLevel = callSpecificLogLevel || getEffectiveLogLevel(currentBindings.configOverride);
      const configuredLevelNum = levelsMap[effectiveCallLogLevel] ?? levelsMap.info;
      return levelsMap[level] >= configuredLevelNum;
    };

    (['info', 'error', 'warn', 'debug', 'silly'] as const).forEach(levelKey => {
      childLogger[levelKey] = (...args: any[]) => {
        // Pass currentBindings to formatLogMessage
        formatLogMessage(levelKey, currentBindings, ...args);
      };
    });

    childLogger.child = (newChildBindings: object, newChildCallSpecificLogLevel?: string): LoggerInstance => {
      // When creating a child of a child, merge new bindings with the current child's bindings.
      const mergedBindings = {...currentBindings, ...newChildBindings};
      // The new child's log level takes precedence; otherwise, it inherits from its direct parent (this childLogger).
      return loggerInstance.child(mergedBindings, newChildCallSpecificLogLevel || callSpecificLogLevel);
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

  // Update arc with new/renamed environment variables
  arc.recognitionActivationMode = getVar(logger, channel, 'RECOGNITION_ACTIVATION_MODE', arc.recognitionActivationMode) as "fixedDelay" | "Immediate" | "vad" || "fixedDelay";
  arc.bargeInDelaySeconds = getVarAsFloat(logger, channel, 'BARGE_IN_DELAY_SECONDS', arc.bargeInDelaySeconds) ?? 0.2;
  arc.noSpeechBeginTimeoutSeconds = getVarAsFloat(logger, channel, 'NO_SPEECH_BEGIN_TIMEOUT_SECONDS', arc.noSpeechBeginTimeoutSeconds) ?? 5.0;
  // SPEECH_END_SILENCE_TIMEOUT_SECONDS maps to speechEndSilenceTimeoutSeconds
  arc.speechEndSilenceTimeoutSeconds = getVarAsFloat(logger, channel, 'SPEECH_END_SILENCE_TIMEOUT_SECONDS', arc.speechEndSilenceTimeoutSeconds) ?? 1.5;
  arc.maxRecognitionDurationSeconds = getVarAsFloat(logger, channel, 'MAX_RECOGNITION_DURATION_SECONDS', arc.maxRecognitionDurationSeconds) ?? 30.0;

  // VAD specific variables
  arc.vadSilenceThresholdMs = getVarAsInt(logger, channel, 'APP_APPRECOGNITION_VADSILENCETHRESHOLDMS', arc.vadSilenceThresholdMs) ?? 2500;
  arc.vadTalkThreshold = getVarAsInt(logger, channel, 'APP_APPRECOGNITION_VADTALKTHRESHOLD', arc.vadTalkThreshold) ?? 256;
  arc.vadRecogActivation = getVar(logger, channel, 'APP_APPRECOGNITION_VADRECOGACTIVATION', arc.vadRecogActivation) as "vadMode" | "afterPrompt" || "vadMode";
  arc.vadMaxWaitAfterPromptSeconds = getVarAsFloat(logger, channel, 'APP_APPRECOGNITION_VADMAXWAITAFTERPROMPTSECONDS', arc.vadMaxWaitAfterPromptSeconds) ?? 10.0;
  arc.vadInitialSilenceDelaySeconds = getVarAsFloat(logger, channel, 'APP_APPRECOGNITION_VADINITIALSILENCEDELAYSECONDS', arc.vadInitialSilenceDelaySeconds) ?? 0.0;

  // Keep existing greeting audio logic
  const initialGreetingEnv = getVar(logger, channel, 'INITIAL_GREETING_AUDIO_PATH', undefined);
  const greetingEnv = getVar(logger, channel, 'GREETING_AUDIO_PATH', undefined);
  if (initialGreetingEnv !== undefined) { arc.greetingAudioPath = initialGreetingEnv; }
  else if (greetingEnv !== undefined) { arc.greetingAudioPath = greetingEnv; }
  else if (baseConfig.appConfig.appRecognitionConfig.greetingAudioPath !== undefined) { arc.greetingAudioPath = baseConfig.appConfig.appRecognitionConfig.greetingAudioPath; }
  else { arc.greetingAudioPath = 'sound:hello-world'; }

  // Ensure vadConfig (nested) is populated for TALK_DETECT, using new parent values
  arc.vadConfig = arc.vadConfig || { vadSilenceThresholdMs: 2500, vadRecognitionActivationMs: 40 }; // Default values if not set
  // APP_APPRECOGNITION_VADSILENCETHRESHOLDMS maps to vadConfig.vadSilenceThresholdMs for TALK_DETECT
  arc.vadConfig.vadSilenceThresholdMs = arc.vadSilenceThresholdMs; // Use the value from the parent arc
  // APP_APPRECOGNITION_VADTALKTHRESHOLD might map to vadConfig.vadRecognitionActivationMs if it represents the energy threshold for Asterisk's TALK_DETECT activation
  // For now, we'll use a default or an existing env var if one was intended for vadRecognitionActivationMs
  // VAD_TALK_THRESHOLD_MS was used for vadRecognitionActivationMs. Let's check if APP_APPRECOGNITION_VADTALKTHRESHOLD should be used instead.
  // The problem description maps APP_APPRECOGNITION_VADTALKTHRESHOLD to "Asterisk TALK_DETECT energy level threshold".
  // The existing code used VAD_TALK_THRESHOLD_MS for vadConfig.vadRecognitionActivationMs.
  // It seems vadRecognitionActivationMs in VadConfig was more about the *duration* of speech to trigger, not energy.
  // The new vadTalkThreshold is an energy level. TALK_DETECT uses {talk_threshold},{silence_threshold[,direction]}
  // So, vadConfig.vadRecognitionActivationMs should probably be a duration, and vadTalkThreshold is the energy level.
  // Let's assume vadConfig.vadRecognitionActivationMs is a fixed duration or another env var if needed.
  // For now, keep the old logic for vadRecognitionActivationMs if no new direct mapping.
  arc.vadConfig.vadRecognitionActivationMs = getVarAsInt(logger, channel, 'VAD_TALK_DURATION_THRESHOLD_MS', arc.vadConfig.vadRecognitionActivationMs) ?? 40; // Example, assuming a duration.

  const dtmfConf = currentCallSpecificConfig.appConfig.dtmfConfig = currentCallSpecificConfig.appConfig.dtmfConfig || {} as DtmfConfig;
  // Update dtmfConf with new/renamed environment variables
  dtmfConf.enableDtmfRecognition = getVarAsBoolean(logger, channel, 'DTMF_ENABLED', dtmfConf.enableDtmfRecognition) ?? true;
  dtmfConf.dtmfInterDigitTimeoutSeconds = getVarAsFloat(logger, channel, 'DTMF_INTERDIGIT_TIMEOUT_SECONDS', dtmfConf.dtmfInterDigitTimeoutSeconds) ?? 3.0;
  dtmfConf.dtmfFinalTimeoutSeconds = getVarAsFloat(logger, channel, 'DTMF_FINAL_TIMEOUT_SECONDS', dtmfConf.dtmfFinalTimeoutSeconds) ?? 5.0;
  // Keep existing DTMF properties if they are still used
  dtmfConf.dtmfMaxDigits = getVarAsInt(logger, channel, 'DTMF_MAX_DIGITS', dtmfConf.dtmfMaxDigits) ?? 16;
  dtmfConf.dtmfTerminatorDigit = getVar(logger, channel, 'DTMF_TERMINATOR_DIGIT', dtmfConf.dtmfTerminatorDigit) ?? "#";

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
  public logger: LoggerInstance;
  private currentPrimaryCallId: string | null = null;

  constructor() {
    this.logger = moduleLogger.child({ service: 'AriClientService' });
    if (!baseConfig) { throw new Error("Base configuration was not loaded."); }
  }

  // Method to get a call resource, used by the logger
  public getActiveCallResource(callId: string): CallResources | undefined {
    return this.activeCalls.get(callId);
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
    // For 'fixedDelay' and 'Immediate' modes, OpenAI dictates speech end.
    // For 'vad' mode, local VAD (TALK_DETECT) might have already stopped the stream if Asterisk detected silence.
    // The speechEndSilenceTimer here is primarily for OpenAI's own speech detection.
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

    // Barge-in logic: If prompt is playing and we get an interim result, stop the prompt.
    // This applies to all modes if a prompt is active.
    // The fixedDelay mode already has a specific bargeInDelaySeconds before starting OpenAI.
    // If barge-in happens *during* the prompt before that delay, this handles it.
    if (call.mainPlayback && !call.promptPlaybackStoppedForInterim) {
        // Check if barge-in is generally enabled (e.g. via a new top-level config or implied by mode)
        // For now, assume barge-in is desirable if a prompt is playing and speech is detected by OpenAI.
        call.callLogger.info(`Stopping main prompt due to OpenAI interim transcript (barge-in).`);
        this._stopAllPlaybacks(call).catch(e => call.callLogger.error(`Error stopping playback on interim: ` + (e instanceof Error ? e.message : String(e))));
        call.promptPlaybackStoppedForInterim = true;
    }

    if (call.speechEndSilenceTimer) clearTimeout(call.speechEndSilenceTimer);
    // Use the new speechEndSilenceTimeoutSeconds
    const silenceTimeout = (call.config.appConfig.appRecognitionConfig.speechEndSilenceTimeoutSeconds ?? 1.5) * 1000;
    call.speechEndSilenceTimer = setTimeout(() => {
      if (call.isCleanupCalled || !call.openAIStreamingActive) return;
      call.callLogger.warn(`OpenAI: Silence detected for ${silenceTimeout}ms after interim transcript. Stopping OpenAI session for this turn.`);
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

    // Log caller's transcript to Redis
    logConversationToRedis(callId, {
      actor: 'caller',
      type: 'transcript',
      content: transcript,
    }).catch(e => call.callLogger.error(`RedisLog Error (caller transcript): ${e.message}`));

    try {
      sessionManager.requestOpenAIResponse(callId, transcript, call.config);
    } catch (e: any) {
      call.callLogger.error(`Error calling sessionManager.requestOpenAIResponse: ${e.message}`, e);
      logConversationToRedis(callId, { // Log error if request fails
        actor: 'system',
        type: 'error_message',
        content: `Failed to request OpenAI response: ${e.message}`
      }).catch(redisErr => call.callLogger.error(`RedisLog Error (OpenAI request fail): ${redisErr.message}`));
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

        // Attempt to get the text transcript of what's about to be played.
        // This relies on call.finalTranscription being the bot's textual response if available.
        // Or a more robust way if the bot's text response is stored elsewhere before TTS generation.
        let ttsSpokenText = call.finalTranscription; // Assumes this holds the bot's text response.
                                                 // This might be incorrect if finalTranscription is the user's last speech.
                                                 // Needs a reliable way to get the bot's text response.
        if (!ttsSpokenText) {
            // A more reliable way to get the text that was synthesized is needed.
            // For now, we'll use a placeholder.
            // One approach: store the text that was sent for TTS generation in the CallResources.
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
          await this.playbackAudio(callId, null, `sound:${soundPathForPlayback}`);
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

  public _onOpenAIError(callId: string, error: any): void {
    const call = this.activeCalls.get(callId);
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
    this._fullCleanup(callId, true, "OPENAI_STREAM_ERROR");
  }

  public _onOpenAISessionEnded(callId: string, reason: string): void {
    const call = this.activeCalls.get(callId);
    if (!call || call.isCleanupCalled) return;
    call.callLogger.info(`OpenAI session ended event from sessionManager. Reason: ${reason}`);
    logConversationToRedis(callId, { actor: 'system', type: 'system_message', content: `OpenAI session ended. Reason: ${reason}`})
      .catch(e => call.callLogger.error(`RedisLog Error (OpenAI session ended): ${e.message}`));
    call.openAIStreamingActive = false;

    if (call.noSpeechBeginTimer) { clearTimeout(call.noSpeechBeginTimer); call.noSpeechBeginTimer = null; }
    if (call.initialOpenAIStreamIdleTimer) { clearTimeout(call.initialOpenAIStreamIdleTimer); call.initialOpenAIStreamIdleTimer = null; }
    if (call.speechEndSilenceTimer) { clearTimeout(call.speechEndSilenceTimer); call.speechEndSilenceTimer = null; }

    if (!call.finalTranscription && !call.openAIStreamError && !call.dtmfModeActive) {
        call.callLogger.warn(`OpenAI session ended (reason: ${reason}) without final transcript, error, or DTMF. Call may continue or timeout, or new turn logic might apply.`);
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
    call.dtmfModeActive = true; // Mark that DTMF is now the primary input mode
    call.speechRecognitionDisabledDueToDtmf = true; // Disable speech recognition

    // Stop any ongoing VAD buffering or pending flushes
    call.isVADBufferingActive = false;
    call.vadAudioBuffer = [];
    call.pendingVADBufferFlush = false;
    call.isFlushingVADBuffer = false;

    // Stop all current audio playbacks (prompts, TTS)
    await this._stopAllPlaybacks(call);
    call.promptPlaybackStoppedForInterim = true; // Consider prompt stopped due to DTMF

    // Stop any active OpenAI streaming session
    if (call.openAIStreamingActive) {
      call.callLogger.info(`DTMF: Interrupting active OpenAI stream for call ${call.channel.id}.`);
      call.dtmfInterruptedSpeech = true; // Mark that DTMF interrupted an ongoing speech session
      sessionManager.stopOpenAISession(call.channel.id, 'dtmf_interrupt');
      call.openAIStreamingActive = false;
    }

    // Clear all recognition-related timers (speech, VAD, barge-in)
    // Explicitly clear timers that DTMF should override.
    if (call.noSpeechBeginTimer) { clearTimeout(call.noSpeechBeginTimer); call.noSpeechBeginTimer = null; }
    if (call.initialOpenAIStreamIdleTimer) { clearTimeout(call.initialOpenAIStreamIdleTimer); call.initialOpenAIStreamIdleTimer = null; }
    if (call.speechEndSilenceTimer) { clearTimeout(call.speechEndSilenceTimer); call.speechEndSilenceTimer = null; }
    call.speechHasBegun = false; // Reset speech detection flag

    if (call.vadMaxWaitAfterPromptTimer) { clearTimeout(call.vadMaxWaitAfterPromptTimer); call.vadMaxWaitAfterPromptTimer = null; }
    // vadActivationDelayTimer was removed, but if similar logic exists, clear it.
    if (call.vadInitialSilenceDelayTimer) { clearTimeout(call.vadInitialSilenceDelayTimer); call.vadInitialSilenceDelayTimer = null; }
    if (call.bargeInActivationTimer) { clearTimeout(call.bargeInActivationTimer); call.bargeInActivationTimer = null; }

    // If VAD mode was active, remove TALK_DETECT as DTMF takes precedence
    if (call.config.appConfig.appRecognitionConfig.recognitionActivationMode === 'vad') {
        try {
            call.callLogger.info(`DTMF: Removing TALK_DETECT from channel ${channel.id} as DTMF is now active.`);
            await channel.setChannelVar({ variable: 'TALK_DETECT(remove)', value: 'true' });
        } catch (e: any) {
            call.callLogger.warn(`DTMF: Error removing TALK_DETECT from channel ${channel.id}: ${e.message}`);
        }
    }

    // Append the received digit
    call.collectedDtmfDigits += event.digit;
    call.callLogger.info(`Collected DTMF for call ${call.channel.id}: ${call.collectedDtmfDigits}`);

    // (Re)start the inter-digit timer
    if (call.dtmfInterDigitTimer) clearTimeout(call.dtmfInterDigitTimer);
    const interDigitTimeoutMs = (dtmfConfig.dtmfInterDigitTimeoutSeconds) * 1000;
    call.dtmfInterDigitTimer = setTimeout(() => {
      if (call.isCleanupCalled || !call.dtmfModeActive) return;
      call.callLogger.info(`DTMF inter-digit timeout for call ${call.channel.id}. Digits: '${call.collectedDtmfDigits}'. Finalizing.`);
      this._finalizeDtmfInput(call.channel.id, "DTMF_INTERDIGIT_TIMEOUT");
    }, interDigitTimeoutMs);

    // (Re)start the final DTMF timeout (if it's different or used as an overall max)
    // The problem description has dtmfFinalTimeoutSeconds. This should be the timeout after the *last* digit if no new digit comes.
    // The interDigitTimeout handles time between digits. If interDigit expires, it's considered final.
    // Let's use dtmfFinalTimeoutSeconds as the one that triggers if interDigitTimeout keeps getting reset by new digits,
    // but then a longer pause occurs.
    if (call.dtmfFinalTimer) clearTimeout(call.dtmfFinalTimer);
    const finalTimeoutMs = (dtmfConfig.dtmfFinalTimeoutSeconds) * 1000;
    call.dtmfFinalTimer = setTimeout(() => {
      if (call.isCleanupCalled || !call.dtmfModeActive) return;
      call.callLogger.info(`DTMF final timeout for call ${call.channel.id}. Digits: '${call.collectedDtmfDigits}'. Finalizing.`);
      this._finalizeDtmfInput(call.channel.id, "DTMF_FINAL_TIMEOUT");
    }, finalTimeoutMs);

    // Check for terminator digit or max digits
    const maxDigits = dtmfConfig.dtmfMaxDigits ?? 16; // Default if not in new config, but it was in old.
    const terminatorDigit = dtmfConfig.dtmfTerminatorDigit ?? "#"; // Default if not in new config.

    if (event.digit === terminatorDigit) {
      call.callLogger.info(`DTMF terminator digit '${terminatorDigit}' received for call ${call.channel.id}. Finalizing.`);
      this._finalizeDtmfInput(call.channel.id, "DTMF_TERMINATOR_RECEIVED");
    } else if (call.collectedDtmfDigits.length >= maxDigits) {
      call.callLogger.info(`Max DTMF digits (${maxDigits}) reached for call ${call.channel.id}. Finalizing.`);
      this._finalizeDtmfInput(call.channel.id, "DTMF_MAX_DIGITS_REACHED");
    }
  }

  private async _finalizeDtmfInput(callId: string, reason: string): Promise<void> {
    const call = this.activeCalls.get(callId);
    if (!call || call.isCleanupCalled || !call.dtmfModeActive) {
      if (call && !call.dtmfModeActive) {
        call.callLogger.debug(`_finalizeDtmfInput called for ${callId} but DTMF mode no longer active. Reason: ${reason}. Ignoring.`);
      }
      return;
    }

    call.callLogger.info(`Finalizing DTMF input for call ${callId}. Reason: ${reason}. Collected digits: '${call.collectedDtmfDigits}'`);

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

    this._fullCleanup(call.channel.id, false, reason);
  }

  private async _activateOpenAIStreaming(callId: string, reason: string): Promise<void> {
    const call = this.activeCalls.get(callId);

    // Ensure call object exists before proceeding
    if (!call) {
      this.logger.error(`_activateOpenAIStreaming: Call object not found for callId ${callId}. Cannot activate stream. Reason: ${reason}`);
      return;
    }

    // If already streaming and this is not just a buffer flush attempt, log and return.
    if (call.openAIStreamingActive && reason !== "vad_speech_during_delay_window_flush_attempt") {
        call.callLogger.debug(`_activateOpenAIStreaming called (Reason: ${reason}), but stream already active. No action.`);
        return;
    }
    // If cleanup is called, abort.
    if (call.isCleanupCalled) {
        call.callLogger.warn(`_activateOpenAIStreaming called (Reason: ${reason}), but cleanup already in progress. Aborting activation.`);
        return;
    }

    call.callLogger.info(`_activateOpenAIStreaming called. Reason: ${reason}. Current stream active: ${call.openAIStreamingActive}`);

    try {
      // sessionManager.startOpenAISession will now ensure a session is active,
      // or start a new one if necessary. It won't close an existing healthy session.
      await sessionManager.startOpenAISession(callId, this, call.config);
      call.callLogger.info(`Session manager ensured OpenAI session is active for ${callId}.`);

      // Mark as active only after successful session start/confirmation.
      // This is important because startOpenAISession might return if session is already open.
      call.openAIStreamingActive = true;

      if (call.pendingVADBufferFlush && call.vadAudioBuffer.length > 0) {
        call.callLogger.info(`Flushing ${call.vadAudioBuffer.length} VAD audio packets to OpenAI.`);
        call.isVADBufferingActive = false; // Stop further buffering
        for (const audioPayload of call.vadAudioBuffer) {
          sessionManager.sendAudioToOpenAI(callId, audioPayload);
        }
        call.vadAudioBuffer = [];
        call.pendingVADBufferFlush = false; // Explicitly reset after attempted flush
        call.isFlushingVADBuffer = false;
      } else {
        // If no flush was performed (e.g. buffer empty or pendingVADBufferFlush was false),
        // still ensure these flags are correctly set for subsequent audio sending.
        call.pendingVADBufferFlush = false;
        call.isFlushingVADBuffer = false;
        // isVADBufferingActive should be false if we are now actively streaming to OpenAI for recognition,
        // unless a specific VAD mode requires it to remain true for some other reason (currently not the case).
        // It's typically set to true before playing TTS to buffer barge-in speech.
        // When _activateOpenAIStreaming is called, VAD has done its job of detection or delay period is over.
        call.isVADBufferingActive = false;
      }

      // Only set up these timers if we are truly starting a new listening phase for this turn,
      // not if we are just flushing a buffer to an already active stream that might be processing prior audio.
      // The 'reason' can help differentiate.
      // If speechHasBegun is already true for this turn, these timers might not be needed or should be re-evaluated.
      if (!call.speechHasBegun) { // Timers are for the start of user speech detection in a turn
        const noSpeechTimeout = call.config.appConfig.appRecognitionConfig.noSpeechBeginTimeoutSeconds;
        if (noSpeechTimeout > 0) {
          if (call.noSpeechBeginTimer) clearTimeout(call.noSpeechBeginTimer);
          call.noSpeechBeginTimer = setTimeout(() => {
            if (call.isCleanupCalled || call.speechHasBegun) return;
            call.callLogger.warn(`No speech detected by OpenAI in ${noSpeechTimeout}s. Stopping session & call.`);
            logConversationToRedis(callId, { actor: 'system', type: 'system_message', content: `No speech from OpenAI timeout (${noSpeechTimeout}s).`})
              .catch(e => call.callLogger.error(`RedisLog Error: ${e.message}`));
            sessionManager.stopOpenAISession(callId, "no_speech_timeout_in_ari");
            this._fullCleanup(callId, true, "NO_SPEECH_BEGIN_TIMEOUT");
          }, noSpeechTimeout * 1000);
          call.callLogger.info(`NoSpeechBeginTimer started (${noSpeechTimeout}s).`);
        }

        const streamIdleTimeout = call.config.appConfig.appRecognitionConfig.initialOpenAIStreamIdleTimeoutSeconds ?? 10;
        if (streamIdleTimeout > 0) {
            if (call.initialOpenAIStreamIdleTimer) clearTimeout(call.initialOpenAIStreamIdleTimer);
            call.initialOpenAIStreamIdleTimer = setTimeout(() => {
               if (call.isCleanupCalled || call.speechHasBegun) return;
               call.callLogger.warn(`OpenAI stream idle (no events) for ${streamIdleTimeout}s. Stopping session & call.`);
               logConversationToRedis(callId, { actor: 'system', type: 'system_message', content: `OpenAI stream idle timeout (${streamIdleTimeout}s).`})
                 .catch(e => call.callLogger.error(`RedisLog Error: ${e.message}`));
               sessionManager.stopOpenAISession(callId, "initial_stream_idle_timeout_in_ari");
               this._fullCleanup(callId, true, "OPENAI_STREAM_IDLE_TIMEOUT");
            }, streamIdleTimeout * 1000);
            call.callLogger.info(`InitialOpenAIStreamIdleTimer started (${streamIdleTimeout}s).`);
        }
      } else {
        call.callLogger.info(`Speech already begun for this turn, not starting NoSpeechBeginTimer or InitialOpenAIStreamIdleTimer.`);
      }

    } catch (error: any) {
        call.callLogger.error(`Error during _activateOpenAIStreaming for ${callId} (reason: ${reason}): ${(error instanceof Error ? error.message : String(error))}`);
        logConversationToRedis(callId, { actor: 'system', type: 'error_message', content: `Error activating OpenAI stream: ${error.message}`})
          .catch(e => call.callLogger.error(`RedisLog Error: ${e.message}`));
        call.openAIStreamingActive = false; // Ensure it's marked inactive on error
        this._onOpenAIError(callId, error); // This will also trigger cleanup
    }
  }

  private _handleVADDelaysCompleted(callId: string): void {
    const call = this.activeCalls.get(callId);
    if (!call || call.isCleanupCalled ||
        call.config.appConfig.appRecognitionConfig.recognitionActivationMode !== 'vad' ||
        call.config.appConfig.appRecognitionConfig.vadRecogActivation !== 'vadMode') {
      return;
    }
    call.callLogger.debug(`VAD (vadMode) delays completed. InitialSilence: ${call.vadInitialSilenceDelayCompleted}, vadInitialSilenceDelaySeconds: ${call.config.appConfig.appRecognitionConfig.vadInitialSilenceDelaySeconds}s completed.`);
    // Note: vadActivationDelaySeconds was removed from new config structure, so only vadInitialSilenceDelaySeconds is checked.

    if (call.vadInitialSilenceDelayCompleted) { // Only one delay now
      call.callLogger.info(`VAD (vadMode): Initial silence delay completed.`);
      if (call.vadRecognitionTriggeredAfterInitialDelay || call.openAIStreamingActive) {
          call.callLogger.debug(`VAD (vadMode): Stream already active or VAD triggered. No action needed from delay completion.`);
          return;
      }

      if (call.vadSpeechActiveDuringDelay) {
        call.callLogger.info(`VAD (vadMode): Speech was detected *during* the initial silence delay. Activating OpenAI stream now.`);
        // Mark that VAD has triggered recognition because speech happened during the window where we would have ignored it
        // but now the window is over, so we act on it.
        call.vadRecognitionTriggeredAfterInitialDelay = true;
        call.pendingVADBufferFlush = true; // Ensure buffered audio is sent
        call.isFlushingVADBuffer = true;  // Indicate we are now flushing
        this._activateOpenAIStreaming(callId, "vad_speech_during_delay_window_flush_attempt");

        // TALK_DETECT should already be active. Once OpenAI stream is active, we might remove it,
        // or let OpenAI's own VAD take over. The current _activateOpenAIStreaming does not remove it.
        // It's removed in _onChannelTalkingStarted after it triggers.
        // If speech occurred *during* delay, TALK_DETECT hasn't triggered _onChannelTalkingStarted yet for *this* speech segment to remove itself.
        // So, we might need to remove it here if we are activating the stream based on vadSpeechActiveDuringDelay.
        if(call.channel) {
            call.callLogger.info(`VAD (vadMode): Removing TALK_DETECT as stream is activating due to speech during delay.`);
            call.channel.setChannelVar({ variable: 'TALK_DETECT(remove)', value: 'true' })
                .catch(e => call.callLogger.warn(`VAD (vadMode): Error removing TALK_DETECT: ${e.message}`));
        }
      } else {
        call.callLogger.info(`VAD (vadMode): Initial silence delay completed, no prior speech detected during delay. TALK_DETECT is active and listening.`);
        // TALK_DETECT was set up in onStasisStart. Now we just wait for ChannelTalkingStarted.
        // Start vadMaxWaitAfterPromptTimer to prevent indefinite waiting if no speech ever occurs.
        const maxWait = call.config.appConfig.appRecognitionConfig.vadMaxWaitAfterPromptSeconds;
        if (maxWait > 0 && !call.openAIStreamingActive && !call.vadRecognitionTriggeredAfterInitialDelay) {
            if(call.vadMaxWaitAfterPromptTimer) clearTimeout(call.vadMaxWaitAfterPromptTimer);
            call.vadMaxWaitAfterPromptTimer = setTimeout(() => {
                if (call.isCleanupCalled || call.openAIStreamingActive || call.vadRecognitionTriggeredAfterInitialDelay) return;
                call.callLogger.warn(`VAD (vadMode): Max wait ${maxWait}s for speech (post-initial-delay) reached. Ending call.`);
                if(call.channel) { call.channel.setChannelVar({ variable: 'TALK_DETECT(remove)', value: 'true' }).catch(e => call.callLogger.warn(`VAD: Error removing TALK_DETECT on timeout: ${e.message}`)); }
                this._fullCleanup(callId, true, "VAD_MODE_MAX_WAIT_POST_INITIAL_DELAY_TIMEOUT");
            }, maxWait * 1000);
            call.callLogger.info(`VAD (vadMode): Started max wait timer (${maxWait}s) for speech to begin after initial delay.`);
        }
      }
    }
  }

  private _handlePostPromptVADLogic(callId: string): void {
    const call = this.activeCalls.get(callId);
    if (!call || call.isCleanupCalled || call.config.appConfig.appRecognitionConfig.recognitionActivationMode !== 'vad') {
      return;
    }
    const appRecogConf = call.config.appConfig.appRecognitionConfig;
    call.callLogger.info(`VAD: Handling post-prompt logic for vadRecogActivation: '${appRecogConf.vadRecogActivation}'.`);

    // This function is called when a prompt finishes (or if no prompt was played).
    // TALK_DETECT should have been set in onStasisStart for 'vad' mode.

    if (appRecogConf.vadRecogActivation === 'afterPrompt') {
      if (call.vadRecognitionTriggeredAfterInitialDelay || call.openAIStreamingActive) {
        call.callLogger.debug(`VAD (afterPrompt): Stream already active or VAD triggered. No action from post-prompt logic.`);
        return;
      }

      // Check if speech was detected *during* the prompt playback (call.vadSpeechDetected would be true if ChannelTalkingStarted fired)
      if (call.vadSpeechDetected) {
        call.callLogger.info(`VAD (afterPrompt): Speech was detected *during* the prompt. Activating OpenAI stream now.`);
        call.vadRecognitionTriggeredAfterInitialDelay = true; // Mark VAD has triggered
        this._activateOpenAIStreaming(callId, "vad_afterPrompt_speech_during_prompt_playback");
        call.pendingVADBufferFlush = true; // VAD buffering might have occurred

        // Remove TALK_DETECT as OpenAI stream is now active.
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
            this._fullCleanup(callId, true, "VAD_AFTERPROMPT_MAX_WAIT_TIMEOUT");
          }, maxWait * 1000);
        } else {
            call.callLogger.info(`VAD (afterPrompt): Max wait is 0 and no speech during prompt. Ending call as per logic (or this implies immediate listen without timeout). Assuming listen without timeout if 0.`);
            // If maxWait is 0, it means listen indefinitely or rely on other timeouts like maxRecognitionDuration.
            // For clarity, we won't end the call here if maxWait is 0. TALK_DETECT remains active.
        }
      }
    } else if (appRecogConf.vadRecogActivation === 'vadMode') {
      // This function (_handlePostPromptVADLogic) is typically called after a prompt.
      // In 'vadMode', the main VAD logic (initial delays, etc.) is handled by _handleVADDelaysCompleted.
      // If a prompt *was* played in 'vadMode', this function call might be redundant or a fallback.
      // The key is that TALK_DETECT is already active from onStasisStart.
      // If vadInitialSilenceDelay has passed and no speech yet, vadMaxWaitAfterPromptSeconds might apply.
      call.callLogger.info(`VAD (vadMode): Post-prompt logic invoked. Initial silence delay should have been handled. TALK_DETECT is active.`);
      if (!call.openAIStreamingActive && !call.vadRecognitionTriggeredAfterInitialDelay && call.vadInitialSilenceDelayCompleted) {
          const maxWait = appRecogConf.vadMaxWaitAfterPromptSeconds;
          if (maxWait > 0 && !call.vadMaxWaitAfterPromptTimer) { // Start timer only if not already running
              call.vadMaxWaitAfterPromptTimer = setTimeout(() => {
                  if (call.isCleanupCalled || call.openAIStreamingActive || call.vadRecognitionTriggeredAfterInitialDelay) return;
                  call.callLogger.warn(`VAD (vadMode): Max wait ${maxWait}s for speech (after prompt/initial delays) reached. Ending call.`);
                  if(call.channel) { call.channel.setChannelVar({ variable: 'TALK_DETECT(remove)', value: 'true' }).catch(e => call.callLogger.warn(`VAD: Error removing TALK_DETECT on timeout: ${e.message}`)); }
                  this._fullCleanup(callId, true, "VAD_MODE_MAX_WAIT_POST_PROMPT_TIMEOUT");
              }, maxWait * 1000);
              call.callLogger.info(`VAD (vadMode): Started max wait timer (${maxWait}s) for speech after prompt/initial delay.`);
          }
      }
    }
  }

  private async _onChannelTalkingStarted(event: ChannelTalkingStarted, channel: Channel): Promise<void> {
    const call = this.activeCalls.get(channel.id);
    if (!call || call.channel.id !== channel.id || call.isCleanupCalled ||
        call.config.appConfig.appRecognitionConfig.recognitionActivationMode !== 'vad') {
      return;
    }
    call.callLogger.info(`TALK_DETECT: Speech started on channel ${channel.id}.`);

    // If OpenAI stream is already active (e.g. due to speech during VAD delay in vadMode), ignore subsequent TALK_DETECT starts.
    if (call.openAIStreamingActive) {
        call.callLogger.debug(`TALK_DETECT: Speech started, but OpenAI stream already active. Ignoring.`);
        return;
    }
    // If VAD has already triggered recognition and started the stream (e.g. vadSpeechActiveDuringDelay), ignore.
    if (call.vadRecognitionTriggeredAfterInitialDelay && call.openAIStreamingActive) { // Added openAIStreamingActive here for robustness
        call.callLogger.debug(`TALK_DETECT: Speech started, but VAD recognition already triggered and stream active. Ignoring.`);
        return;
    }


    const appRecogConf = call.config.appConfig.appRecognitionConfig;
    const vadRecogActivation = appRecogConf.vadRecogActivation;

    if (vadRecogActivation === 'vadMode') {
      // In 'vadMode', speech can occur *during* vadInitialSilenceDelaySeconds.
      // If that delay has NOT YET COMPLETED, we mark that speech occurred and wait for the delay to finish.
      if (!call.vadInitialSilenceDelayCompleted) {
        call.callLogger.debug(`VAD (vadMode): Speech detected (ChannelTalkingStarted) *during* vadInitialSilenceDelay. Marking vadSpeechActiveDuringDelay.`);
        call.vadSpeechActiveDuringDelay = true; // Mark that speech happened
        call.vadSpeechDetected = true; // General flag for speech detection
        // Do not activate stream yet. _handleVADDelaysCompleted will do it when timer expires.
        return;
      }
      // If vadInitialSilenceDelay *IS* complete, then this ChannelTalkingStarted is the trigger.
      call.callLogger.info(`VAD (vadMode): Speech detected (ChannelTalkingStarted) *after* initial silence delay. This is the trigger.`);
    } else if (vadRecogActivation === 'afterPrompt') {
      // In 'afterPrompt' mode, TALK_DETECT is only meant to trigger action *after* the prompt has finished playing.
      if (call.mainPlayback) { // Check if prompt is currently playing
        call.callLogger.info(`VAD (afterPrompt): Speech detected (ChannelTalkingStarted) *during* main prompt playback. Stopping prompt.`);
        call.vadSpeechDetected = true; // Mark that speech was detected during prompt
        await this._stopAllPlaybacks(call); // Stop the prompt immediately (barge-in)
        call.promptPlaybackStoppedForInterim = true;
        // Stream activation will be handled by _handlePostPromptVADLogic when PlaybackFinished (due to stop) or naturally.
        // _handlePostPromptVADLogic will see vadSpeechDetected = true.
        return;
      }
      // If prompt is NOT playing, this ChannelTalkingStarted is the valid trigger for 'afterPrompt'.
      call.callLogger.info(`VAD (afterPrompt): Speech detected (ChannelTalkingStarted) *after* prompt has finished. This is the trigger.`);
    }

    // Common logic for VAD triggering OpenAI stream if conditions above are met:
    call.vadSpeechDetected = true;
    call.vadRecognitionTriggeredAfterInitialDelay = true;

    let playbackToStop: Playback | undefined = undefined;
    let playbackType = "";

    // Check mainPlayback (initial greeting)
    if (call.mainPlayback && call.mainPlayback.id && !call.promptPlaybackStoppedForInterim) {
        const mainPlaybackId = call.mainPlayback.id; // Store ID before any async op
        try {
            const currentMainPlaybackState = await this.client?.playbacks.get({playbackId: mainPlaybackId});
            if (call.mainPlayback && call.mainPlayback.id === mainPlaybackId && !call.promptPlaybackStoppedForInterim) {
                if (currentMainPlaybackState && currentMainPlaybackState.state === 'playing') {
                    playbackToStop = call.mainPlayback;
                    playbackType = "main greeting";
                } else {
                    call.callLogger.debug(`VAD: Main greeting playback (ID: ${mainPlaybackId}) was not in 'playing' state (ARI State: ${currentMainPlaybackState?.state}). Not stopping it via barge-in.`);
                    if (currentMainPlaybackState?.state !== 'playing') call.mainPlayback = undefined;
                }
            } else {
                 call.callLogger.debug(`VAD: Main greeting playback (ID: ${mainPlaybackId}) was changed, cleared, or already stopped by interim flag during state check. Not stopping.`);
            }
        } catch (e:any) {
            call.callLogger.warn(`VAD: Error getting state for mainPlayback (ID: ${mainPlaybackId}): ${e.message}. Assuming it's not stoppable or gone.`);
            if (call.mainPlayback && call.mainPlayback.id === mainPlaybackId) call.mainPlayback = undefined;
        }
    }

    // Check waitingPlayback (OpenAI TTS) only if mainPlayback wasn't selected for stopping
    if (!playbackToStop && call.waitingPlayback && call.waitingPlayback.id && !call.promptPlaybackStoppedForInterim) {
        const waitingPlaybackId = call.waitingPlayback.id;
        try {
            const currentWaitingPlaybackState = await this.client?.playbacks.get({playbackId: waitingPlaybackId});
            if (call.waitingPlayback && call.waitingPlayback.id === waitingPlaybackId && !call.promptPlaybackStoppedForInterim) {
                if (currentWaitingPlaybackState && currentWaitingPlaybackState.state === 'playing') {
                    playbackToStop = call.waitingPlayback;
                    playbackType = "OpenAI TTS";
                } else {
                    call.callLogger.debug(`VAD: OpenAI TTS playback (ID: ${waitingPlaybackId}) was not in 'playing' state (ARI State: ${currentWaitingPlaybackState?.state}). Not stopping it via barge-in.`);
                    if (currentWaitingPlaybackState?.state !== 'playing') {
                        call.waitingPlayback = undefined;
                    }
                }
            } else {
                 call.callLogger.debug(`VAD: OpenAI TTS playback (ID: ${waitingPlaybackId}) was changed, cleared, or already stopped by interim flag during state check. Not stopping.`);
            }
        } catch (e:any) {
            call.callLogger.warn(`VAD: Error getting state for waitingPlayback (ID: ${waitingPlaybackId}): ${e.message}. Assuming it's not stoppable or gone.`);
            if (call.waitingPlayback && call.waitingPlayback.id === waitingPlaybackId) {
                call.waitingPlayback = undefined;
            }
        }
    }

    if (playbackToStop && playbackToStop.id) {
      const playbackToStopId = playbackToStop.id;
      try {
        call.callLogger.info(`VAD: Barge-in: Stopping ${playbackType} playback (ID: ${playbackToStopId}) due to ChannelTalkingStarted.`);
        await playbackToStop.stop();
        call.promptPlaybackStoppedForInterim = true;
      } catch (e: any) {
         if (e.message && (e.message.includes("Playback not found") || e.message.includes("does not exist"))) {
            call.callLogger.info(`VAD: Attempted to stop ${playbackType} (ID: ${playbackToStopId}) for barge-in, but it was already gone: ${e.message}`);
        } else {
            call.callLogger.warn(`VAD: Error stopping ${playbackType} playback (ID: ${playbackToStopId}) for barge-in: ${e.message}`);
        }
      } finally {
        if (call.mainPlayback && call.mainPlayback.id === playbackToStopId) {
            call.mainPlayback = undefined;
        } else if (call.waitingPlayback && call.waitingPlayback.id === playbackToStopId) {
            call.waitingPlayback = undefined;
        }
      }
    }

    // Clear timers that were waiting for this speech event
    if(call.vadMaxWaitAfterPromptTimer) { clearTimeout(call.vadMaxWaitAfterPromptTimer); call.vadMaxWaitAfterPromptTimer = null; }

    // If speech barge-in happened (playbackToStop was defined and stopped),
    // we need to ensure any VAD audio captured *during* that playback is flagged for sending.
    if (playbackToStop) { // This implies a barge-in occurred
        call.pendingVADBufferFlush = true;
        call.callLogger.info(`VAD: Barge-in on ${playbackType} detected. Flagging VAD buffer for flush.`);
    }

    // Activate OpenAI stream
    this._activateOpenAIStreaming(call.channel.id, "vad_channel_talking_started");
    // Note: pendingVADBufferFlush is now set above if barge-in happened.
    // If this ChannelTalkingStarted is not a barge-in (e.g. speech after prompt),
    // and VAD buffering was active, it should also be flushed.
    // The existing logic in _activateOpenAIStreaming handles call.pendingVADBufferFlush.
    // We might need to ensure isVADBufferingActive is true leading up to this if it's not a barge-in but VAD-triggered.
    // However, isVADBufferingActive is set in playbackAudio for TTS, and in onStasisStart for initial VAD.

    // Once speech is confirmed and stream is activating, remove TALK_DETECT. OpenAI will handle VAD.
    try {
      call.callLogger.info(`VAD: Removing TALK_DETECT from channel '${channel.id}' as speech confirmed and OpenAI stream activating.`);
      await channel.setChannelVar({ variable: 'TALK_DETECT(remove)', value: 'true' });
    } catch (e: any) { call.callLogger.warn(`VAD: Error removing TALK_DETECT from channel '${channel.id}': ${e.message}`); }
  }

  private async _onChannelTalkingFinished(event: ChannelTalkingFinished, channel: Channel): Promise<void> {
    const call = this.activeCalls.get(channel.id);
    if (!call || call.channel.id !== channel.id || call.isCleanupCalled ||
        call.config.appConfig.appRecognitionConfig.recognitionActivationMode !== 'vad') {
      return;
    }
    // Corrected: The 'ChannelTalkingFinished' event has 'duration' (total time talking)
    // but not 'silence_duration'. Silence duration is what triggers this event based on TALK_DETECT settings.
    call.callLogger.info(`TALK_DETECT: Speech finished on channel ${channel.id}. Last speech duration: ${event.duration}ms.`);

    // This event means Asterisk's local VAD detected end of speech.
    call.vadSpeechDetected = false; // Caller has stopped talking according to Asterisk VAD.

    const appRecogConf = call.config.appConfig.appRecognitionConfig;
    if (appRecogConf.vadRecogActivation === 'vadMode') {
        if (!call.vadInitialSilenceDelayCompleted) {
            // If speech stopped *during* the initial silence delay, reset the flag.
            call.vadSpeechActiveDuringDelay = false;
            call.callLogger.debug(`VAD (vadMode): Speech finished during initial silence delay. Resetting vadSpeechActiveDuringDelay.`);
        }
    }

    // IMPORTANT: If OpenAI stream is active, this local VAD event (ChannelTalkingFinished)
    // should NOT by itself stop the OpenAI stream. OpenAI has its own more sophisticated
    // end-of-speech detection (e.g., input_audio_buffer.speech_stopped and subsequent silence).
    // Relying on this local event to stop OpenAI stream can be premature.
    // The primary purpose of TALK_DETECT was to *start* the stream.
    if (call.openAIStreamingActive) {
        call.callLogger.info(`TALK_DETECT: Speech finished, but OpenAI stream is active. OpenAI will manage end-of-turn.`);
    } else {
        // If stream is NOT active, this event might be useful in some scenarios,
        // e.g., if a very short utterance occurred that didn't activate OpenAI,
        // or if we were in 'afterPrompt' and waiting.
        // However, the main logic for timeouts (like vadMaxWaitAfterPromptSeconds) should handle cases
        // where speech starts and then stops without a full interaction.
        call.callLogger.info(`TALK_DETECT: Speech finished, OpenAI stream is NOT active. State: vadSpeechDetected=${call.vadSpeechDetected}, vadRecognitionTriggered=${call.vadRecognitionTriggeredAfterInitialDelay}`);
    }
  }

  private _handlePlaybackFinished(callId: string, reason: string): void {
    const call = this.activeCalls.get(callId);
    if (!call || call.isCleanupCalled) {
      return;
    }

    const appRecogConf = call.config.appConfig.appRecognitionConfig;
    const activationMode = appRecogConf.recognitionActivationMode;

    if (reason.startsWith('main_greeting_')) {
      call.callLogger.info(`Main greeting/prompt finished or failed. Reason: ${reason}. Handling post-prompt logic for main greeting.`);
      call.mainPlayback = undefined;

      // Logic for after main greeting finishes
      switch (activationMode) {
        case 'fixedDelay':
          call.callLogger.info(`fixedDelay mode: Main greeting finished. Barge-in logic handled by onStasisStart timer or direct activation.`);
          if (!call.openAIStreamingActive && !call.bargeInActivationTimer) {
            call.callLogger.warn(`fixedDelay mode: Main greeting finished, stream not active, no pending barge-in timer. Safeguard activation.`);
            this._activateOpenAIStreaming(callId, "fixedDelay_safeguard_post_main_greeting");
          }
          break;
        case 'Immediate':
          call.callLogger.info(`Immediate mode: Main greeting finished. OpenAI stream should be active.`);
          if (!call.openAIStreamingActive) {
            call.callLogger.warn(`Immediate mode: Main greeting finished, stream not active. Unexpected. Safeguard activation.`);
            this._activateOpenAIStreaming(callId, "Immediate_safeguard_post_main_greeting");
          }
          break;
        case 'vad':
          if (appRecogConf.vadRecogActivation === 'afterPrompt') {
            call.callLogger.info(`VAD mode (afterPrompt): Main greeting finished. Activating VAD logic.`);
            this._handlePostPromptVADLogic(callId);
          } else if (appRecogConf.vadRecogActivation === 'vadMode') {
            call.callLogger.info(`VAD mode (vadMode): Main greeting finished. VAD logic (delays/TALK_DETECT) already in effect.`);
            this._handleVADDelaysCompleted(callId); // Check if delays completed and if speech occurred during them
            if (call.vadInitialSilenceDelayCompleted && !call.openAIStreamingActive && !call.vadRecognitionTriggeredAfterInitialDelay) {
                 this._handlePostPromptVADLogic(callId); // Potentially start maxWait timer
            }
          }
          break;
        default:
          call.callLogger.warn(`Unhandled recognitionActivationMode: ${activationMode} after main_greeting.`);
      }
    } else if (reason.startsWith('openai_tts_')) {
      call.callLogger.info(`OpenAI TTS playback finished or failed. Reason: ${reason}. Preparing for next caller turn.`);
      // After OpenAI TTS finishes, we always need to set up to listen for the user again.
      // The exact mechanism depends on the overall RECOGNITION_ACTIVATION_MODE.
      // TALK_DETECT should have been (re-)enabled before this playback started if VAD barge-in was desired.

      // Reset flags for the new turn
      call.speechHasBegun = false;
      call.finalTranscription = "";
      // CRITICAL: Ensure openAIStreamingActive is false now that bot's turn is ending.
      call.openAIStreamingActive = false;
      call.vadRecognitionTriggeredAfterInitialDelay = false;
      call.promptPlaybackStoppedForInterim = false;
      call.isVADBufferingActive = false; // Ensure VAD buffering is reset if it was on
      call.pendingVADBufferFlush = false;
      call.isFlushingVADBuffer = false;

      // Clear previous turn's speech timers explicitly
      if (call.noSpeechBeginTimer) { clearTimeout(call.noSpeechBeginTimer); call.noSpeechBeginTimer = null; call.callLogger.debug("Cleared noSpeechBeginTimer post-TTS.");}
      if (call.speechEndSilenceTimer) { clearTimeout(call.speechEndSilenceTimer); call.speechEndSilenceTimer = null; call.callLogger.debug("Cleared speechEndSilenceTimer post-TTS.");}
      if (call.initialOpenAIStreamIdleTimer) { clearTimeout(call.initialOpenAIStreamIdleTimer); call.initialOpenAIStreamIdleTimer = null; call.callLogger.debug("Cleared initialOpenAIStreamIdleTimer post-TTS.");}
      // The maxRecognitionDurationTimer is for the whole call interaction with user speech,
      // it should typically not be reset here unless each turn has its own max duration.
      // For now, assuming it persists for the overall user speaking phase of the call.

      call.callLogger.info(`OpenAI TTS done. Transitioning to listen for caller based on mode: ${activationMode}`);

      switch (activationMode) {
        case 'fixedDelay':
          const delaySeconds = appRecogConf.bargeInDelaySeconds;
          call.callLogger.info(`fixedDelay mode: Post-TTS. Activating OpenAI stream after ${delaySeconds}s.`);
          if (call.bargeInActivationTimer) clearTimeout(call.bargeInActivationTimer); // Clear previous if any
          if (delaySeconds > 0) {
            call.bargeInActivationTimer = setTimeout(() => {
              if (call.isCleanupCalled || call.openAIStreamingActive) return;
              this._activateOpenAIStreaming(callId, "fixedDelay_post_tts_delay_expired");
            }, delaySeconds * 1000);
          } else {
            this._activateOpenAIStreaming(callId, "fixedDelay_post_tts_immediate");
          }
          break;
        case 'Immediate':
          call.callLogger.info(`Immediate mode: Post-TTS. Activating OpenAI stream immediately.`);
          this._activateOpenAIStreaming(callId, "Immediate_post_tts");
          break;
        case 'vad':
          call.callLogger.info(`VAD mode: Post-TTS. VAD logic (TALK_DETECT) should be active. Sub-mode: ${appRecogConf.vadRecogActivation}`);
           // Ensure TALK_DETECT is active. It was set before TTS playback.
           // If vadRecogActivation is 'afterPrompt', this is the point it becomes truly active.
           // If 'vadMode', it was already active or waiting for initial delays.
          this._handlePostPromptVADLogic(callId); // This will set up vadMaxWaitAfterPromptSeconds if applicable.
          break;
        default:
          call.callLogger.warn(`Unhandled RECOGNITION_ACTIVATION_MODE: ${activationMode} after OpenAI TTS.`);
      }
    } else {
      call.callLogger.debug(`_handlePlaybackFinished called for other reason: ${reason}`);
    }
  }

  private async onStasisStart(event: any, incomingChannel: Channel): Promise<void> {
    const callId = incomingChannel.id; // This is the UNIQUEID for the main channel
    const callerNumber = incomingChannel.caller?.number || 'UnknownCaller';

    // Pass callId and callerNumber to child logger for context
    const callLogger = moduleLogger.child({ callId: callId, callerId: callerNumber });

    const localCallConfig = getCallSpecificConfig(callLogger, incomingChannel); // Pass the already contextualized callLogger

    if (incomingChannel.name.startsWith('UnicastRTP/') || incomingChannel.name.startsWith('Snoop/')) {
      // For utility channels, use their own ID as callId for their specific logs, but mark callerId appropriately
      const utilityCallLogger = moduleLogger.child({ callId: incomingChannel.id, callerId: `utility-${incomingChannel.name.split('/')[0]}` });
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
      vadInitialSilenceDelayCompleted: false,
      vadActivationDelayCompleted: true, // vadActivationDelaySeconds is removed, so consider it completed.
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

      const externalMediaFormat = 'ulaw'; // Assuming ulaw for OpenAI compatibility based on config
      callResources.externalMediaChannel = await this.client.channels.externalMedia({
        app: ASTERISK_ARI_APP_NAME,
        external_host: `${rtpServerAddress.host}:${rtpServerAddress.port}`,
        format: externalMediaFormat, // Ensure this matches what OpenAI expects if direct sending
        encapsulation: 'rtp'
      });
      callLogger.info(`Successfully created externalMediaChannel ${callResources.externalMediaChannel.id} for call ${callId} with format ${externalMediaFormat}.`);
      this.appOwnedChannelIds.add(callResources.externalMediaChannel.id);

      const snoopDirection = 'in' as ('in' | 'out' | 'both'); // Snoop incoming audio from caller to send to OpenAI
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
          // Audio is sent to OpenAI only if the stream is active AND not in a VAD buffering phase waiting for flush confirmation.
          if (call.openAIStreamingActive && !call.isVADBufferingActive && !call.pendingVADBufferFlush && !call.isFlushingVADBuffer) {
            sessionManager.sendAudioToOpenAI(callId, audioPayload);
          }
          // VAD buffering logic: buffer if VAD mode is active, initial silence delay hasn't passed, or stream hasn't started yet for VAD.
          if (call.config.appConfig.appRecognitionConfig.recognitionActivationMode === 'vad' &&
              call.isVADBufferingActive && // This flag is set true initially for VAD mode
              !call.openAIStreamingActive) { // Buffer only if stream is not yet active
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

      sessionManager.handleCallConnection(callId, this);
      callLogger.info(`Call connection details passed to SessionManager.`);

      const appRecogConf = localCallConfig.appConfig.appRecognitionConfig;
      // Global max recognition timer for the turn/attempt
      if (appRecogConf.maxRecognitionDurationSeconds && appRecogConf.maxRecognitionDurationSeconds > 0) {
        callResources.maxRecognitionDurationTimer = setTimeout(() => {
            const currentCall = this.activeCalls.get(callId);
            if(currentCall && !currentCall.isCleanupCalled) {
              currentCall.callLogger.warn(`Max recognition duration ${appRecogConf.maxRecognitionDurationSeconds}s reached.`);
              logConversationToRedis(callId, { actor: 'system', type: 'system_message', content: `Max recognition duration timeout (${appRecogConf.maxRecognitionDurationSeconds}s).`})
                .catch(e => currentCall.callLogger.error(`RedisLog Error: ${e.message}`));
              this._fullCleanup(callId, true, "MAX_RECOGNITION_DURATION_TIMEOUT");
            }
        }, appRecogConf.maxRecognitionDurationSeconds * 1000);
      }

      const activationMode = appRecogConf.recognitionActivationMode;
      callLogger.info(`Recognition Activation Mode: ${activationMode}`);

      if (activationMode === 'Immediate') {
        this._activateOpenAIStreaming(callId, "Immediate_mode_on_start");
      } else if (activationMode === 'fixedDelay') {
        const delaySeconds = appRecogConf.bargeInDelaySeconds;
        callLogger.info(`fixedDelay mode: bargeInDelaySeconds = ${delaySeconds}s.`);
        if (delaySeconds > 0) {
          callResources.bargeInActivationTimer = setTimeout(() => {
            if (callResources.isCleanupCalled || callResources.openAIStreamingActive) return;
            callLogger.info(`fixedDelay: bargeInDelaySeconds (${delaySeconds}s) elapsed. Activating OpenAI stream.`);
            this._activateOpenAIStreaming(callId, "fixedDelay_barge_in_timer_expired");
          }, delaySeconds * 1000);
        } else {
          // If delay is 0, activate immediately.
          this._activateOpenAIStreaming(callId, "fixedDelay_immediate_activation (delay is 0)");
        }
      } else if (activationMode === 'vad') {
        callResources.isVADBufferingActive = true; // Start buffering audio immediately in VAD mode
        // Use vadSilenceThresholdMs for TALK_DETECT silence part.
        // Use vadTalkThreshold for TALK_DETECT energy part. TALK_DETECT format: {talk_thresh},{silence_thresh[,direction]}
        // vadConfig.vadRecognitionActivationMs (duration) is not directly used in TALK_DETECT(set) string.
        // TALK_DETECT itself implies a duration by how long talking must persist above threshold.
        // The problem description's vadTalkThreshold is an energy level.
        const talkThresholdForAri = appRecogConf.vadTalkThreshold; // Energy level
        const silenceThresholdMsForAri = appRecogConf.vadSilenceThresholdMs; // Silence duration in ms

        // TALK_DETECT params: talk_threshold,silence_threshold[,direction]
        // talk_threshold: "Energy level above which audio is considered speech"
        // silence_threshold: "Time of silence after speech to trigger ChannelTalkingFinished"
        // We need a value for talk_threshold (energy) and silence_threshold (ms).
        // vadConfig.vadRecognitionActivationMs was a duration, not directly used here.
        // Let's use vadTalkThreshold for the energy level.
        const talkDetectValue = `${talkThresholdForAri},${silenceThresholdMsForAri}`;

        callLogger.info(`VAD mode: Attempting to set TALK_DETECT on channel ${callId} with value: '${talkDetectValue}' (EnergyThreshold,SilenceMs)`);
        try {
            await incomingChannel.setChannelVar({ variable: 'TALK_DETECT(set)', value: talkDetectValue });
            callLogger.info(`VAD mode: Successfully set TALK_DETECT on channel ${callId}.`);
        } catch (e:any) {
            callLogger.error(`VAD mode: FAILED to set TALK_DETECT on channel ${callId}: ${e.message}. Proceeding without local VAD events.`);
            // If TALK_DETECT fails, VAD mode might not work as expected. Consider fallback or error.
            // For now, log error and continue. Speech might not be detected by Asterisk.
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
              this._handleVADDelaysCompleted(callId);
            }, initialSilenceDelayS * 1000);
          } else {
            // If delay is 0, handle completion immediately.
            this._handleVADDelaysCompleted(callId);
          }
        }
        // For 'afterPrompt' in VAD mode, TALK_DETECT is set, but action is deferred until after prompt.
        // Buffering is active.
      }

      // Play greeting/prompt if specified - this happens for all modes that have a prompt.
      const greetingAudio = appRecogConf.greetingAudioPath;
      if (greetingAudio && this.client) {
        callLogger.info(`Playing greeting/prompt audio: ${greetingAudio}`);
        logConversationToRedis(callId, { actor: 'bot', type: 'tts_prompt', content: `Playing greeting: ${greetingAudio}`})
          .catch(e => callLogger.error(`RedisLog Error (greeting): ${e.message}`));

        callResources.mainPlayback = this.client.Playback();
        if (callResources.mainPlayback) {
          const mainPlaybackId = callResources.mainPlayback.id;
          // PlaybackFailed event handler
          const playbackFailedHandler = (event: any, failedPlayback: Playback) => {
            if (this.client && failedPlayback.id === mainPlaybackId) {
              const currentCall = this.activeCalls.get(callId);
              if (currentCall?.mainPlayback?.id === mainPlaybackId) {
                currentCall.callLogger.warn(`Main greeting playback ${failedPlayback.id} FAILED. State: ${failedPlayback.state}`);
                logConversationToRedis(callId, { actor: 'system', type: 'error_message', content: `Main greeting playback ${failedPlayback.id} FAILED.`})
                  .catch(e => currentCall.callLogger.error(`RedisLog Error (greeting fail): ${e.message}`));
                this._handlePlaybackFinished(callId, 'main_greeting_failed');
              }
              if (currentCall?.playbackFailedHandler) { // Remove listener
                this.client?.removeListener('PlaybackFailed' as any, currentCall.playbackFailedHandler);
                currentCall.playbackFailedHandler = null;
              }
            }
          };
          callResources.playbackFailedHandler = playbackFailedHandler;
          this.client.on('PlaybackFailed' as any, callResources.playbackFailedHandler);

          // PlaybackFinished event handler
          callResources.mainPlayback.once('PlaybackFinished', (evt: PlaybackFinished, instance: Playback) => {
            const currentCall = this.activeCalls.get(callId);
            // Remove PlaybackFailed listener if playback finishes successfully
            if (currentCall?.playbackFailedHandler && this.client && instance.id === currentCall.mainPlayback?.id) {
              this.client.removeListener('PlaybackFailed' as any, currentCall.playbackFailedHandler);
              currentCall.playbackFailedHandler = null;
            }
            if (currentCall?.mainPlayback?.id === instance.id) {
              currentCall.callLogger.info(`Main greeting playback ${instance.id} FINISHED.`);
              // Redis log for greeting finished could be added here if desired, but might be redundant if next turn is logged.
              this._handlePlaybackFinished(callId, 'main_greeting_finished');
            }
          });
          await callResources.channel.play({ media: greetingAudio }, callResources.mainPlayback);
          callLogger.info(`Successfully started main greeting playback ${callResources.mainPlayback.id}.`);
        } else {
           callLogger.error(`Failed to create mainPlayback object for greeting.`);
           logConversationToRedis(callId, { actor: 'system', type: 'error_message', content: `Failed to create mainPlayback for greeting.`})
             .catch(e => callLogger.error(`RedisLog Error (greeting creation fail): ${e.message}`));
           this._handlePlaybackFinished(callId, 'main_greeting_creation_failed'); // Trigger post-prompt logic even if playback object fails
        }
      } else {
        // No greeting audio, or client not available.
        const logMsg = greetingAudio ? `ARI client not available for greeting playback.` : `No greeting audio specified. Proceeding to post-prompt logic directly.`;
        callLogger.info(logMsg);
        logConversationToRedis(callId, { actor: 'system', type: 'system_message', content: logMsg})
          .catch(e => callLogger.error(`RedisLog Error (no greeting): ${e.message}`));
        // Directly trigger post-prompt logic as if an empty prompt finished.
        this._handlePlaybackFinished(callId, 'main_greeting_skipped_or_no_client');
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

    // Ensure TALK_DETECT is active before playing TTS if barge-in is desired
    const appRecogConf = call.config.appConfig.appRecognitionConfig;
    if (!call.dtmfModeActive && appRecogConf.recognitionActivationMode === 'vad') {
        // Only set TALK_DETECT if not in DTMF mode AND current overall mode is 'vad'.
        // For 'fixedDelay' or 'Immediate', barge-in during TTS via VAD is not standard; DTMF is the primary interrupt.
        // If VAD-based barge-in is desired for those modes too, this condition needs adjustment.
        try {
            const talkThresholdForAri = appRecogConf.vadTalkThreshold;
            const silenceThresholdMsForAri = appRecogConf.vadSilenceThresholdMs;
            const talkDetectValue = `${talkThresholdForAri},${silenceThresholdMsForAri}`;

            call.callLogger.info(`VAD Mode: Ensuring TALK_DETECT is active for TTS playback barge-in. Value: '${talkDetectValue}'`);
            await call.channel.setChannelVar({ variable: 'TALK_DETECT(set)', value: talkDetectValue });
            call.isVADBufferingActive = true; // Enable buffering for potential speech during TTS
            call.vadAudioBuffer = []; // Clear any old buffer
            call.pendingVADBufferFlush = false;
            call.isFlushingVADBuffer = false;
        } catch (e: any) {
            call.callLogger.warn(`Error setting TALK_DETECT for TTS barge-in on channel ${call.channel.id}: ${e.message}. Speech barge-in might not work.`);
        }
    } else {
        // If not in VAD mode, or if in DTMF mode, ensure VAD buffering is off.
        call.isVADBufferingActive = false;
        call.vadAudioBuffer = [];
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
      call.callLogger.debug(`Created playback object ${playbackId} for ${channelId} (OpenAI TTS). Media: ${mediaToPlay.substring(0,60)}...`);

      const waitingPlaybackFinishedCb = () => {
        const currentCall = this.activeCalls.get(channelId);
        if (!currentCall || currentCall.isCleanupCalled) return;
        currentCall.callLogger.debug(`OpenAI TTS Playback ${playbackId} finished for ${channelId}.`);
        if(currentCall.waitingPlayback && currentCall.waitingPlayback.id === playbackId) {
          currentCall.waitingPlayback = undefined;
        }
        if (this.client && currentCall.waitingPlaybackFailedHandler) {
          this.client.removeListener('PlaybackFailed' as any, currentCall.waitingPlaybackFailedHandler);
          currentCall.waitingPlaybackFailedHandler = null;
        }
        // After TTS playback finishes, proceed to listen for user based on mode
        this._handlePlaybackFinished(channelId, 'openai_tts_finished');
      };
      if (call.waitingPlayback) {
          call.waitingPlayback.once('PlaybackFinished', waitingPlaybackFinishedCb);
      }

      const waitingPlaybackFailedCb = (event: any, failedPlayback: Playback) => {
        if (this.client && failedPlayback.id === playbackId) {
          const currentCall = this.activeCalls.get(channelId);
          if (!currentCall || currentCall.isCleanupCalled) return;
          currentCall.callLogger.error(`OpenAI TTS Playback ${playbackId} FAILED for ${channelId}: ${failedPlayback?.state}, Reason: ${event?.message || (event?.playback?.reason || 'Unknown')}`);
          if(currentCall.waitingPlayback && currentCall.waitingPlayback.id === playbackId) {
            currentCall.waitingPlayback = undefined;
          }
          if (this.client && currentCall.waitingPlaybackFailedHandler === waitingPlaybackFailedCb) {
            this.client.removeListener('PlaybackFailed' as any, waitingPlaybackFailedCb);
            currentCall.waitingPlaybackFailedHandler = null;
          }
          this._handlePlaybackFinished(channelId, 'openai_tts_failed');
        }
      };
      call.waitingPlaybackFailedHandler = waitingPlaybackFailedCb;
      this.client.on('PlaybackFailed' as any, call.waitingPlaybackFailedHandler);

      await call.channel.play({ media: mediaToPlay }, call.waitingPlayback);
      call.callLogger.info(`OpenAI TTS Playback ${playbackId} started for ${channelId}.`);
    } catch (err: any) {
      call.callLogger.error(`Error playing OpenAI TTS audio for ${channelId}: ${err.message || JSON.stringify(err)}`);
      if (call.waitingPlayback) {
        if (call.waitingPlaybackFailedHandler && this.client) {
            this.client.removeListener('PlaybackFailed' as any, call.waitingPlaybackFailedHandler);
            call.waitingPlaybackFailedHandler = null;
        }
        call.waitingPlayback = undefined;
      }
       this._handlePlaybackFinished(channelId, 'openai_tts_playback_exception');
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
