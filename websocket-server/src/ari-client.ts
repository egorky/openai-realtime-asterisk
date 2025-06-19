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

const moduleLogger = {
  info: console.log, error: console.error, warn: console.warn, debug: console.log, silly: console.log,
  isLevelEnabled: (level: string) => level !== 'silly',
  child: (bindings: object) => moduleLogger,
};

dotenv.config();

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

function getCallSpecificConfig(logger: any, channel?: Channel): CallSpecificConfig {
  const configFilePath = process.env.CONFIG_FILE_PATH || path.join(__dirname, '../config/default.json');
  let baseConfig: RuntimeConfig;
  try {
    const rawConfig = fs.readFileSync(configFilePath, 'utf-8');
    baseConfig = JSON.parse(rawConfig) as RuntimeConfig;
  } catch (e: unknown) {
    if (e instanceof Error) {
        logger.error(`Config load error from ${configFilePath}: ${e.message}. Using hardcoded fallbacks.`);
    } else {
        logger.error(`Config load error from ${configFilePath}: ${String(e)}. Using hardcoded fallbacks.`);
    }
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
  channel: Channel; config: CallSpecificConfig; callLogger: any; userBridge?: Bridge; snoopBridge?: Bridge;
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
      // PlaybackFinished and PlaybackFailed are now handled per-playback instance, not globally on client.
      // this.client.on('PlaybackFinished', this.onPlaybackFinished.bind(this)); // Removed
      // this.client.on('PlaybackFailed', this.onPlaybackFailed.bind(this));     // Removed
      this.client.on('ChannelTalkingStarted', this._onChannelTalkingStarted.bind(this));
      this.client.on('ChannelTalkingFinished', this._onChannelTalkingFinished.bind(this));
      this.client.on('error', (err: Error) => this.onAriError(err));
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

  public _onOpenAISpeechStarted(callId: string): void { /* ... existing code ... */ }
  public _onOpenAIInterimResult(callId: string, transcript: string): void { /* ... existing code ... */ }
  public _onOpenAIFinalResult(callId: string, transcript: string): void { /* ... existing code ... */ }
  public _onOpenAIError(callId: string, error: any): void { /* ... existing code ... */ }
  public _onOpenAISessionEnded(callId: string, reason: string): void { /* ... existing code ... */ }
  private async _stopAllPlaybacks(call: CallResources): Promise<void> { /* ... existing code ... */ }
  private async _onDtmfReceived(event: ChannelDtmfReceived, channel: Channel): Promise<void> { /* ... existing code ... */ }
  private async _activateOpenAIStreaming(callId: string, reason: string): Promise<void> { /* ... existing code ... */ }
  private _handleVADDelaysCompleted(callId: string): void { /* ... existing code ... */ }
  private _handlePostPromptVADLogic(callId: string): void { /* ... existing code ... */ }
  private async _onChannelTalkingStarted(event: ChannelTalkingStarted, channel: Channel): Promise<void> { /* ... existing code ... */ }

  private async _onChannelTalkingFinished(event: ChannelTalkingFinished, channel: Channel): Promise<void> {
    const call = this.activeCalls.get(channel.id);
    if (!call || call.channel.id !== channel.id || call.isCleanupCalled || call.config.appConfig.appRecognitionConfig.recognitionActivationMode !== 'VAD') {
      return;
    }
    // Corrected: event.duration from @types/ari-client
    call.callLogger.info(`TALK_DETECT: Speech finished. Duration: ${event.duration}ms`);
    call.vadSpeechDetected = false;
    if (!call.vadInitialSilenceDelayCompleted || !call.vadActivationDelayCompleted) {
        call.vadSpeechActiveDuringDelay = false;
    }
  }

  /**
   * Handles the completion or failure of a playback operation.
   * This method is now called by specific event handlers on individual playback objects.
   * @param callId The ID of the call.
   * @param reason A string indicating why this handler was called (e.g., 'main_greeting_finished', 'main_greeting_failed').
   */
  private _handlePlaybackFinished(callId: string, reason: string): void {
    const call = this.activeCalls.get(callId);
    if (!call || call.isCleanupCalled) {
      return;
    }

    if (reason.startsWith('main_greeting_')) {
      call.callLogger.info(`Handling post-greeting logic for call ${callId}. Reason: ${reason}`);
      call.mainPlayback = undefined; // Clear the playback object reference

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
      // If 'immediate' mode, OpenAI stream might have already started. No specific action here based on greeting.
    }
    // TODO: Handle other playback types (e.g. waitingPlayback) if needed
  }

  // Removed global onPlaybackFinished and onPlaybackFailed as they are now per-instance.

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
      if (greetingAudio && this.client) { // Removed promptPlaybackStoppedForInterim check here, as it's for barge-in
        callLogger.info(`Playing greeting audio: ${greetingAudio}`);
        // Corrected Playback Creation:
        callResources.mainPlayback = this.client.Playback(); // Create playback object

        if (callResources.mainPlayback) {
          // Attach event handlers to this specific playback instance
          callResources.mainPlayback.once('PlaybackFailed', (evt: any, instance: Playback) => {
            const currentCall = this.activeCalls.get(callId); // Refresh call object
            if (currentCall && instance.id === currentCall.mainPlayback?.id) { // Check if it's still the same playback
              currentCall.callLogger.warn(`Main greeting playback ${instance.id} FAILED for call ${callId}. Reason: ${evt.message || 'Unknown'}`);
              this._handlePlaybackFinished(callId, 'main_greeting_failed');
            }
          });
          callResources.mainPlayback.once('PlaybackFinished', (evt: any, instance: Playback) => {
            const currentCall = this.activeCalls.get(callId); // Refresh call object
            if (currentCall && instance.id === currentCall.mainPlayback?.id) {
              currentCall.callLogger.info(`Main greeting playback ${instance.id} FINISHED for call ${callId}.`);
              this._handlePlaybackFinished(callId, 'main_greeting_finished');
            }
          });

          // Initiate playback on the channel using the created playback's ID
          try {
            await callResources.channel.play({ media: greetingAudio, playbackId: callResources.mainPlayback.id });
            callLogger.info(`Started main greeting playback ${callResources.mainPlayback.id} on channel ${callId}`);
          } catch (playError: any) {
            callLogger.error(`Error STARTING main greeting playback for call ${callId}: ${(playError instanceof Error ? playError.message : String(playError))}`);
            this._handlePlaybackFinished(callId, 'main_greeting_playback_start_error');
          }
        } else {
           callLogger.error("Failed to create mainPlayback object.");
           this._handlePlaybackFinished(callId, 'main_greeting_creation_failed');
        }
        // Removed: await callResources.mainPlayback.control();
      } else { // No greeting audio or no client
        callLogger.info(greetingAudio ? 'Client not available for greeting playback.' : 'No greeting audio specified.');
        // If no greeting, directly trigger post-greeting logic for applicable modes
        if (activationMode === 'FIXED_DELAY') {
            const delaySeconds = appRecogConf.bargeInDelaySeconds ?? 0.5;
            if(delaySeconds > 0) { callResources.bargeInActivationTimer = setTimeout(() => { if(!callResources.isCleanupCalled) this._activateOpenAIStreaming(callId, "fixedDelay_no_greeting_timer"); }, delaySeconds * 1000); }
            else { this._activateOpenAIStreaming(callId, "fixedDelay_no_greeting_immediate");}
        } else if (activationMode === 'VAD') {
            this._handlePostPromptVADLogic(callId);
        }
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
  private async cleanupCallResources(channelId: string, hangupChannel: boolean = false, isAriClosing: boolean = false, loggerInstance?: any ): Promise<void> { /* ... */ }
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
