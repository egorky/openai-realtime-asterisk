import Ari, { Channel, Bridge, Playback, PlaybackFinished, ChannelTalkingStarted, ChannelTalkingFinished, ChannelDtmfReceived } from 'ari-client';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { RtpServer } from './rtp-server';
import * as sessionManager from './sessionManager';
import {
  AriClient as AriClientInterface,
  CallSpecificConfig,
  RuntimeConfig,
  AppRecognitionConfig,
  DtmfConfig
} from './types';

// Base logger for the module. Call-specific loggers will be derived from this.
const moduleLogger = {
  info: console.log, error: console.error, warn: console.warn, debug: console.log, silly: console.log,
  isLevelEnabled: (level: string) => level !== 'silly', // Basic stub for logger compatibility
  child: (bindings: object) => moduleLogger, // Basic stub for logger compatibility
};

dotenv.config();

// --- Configuration Loading Helper Functions ---
// These functions retrieve configuration values from environment variables or fallback to defaults.
// TODO: Enhance getVar to support asynchronous fetching of Asterisk channel variables for per-call overrides.

function getVar(logger: any, channel: Channel | undefined, envVarName: string, defaultValue?: string, channelVarName?: string): string | undefined {
  const astVarName = channelVarName || `APP_${envVarName}`;
  let value: string | undefined;
  // Placeholder: Asterisk channel variable fetching would be async and require changes to getCallSpecificConfig.
  // if (channel) { try { value = await channel.getVariable({ variable: astVarName }); } catch (e) { logger.warn('Error getting channel var'); } }
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

/**
 * Loads the call-specific configuration by layering defaults, JSON file, and environment variables.
 * @param logger - Logger instance.
 * @param channel - Optional ARI channel object (for future channel variable overrides).
 * @returns The fully resolved CallSpecificConfig.
 */
function getCallSpecificConfig(logger: any, channel?: Channel): CallSpecificConfig {
  const configFilePath = process.env.CONFIG_FILE_PATH || path.join(__dirname, '../config/default.json');
  let baseConfig: RuntimeConfig;
  try {
    const rawConfig = fs.readFileSync(configFilePath, 'utf-8');
    baseConfig = JSON.parse(rawConfig) as RuntimeConfig;
  } catch (e: unknown) { // Changed 'error' to 'e' and typed as 'unknown'
    if (e instanceof Error) {
        logger.error(`Config load error from ${configFilePath}: ${e.message}. Using hardcoded fallbacks.`);
    } else {
        logger.error(`Config load error from ${configFilePath}: ${String(e)}. Using hardcoded fallbacks.`);
    }
    // Fallback configuration if file loading fails
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
      openAIRealtimeAPI: { model: "gpt-4o-realtime-preview-2024-12-17", inputAudioFormat: "g711_ulaw", inputAudioSampleRate: 8000, outputAudioFormat: "g711_ulaw", outputAudioSampleRate: 8000 },
      logging: { level: "info" },
    };
  }
  // Deep copy base config and override with environment variables
  const callConfig = JSON.parse(JSON.stringify(baseConfig)) as CallSpecificConfig;

  callConfig.logging.level = getVar(logger, channel, 'LOG_LEVEL', callConfig.logging.level) as any || callConfig.logging.level;

  const arc = callConfig.appConfig.appRecognitionConfig = callConfig.appConfig.appRecognitionConfig || {} as AppRecognitionConfig;
  arc.greetingAudioPath = getVar(logger, channel, 'GREETING_AUDIO_PATH', arc.greetingAudioPath) || 'sound:hello-world';
  arc.maxRecognitionDurationSeconds = getVarAsInt(logger, channel, 'MAX_RECOGNITION_DURATION_SECONDS', arc.maxRecognitionDurationSeconds) || 30;
  arc.noSpeechBeginTimeoutSeconds = getVarAsInt(logger, channel, 'NO_SPEECH_BEGIN_TIMEOUT_SECONDS', arc.noSpeechBeginTimeoutSeconds) ?? 3;
  arc.speechCompleteTimeoutSeconds = getVarAsInt(logger, channel, 'SPEECH_COMPLETE_TIMEOUT_SECONDS', arc.speechCompleteTimeoutSeconds) ?? 5;
  arc.bargeInDelaySeconds = getVarAsFloat(logger, channel, 'BARGE_IN_DELAY_SECONDS', arc.bargeInDelaySeconds ?? callConfig.appConfig.bargeInConfig?.bargeInDelaySeconds) ?? 0.5;
  arc.vadRecogActivation = getVar(logger, channel, 'VAD_RECOG_ACTIVATION_MODE', arc.vadRecogActivation) as 'vadMode' | 'afterPrompt' || 'afterPrompt';
  arc.vadInitialSilenceDelaySeconds = getVarAsInt(logger, channel, 'VAD_INITIAL_SILENCE_DELAY_SECONDS', arc.vadInitialSilenceDelaySeconds) ?? 0;
  arc.vadActivationDelaySeconds = getVarAsInt(logger, channel, 'VAD_ACTIVATION_DELAY_SECONDS', arc.vadActivationDelaySeconds) ?? 0;
  arc.vadMaxWaitAfterPromptSeconds = getVarAsInt(logger, channel, 'VAD_MAX_WAIT_AFTER_PROMPT_SECONDS', arc.vadMaxWaitAfterPromptSeconds) ?? 5;
  arc.vadConfig = arc.vadConfig || { vadSilenceThresholdMs: 250, vadRecognitionActivationMs: 40 };
  arc.vadConfig.vadSilenceThresholdMs = getVarAsInt(logger, channel, 'VAD_SILENCE_THRESHOLD_MS', arc.vadConfig.vadSilenceThresholdMs) ?? 250;
  arc.vadConfig.vadRecognitionActivationMs = getVarAsInt(logger, channel, 'VAD_TALK_THRESHOLD_MS', arc.vadConfig.vadRecognitionActivationMs) ?? 40;

  const dtmfConf = callConfig.appConfig.dtmfConfig = callConfig.appConfig.dtmfConfig || {} as DtmfConfig;
  dtmfConf.dtmfEnabled = getVarAsBoolean(logger, channel, 'DTMF_ENABLED', dtmfConf.dtmfEnabled) ?? true;
  dtmfConf.dtmfInterdigitTimeoutSeconds = getVarAsInt(logger, channel, 'DTMF_INTERDIGIT_TIMEOUT_SECONDS', dtmfConf.dtmfInterdigitTimeoutSeconds) ?? 2;
  dtmfConf.dtmfMaxDigits = getVarAsInt(logger, channel, 'DTMF_MAX_DIGITS', dtmfConf.dtmfMaxDigits) ?? 16;
  dtmfConf.dtmfTerminatorDigit = getVar(logger, channel, 'DTMF_TERMINATOR_DIGIT', dtmfConf.dtmfTerminatorDigit) ?? "#";
  dtmfConf.dtmfFinalTimeoutSeconds = getVarAsInt(logger, channel, 'DTMF_FINAL_TIMEOUT_SECONDS', dtmfConf.dtmfFinalTimeoutSeconds) ?? 3;

  const oaiConf = callConfig.openAIRealtimeAPI = callConfig.openAIRealtimeAPI || {};
  oaiConf.model = getVar(logger, channel, 'OPENAI_MODEL', oaiConf.model) ?? "gpt-4o-realtime-preview-2024-12-17";
  oaiConf.language = getVar(logger, channel, 'OPENAI_LANGUAGE', oaiConf.language);
  oaiConf.inputAudioFormat = getVar(logger, channel, 'OPENAI_INPUT_AUDIO_FORMAT', oaiConf.inputAudioFormat) ?? "g711_ulaw";
  oaiConf.inputAudioSampleRate = getVarAsInt(logger, channel, 'OPENAI_INPUT_AUDIO_SAMPLE_RATE', oaiConf.inputAudioSampleRate) ?? 8000;
  oaiConf.outputAudioFormat = getVar(logger, channel, 'OPENAI_OUTPUT_AUDIO_FORMAT', oaiConf.outputAudioFormat) ?? "g711_ulaw";
  oaiConf.outputAudioSampleRate = getVarAsInt(logger, channel, 'OPENAI_OUTPUT_AUDIO_SAMPLE_RATE', oaiConf.outputAudioSampleRate) ?? 8000;
  if (!oaiConf.inputAudioFormat && oaiConf.audioFormat) oaiConf.inputAudioFormat = oaiConf.audioFormat;
  if (!oaiConf.inputAudioSampleRate && oaiConf.sampleRate) oaiConf.inputAudioSampleRate = oaiConf.sampleRate;
  if (!oaiConf.outputAudioFormat && oaiConf.audioFormat) oaiConf.outputAudioFormat = oaiConf.audioFormat;
  if (!oaiConf.outputAudioSampleRate && oaiConf.sampleRate) oaiConf.outputAudioSampleRate = oaiConf.sampleRate;

  oaiConf.apiKey = process.env.OPENAI_API_KEY || "";
  if (!oaiConf.apiKey) {
    logger.error("CRITICAL: OPENAI_API_KEY is not set in environment variables. OpenAI connection will fail.");
  }

  return callConfig;
}

const ASTERISK_ARI_URL = process.env.ASTERISK_ARI_URL || 'http://localhost:8088';
const ASTERISK_ARI_USERNAME = process.env.ASTERISK_ARI_USERNAME || 'asterisk';
const ASTERISK_ARI_PASSWORD = process.env.ASTERISK_ARI_PASSWORD || 'asterisk';
const ASTERISK_ARI_APP_NAME = process.env.ASTERISK_ARI_APP_NAME || 'openai-ari-app';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const DEFAULT_RTP_HOST_IP = process.env.RTP_HOST_IP || '127.0.0.1';
const DEFAULT_AUDIO_FORMAT_FOR_EXTERNAL_MEDIA = process.env.AUDIO_FORMAT_FOR_EXTERNAL_MEDIA || 'ulaw';
const MAX_VAD_BUFFER_PACKETS = 200;

if (!OPENAI_API_KEY) { moduleLogger.error("FATAL: OPENAI_API_KEY environment variable is not set. Service will not be able to function."); }

interface CallResources {
  channel: Channel;
  config: CallSpecificConfig;
  callLogger: any;
  userBridge?: Bridge;
  snoopBridge?: Bridge;
  rtpServer?: RtpServer;
  externalMediaChannel?: Channel;
  snoopChannel?: Channel;
  mainPlayback?: Playback;
  waitingPlayback?: Playback;
  postRecognitionWaitingPlayback?: Playback;
  isCleanupCalled: boolean;
  promptPlaybackStoppedForInterim: boolean;
  fallbackAttempted: boolean;
  openAIStreamError: any;
  openAIStreamingActive: boolean;
  isOpenAIStreamEnding: boolean;
  speechHasBegun: boolean;
  finalTranscription: string;
  collectedDtmfDigits: string;
  dtmfModeActive: boolean;
  speechRecognitionDisabledDueToDtmf: boolean;
  dtmfInterruptedSpeech: boolean;
  vadSpeechDetected: boolean;
  vadAudioBuffer: Buffer[];
  isVADBufferingActive: boolean;
  isFlushingVADBuffer: boolean;
  pendingVADBufferFlush: boolean;
  vadRecognitionTriggeredAfterInitialDelay: boolean;
  vadSpeechActiveDuringDelay: boolean;
  vadInitialSilenceDelayCompleted: boolean;
  vadActivationDelayCompleted: boolean;
  bargeInActivationTimer: NodeJS.Timeout | null;
  noSpeechBeginTimer: NodeJS.Timeout | null;
  initialOpenAIStreamIdleTimer: NodeJS.Timeout | null;
  speechEndSilenceTimer: NodeJS.Timeout | null;
  maxRecognitionDurationTimer: NodeJS.Timeout | null;
  dtmfInterDigitTimer: NodeJS.Timeout | null;
  dtmfFinalTimer: NodeJS.Timeout | null;
  vadMaxWaitAfterPromptTimer: NodeJS.Timeout | null;
  vadActivationDelayTimer: NodeJS.Timeout | null;
  vadInitialSilenceDelayTimer: NodeJS.Timeout | null;
}

export class AriClientService implements AriClientInterface {
  private client: Ari.Client | null = null;
  private activeCalls = new Map<string, CallResources>();
  private appOwnedChannelIds = new Set<string>();
  private logger = moduleLogger;
  private baseConfig: RuntimeConfig;

  constructor() {
    this.baseConfig = getCallSpecificConfig(this.logger.child({ context: 'AriBaseConfigLoad' }));
    this.logger = this.logger.child({ service: 'AriClientService' });
  }

  public async connect(): Promise<void> {
    try {
      this.client = await Ari.connect(ASTERISK_ARI_URL, ASTERISK_ARI_USERNAME, ASTERISK_ARI_PASSWORD);
      this.logger.info('Successfully connected to Asterisk ARI.');

      this.client.on('StasisStart', this.onStasisStart.bind(this));
      this.client.on('ChannelDtmfReceived', this._onDtmfReceived.bind(this));
      this.client.on('PlaybackFinished', this.onPlaybackFinished.bind(this));
      this.client.on('PlaybackFailed', this.onPlaybackFailed.bind(this));
      this.client.on('ChannelTalkingStarted', this._onChannelTalkingStarted.bind(this));
      this.client.on('ChannelTalkingFinished', this._onChannelTalkingFinished.bind(this));
      this.client.on('error', (err: Error) => this.onAriError(err)); // Typed err parameter
      this.client.on('close', () => this.onAriClose());

      await this.client.start(ASTERISK_ARI_APP_NAME);
      this.logger.info(`ARI Stasis application '${ASTERISK_ARI_APP_NAME}' started and listening for calls.`);
    } catch (err: any) {
      if (err instanceof Error) {
        this.logger.error('FATAL: Failed to connect to Asterisk ARI or start Stasis app:', err.message, err.stack);
      } else {
        this.logger.error('FATAL: Failed to connect to Asterisk ARI or start Stasis app with unknown error object:', err);
      }
      throw err;
    }
  }

  public _onOpenAISpeechStarted(callId: string): void {
    const call = this.activeCalls.get(callId);
    if (!call || call.isCleanupCalled) return;
    call.callLogger.info('OpenAI speech recognition started (or first transcript received).');
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
        call.callLogger.info('Speech implicitly started with first interim transcript.');
    }
    if (call.mainPlayback && !call.promptPlaybackStoppedForInterim && call.config.appConfig.bargeInConfig.bargeInModeEnabled) {
      call.callLogger.info('Stopping main prompt due to interim transcript (barge-in).');
      this._stopAllPlaybacks(call).catch(e => call.callLogger.error("Error stopping playback on interim: " + (e instanceof Error ? e.message : String(e))));
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
    call.callLogger.info(`OpenAI final transcript received: "${transcript}"`);
    if (call.speechEndSilenceTimer) { clearTimeout(call.speechEndSilenceTimer); call.speechEndSilenceTimer = null; }
    call.finalTranscription = transcript;
    this._fullCleanup(callId, false, "FINAL_TRANSCRIPT_RECEIVED");
  }

  public _onOpenAIError(callId: string, error: any): void {
    const call = this.activeCalls.get(callId);
    if (!call || call.isCleanupCalled) return;
    call.callLogger.error('OpenAI stream error reported by sessionManager:', error);
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
      call.callLogger.info('DTMF disabled by config. Ignoring.');
      return;
    }
    call.callLogger.info('Entering DTMF mode: interrupting speech/VAD activities.');
    call.dtmfModeActive = true;
    call.speechRecognitionDisabledDueToDtmf = true;
    call.isVADBufferingActive = false;
    call.vadAudioBuffer = [];
    call.pendingVADBufferFlush = false;
    await this._stopAllPlaybacks(call);

    if (call.openAIStreamingActive) {
      call.callLogger.info('DTMF interrupting active OpenAI stream.');
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
    call.dtmfInterDigitTimer = setTimeout(() => { call.callLogger.info('DTMF inter-digit timer expired.'); }, interDigitTimeout);

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
      call.callLogger.info('DTMF terminator digit received.');
      if (call.dtmfFinalTimer) clearTimeout(call.dtmfFinalTimer);
      try { await call.channel.setChannelVar({ variable: 'DTMF_RESULT', value: call.collectedDtmfDigits }); }
      catch (e:any) { call.callLogger.error(`Error setting DTMF_RESULT: ${(e instanceof Error ? e.message : String(e))}`); }
      this._fullCleanup(call.channel.id, false, "DTMF_TERMINATOR_RECEIVED");
    } else if (call.collectedDtmfDigits.length >= (dtmfConfig.dtmfMaxDigits ?? 16)) {
      call.callLogger.info('Max DTMF digits reached.');
      if (call.dtmfFinalTimer) clearTimeout(call.dtmfFinalTimer);
      try { await call.channel.setChannelVar({ variable: 'DTMF_RESULT', value: call.collectedDtmfDigits }); }
      catch (e:any) { call.callLogger.error(`Error setting DTMF_RESULT: ${(e instanceof Error ? e.message : String(e))}`); }
      this._fullCleanup(call.channel.id, false, "DTMF_MAX_DIGITS_REACHED");
    }
  }

  private async _activateOpenAIStreaming(callId: string, reason: string): Promise<void> {
    const call = this.activeCalls.get(callId);
    if (!call || call.isCleanupCalled || call.openAIStreamingActive) {
      if(call?.openAIStreamingActive) call.callLogger.debug(`Activate called but stream already active. Reason: ${reason}`);
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
      const streamIdleTimeout = 10;
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
      call.callLogger.info(`VAD vadMode: All initial delays completed.`); // Corrected logging
      if (call.vadRecognitionTriggeredAfterInitialDelay || call.openAIStreamingActive) { return; }

      if (call.vadSpeechActiveDuringDelay) {
        call.callLogger.info('VAD vadMode: Speech detected during delays. Activating OpenAI stream.'); // Corrected logging
        this._activateOpenAIStreaming(callId, "vad_speech_during_delay_window");
        call.pendingVADBufferFlush = true;
        if(call.channel) {
            call.channel.setChannelVar({ variable: 'TALK_DETECT(remove)', value: 'true' })
                .catch(e => call.callLogger.warn(`VAD: Error removing TALK_DETECT: ${e.message}`));
        }
      } else {
        call.callLogger.info('VAD vadMode: Delays completed, no prior speech. Listening via TALK_DETECT.'); // Corrected logging
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
        call.callLogger.info('VAD (afterPrompt): Speech previously detected. Activating OpenAI stream.');
        this._activateOpenAIStreaming(callId, "vad_afterPrompt_speech_during_prompt");
        call.pendingVADBufferFlush = true;
        if(call.channel) {
            call.channel.setChannelVar({ variable: 'TALK_DETECT(remove)', value: 'true' })
                .catch(e => call.callLogger.warn(`VAD: Error removing TALK_DETECT: ${e.message}`));
        }
      } else {
        call.callLogger.info('VAD (afterPrompt): No speech during prompt. Starting max wait timer.');
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
            call.callLogger.info('VAD (afterPrompt): Max wait is 0 and no speech during prompt. Ending call.');
            if(call.channel) { call.channel.setChannelVar({ variable: 'TALK_DETECT(remove)', value: 'true' }).catch(e => call.callLogger.warn(`VAD: Error removing TALK_DETECT: ${e.message}`)); }
            this._fullCleanup(callId, true, "VAD_MAX_WAIT_0_NO_SPEECH");
        }
      }
    } else if (vadRecogActivation === 'vadMode') {
      call.callLogger.info("VAD vadMode: Delays completed, no speech during delay. Actively listening via TALK_DETECT.");
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
        call.callLogger.debug('VAD (vadMode): Speech detected during initial VAD delays.');
        call.vadSpeechActiveDuringDelay = true;
        call.vadSpeechDetected = true;
        return;
      }
    } else if (vadRecogActivation === 'afterPrompt') {
      if (call.mainPlayback) {
        call.callLogger.debug('VAD (afterPrompt): Speech detected during main prompt.');
        call.vadSpeechDetected = true;
        return;
      }
    }

    call.callLogger.info('VAD: Speech detected, proceeding to activate stream.');
    call.vadSpeechDetected = true;
    call.vadRecognitionTriggeredAfterInitialDelay = true;

    if (call.mainPlayback && !call.promptPlaybackStoppedForInterim) {
      try {
        call.callLogger.info('VAD: Stopping main prompt due to speech.');
        await call.mainPlayback.stop();
        call.promptPlaybackStoppedForInterim = true;
      } catch (e: any) { call.callLogger.warn(`VAD: Error stopping main playback: ${e.message}`); }
    }

    if(call.bargeInActivationTimer) { clearTimeout(call.bargeInActivationTimer); call.bargeInActivationTimer = null; }
    if(call.vadMaxWaitAfterPromptTimer) { clearTimeout(call.vadMaxWaitAfterPromptTimer); call.vadMaxWaitAfterPromptTimer = null; }

    this._activateOpenAIStreaming(call.channel.id, "vad_speech_detected_direct");
    call.pendingVADBufferFlush = true;

    try {
      call.callLogger.info('VAD: Removing TALK_DETECT from channel after confirmed speech.');
      await channel.setChannelVar({ variable: 'TALK_DETECT(remove)', value: 'true' });
    } catch (e: any) { call.callLogger.warn(`VAD: Error removing TALK_DETECT: ${e.message}`); }
  }

  private async _onChannelTalkingFinished(event: ChannelTalkingFinished, channel: Channel): Promise<void> {
    const call = this.activeCalls.get(channel.id);
    if (!call || call.channel.id !== channel.id || call.isCleanupCalled || call.config.appConfig.appRecognitionConfig.recognitionActivationMode !== 'VAD') {
      return;
    }
    call.callLogger.info(`TALK_DETECT: Speech finished. Duration: ${event.duration_ms}ms`);
    call.vadSpeechDetected = false;
    if (!call.vadInitialSilenceDelayCompleted || !call.vadActivationDelayCompleted) {
        call.vadSpeechActiveDuringDelay = false;
    }
  }

  private async onPlaybackFinished(event: PlaybackFinished, playback: Playback): Promise<void> {
    for (const [callId, call] of this.activeCalls.entries()) {
      if (call.mainPlayback?.id === playback.id) {
        call.callLogger.info(`Main playback (greeting/prompt) finished.`);
        call.mainPlayback = undefined;

        const activationMode = call.config.appConfig.appRecognitionConfig.recognitionActivationMode;
        if (activationMode === 'VAD') {
          this._handlePostPromptVADLogic(callId);
        } else if (activationMode === 'FIXED_DELAY') { // Corrected comparison
          const delaySeconds = call.config.appConfig.appRecognitionConfig.bargeInDelaySeconds ?? 0.5;
          call.callLogger.info(`FixedDelay mode: Greeting finished. Barge-in delay: ${delaySeconds}s.`);
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
        break;
      }
    }
  }

  private async onPlaybackFailed(event: any, playback: Playback): Promise<void> {
    for (const [callId, call] of this.activeCalls.entries()) {
        if (call.mainPlayback?.id === playback.id) {
            call.callLogger.error(`Main playback (greeting/prompt) FAILED. Reason: ${event.message || 'Unknown'}`);
            call.mainPlayback = undefined;
            const activationMode = call.config.appConfig.appRecognitionConfig.recognitionActivationMode;
            if (activationMode === 'IMMEDIATE' || (activationMode === 'FIXED_DELAY' && (call.config.appConfig.appRecognitionConfig.bargeInDelaySeconds ?? 0.5) <=0) ) { // Corrected comparison
                this._activateOpenAIStreaming(callId, `${activationMode}_greeting_failed_direct_activation`);
            } else if (activationMode === 'VAD') {
                this._handlePostPromptVADLogic(callId);
            }
            break;
        }
    }
  }

  private async onStasisStart(event: any, incomingChannel: Channel): Promise<void> {
    const callId = incomingChannel.id;
    const callLogger = this.logger.child({ callId, channelName: incomingChannel.name });
    callLogger.info(`StasisStart: New call entering application '${ASTERISK_ARI_APP_NAME}'.`);

    if (this.appOwnedChannelIds.has(callId)) {
      callLogger.info(`Channel ${callId} is app-owned. Ignoring StasisStart.`); return;
    }
    const callConfig = getCallSpecificConfig(callLogger, incomingChannel);

    const callResources: CallResources = {
      channel: incomingChannel, config: callConfig, callLogger, isCleanupCalled: false,
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
    };
    this.activeCalls.set(callId, callResources);
    callLogger.info(`Call resources initialized. Mode: ${callConfig.appConfig.appRecognitionConfig.recognitionActivationMode}`);

    try {
      await incomingChannel.answer();
      callLogger.info(`Call answered.`);
      incomingChannel.once('StasisEnd', () => {
        callLogger.info(`Primary channel ${callId} StasisEnd. Cleanup.`);
        this._fullCleanup(callId, false, "PRIMARY_CHANNEL_STASIS_ENDED");
      });

      if (!this.client) { throw new Error("ARI client not connected."); }

      callResources.userBridge = await this.client.bridges.create({ type: 'mixing', name: `user_b_${callId}` });
      await callResources.userBridge.addChannel({ channel: callId });
      callResources.snoopBridge = await this.client.bridges.create({ type: 'mixing', name: `snoop_b_${callId}` });
      callResources.rtpServer = new RtpServer(callLogger.child({ component: 'RtpServer'}));
      const rtpServerAddress = await callResources.rtpServer.start(0, DEFAULT_RTP_HOST_IP);
      const externalMediaFormat = callConfig.openAIRealtimeAPI?.inputAudioFormat || DEFAULT_AUDIO_FORMAT_FOR_EXTERNAL_MEDIA;
      callResources.externalMediaChannel = await this.client.channels.externalMedia({ app: ASTERISK_ARI_APP_NAME, external_host: `${rtpServerAddress.host}:${rtpServerAddress.port}`, format: externalMediaFormat });
      this.appOwnedChannelIds.add(callResources.externalMediaChannel.id);
      const snoopDirection = (callConfig.appConfig.appRecognitionConfig.recognitionActivationMode === 'VAD' ? 'in' : 'both') as ('in' | 'out' | 'both');
      callResources.snoopChannel = await this.client.channels.snoopChannelWithId({ channelId: callId, snoopId: `snoop_${callId}`, app: ASTERISK_ARI_APP_NAME, spy: snoopDirection });
      this.appOwnedChannelIds.add(callResources.snoopChannel.id);
      await callResources.snoopBridge.addChannel({ channel: callResources.externalMediaChannel.id });
      await callResources.snoopBridge.addChannel({ channel: callResources.snoopChannel.id });

      callResources.rtpServer.on('audioPacket', (audioPayload: Buffer) => {
        const call = this.activeCalls.get(callId);
        if (call && !call.isCleanupCalled) {
          if (call.isVADBufferingActive) {
            if (call.vadAudioBuffer.length < MAX_VAD_BUFFER_PACKETS) { call.vadAudioBuffer.push(audioPayload); }
            else { call.callLogger.warn('VAD buffer limit. Shift.'); call.vadAudioBuffer.shift(); call.vadAudioBuffer.push(audioPayload); }
          }
          if (call.openAIStreamingActive && !call.pendingVADBufferFlush) { sessionManager.sendAudioToOpenAI(callId, audioPayload); }
        }
      });

      sessionManager.handleCallConnection(callId, this);
      callLogger.info(`Call connection details passed to SessionManager.`);

      const appRecogConf = callConfig.appConfig.appRecognitionConfig;
      if (appRecogConf.maxRecognitionDurationSeconds && appRecogConf.maxRecognitionDurationSeconds > 0) {
        callResources.maxRecognitionDurationTimer = setTimeout(() => { this._fullCleanup(callId, true, "MAX_RECOGNITION_DURATION_TIMEOUT"); }, appRecogConf.maxRecognitionDurationSeconds * 1000);
      }

      const activationMode = appRecogConf.recognitionActivationMode;
      if (activationMode === 'IMMEDIATE') { this._activateOpenAIStreaming(callId, "immediate_mode_on_start"); }
      else if (activationMode === 'VAD') {
        callResources.isVADBufferingActive = true;
        const vadConfig = appRecogConf.vadConfig;
        const talkDetectValue = `${vadConfig.vadRecognitionActivationMs},${vadConfig.vadSilenceThresholdMs}`;
        callLogger.info(`VAD mode: Setting TALK_DETECT on channel ${callId} with value: ${talkDetectValue}`);
        try { await incomingChannel.setChannelVar({ variable: 'TALK_DETECT(set)', value: talkDetectValue }); }
        catch (e:any) { callLogger.error(`FATAL: Failed to set TALK_DETECT: ${e.message}. Cleaning up.`); await this._fullCleanup(callId, true, "TALK_DETECT_SETUP_FAILED"); return; }
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
      if (greetingAudio && this.client && !callResources.promptPlaybackStoppedForInterim) {
        callResources.mainPlayback = this.client.playbacks.create({ targetUri: `channel:${callId}`, media: greetingAudio });
        await callResources.mainPlayback.control();
      } else {
        if (activationMode === 'FIXED_DELAY') { // Corrected comparison
            const delaySeconds = appRecogConf.bargeInDelaySeconds ?? 0.5;
            if(delaySeconds > 0) { callResources.bargeInActivationTimer = setTimeout(() => { if(!callResources.isCleanupCalled) this._activateOpenAIStreaming(callId, "fixedDelay_no_greeting_timer"); }, delaySeconds * 1000); }
            else { this._activateOpenAIStreaming(callId, "fixedDelay_no_greeting_immediate");}
        } else if (activationMode === 'VAD') { this._handlePostPromptVADLogic(callId); }
      }
      callLogger.info(`StasisStart setup complete for call ${callId}.`);
    } catch (err: any) {
      callLogger.error(`Error in StasisStart for ${callId}: ${(err instanceof Error ? err.message : String(err))}`);
      await this._fullCleanup(callId, true, "STASIS_START_ERROR");
    }
  }

  private onAppOwnedChannelStasisEnd(event: any, channel: Channel): void { /* ... */ }
  private async onStasisEnd(event: any, channel: Channel): Promise<void> { /* ... */ }
  private _clearCallTimers(call: CallResources): void { /* ... */ }
  private async _fullCleanup(callId: string, hangupMainChannel: boolean, reason: string): Promise<void> {  /* ... */  }
  private async cleanupCallResources(channelId: string, hangupChannel: boolean = false, isAriClosing: boolean = false, loggerInstance?: any ): Promise<void> {
      const call = this.activeCalls.get(channelId);
      const reason = isAriClosing ? "ARI_CONNECTION_CLOSED" : (hangupChannel ? "EXPLICIT_HANGUP_COMMAND" : "INTERNAL_FLOW_OR_ERROR");
      // Corrected: Use channelId for the logger if call is not found initially
      const currentLogger = loggerInstance || (call ? call.callLogger : this.logger.child({ callId: channelId, action: 'cleanupCallResources'}));

      if (!call || call.isCleanupCalled) {
          currentLogger.debug(`Cleanup not needed or already done for ${channelId}. Reason: ${reason}`);
          return;
      }
      await this._fullCleanup(channelId, hangupChannel && !isAriClosing, reason);
  }
  private onAriError(err: Error): void { /* ... */ }
  private onAriClose(): void { /* ... */ }
  public async playbackAudio(channelId: string, audioPayloadB64: string): Promise<void> { /* ... */ }
  public async endCall(channelId: string): Promise<void> { /* ... */ }
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
