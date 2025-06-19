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
  } catch (error) {
    logger.error(`Config load error from ${configFilePath}: ${error.message}. Using hardcoded fallbacks.`);
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

  return callConfig;
}

// --- Global Constants ---
const ASTERISK_ARI_URL = process.env.ASTERISK_ARI_URL || 'http://localhost:8088';
const ASTERISK_ARI_USERNAME = process.env.ASTERISK_ARI_USERNAME || 'asterisk';
const ASTERISK_ARI_PASSWORD = process.env.ASTERISK_ARI_PASSWORD || 'asterisk';
const ASTERISK_ARI_APP_NAME = process.env.ASTERISK_ARI_APP_NAME || 'openai-ari-app';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const DEFAULT_RTP_HOST_IP = process.env.RTP_HOST_IP || '127.0.0.1'; // Used by RTP server if not specified in config
const DEFAULT_AUDIO_FORMAT_FOR_EXTERNAL_MEDIA = process.env.AUDIO_FORMAT_FOR_EXTERNAL_MEDIA || 'ulaw'; // Fallback for Asterisk external media
const MAX_VAD_BUFFER_PACKETS = 200; // Max audio packets to buffer for VAD before OpenAI stream starts (approx 4 seconds of ulaw)

if (!OPENAI_API_KEY) { moduleLogger.error("FATAL: OPENAI_API_KEY environment variable is required."); }

/**
 * Interface defining the resources and state managed for each active call.
 */
interface CallResources {
  channel: Channel;                       // Main Asterisk channel for the call
  config: CallSpecificConfig;             // Resolved configuration for this specific call
  callLogger: any;                        // Logger instance specific to this call (child of moduleLogger)

  // ARI Resources
  userBridge?: Bridge;                    // Bridge holding the user channel
  snoopBridge?: Bridge;                   // Bridge for snoop and external media channels
  rtpServer?: RtpServer;                  // RTP server instance for receiving audio from Asterisk
  externalMediaChannel?: Channel;         // Channel used by Asterisk to send audio to the RTP server
  snoopChannel?: Channel;                 // Snoop channel on the user's audio

  // Playback Management
  mainPlayback?: Playback;                // Main playback (e.g., greeting)
  waitingPlayback?: Playback;             // Playback for waiting/hold music (TODO: not fully implemented)
  postRecognitionWaitingPlayback?: Playback; // Playback after recognition ends (TODO: not fully implemented)

  // Call State Flags
  isCleanupCalled: boolean;               // True if _fullCleanup has been initiated for this call
  promptPlaybackStoppedForInterim: boolean; // True if mainPlayback was stopped due to interim transcript/VAD
  fallbackAttempted: boolean;             // TODO: For future offline speech-to-text fallback
  openAIStreamError: any;                 // Stores any error object from the OpenAI stream
  openAIStreamingActive: boolean;         // True if OpenAI session is active and audio should be streamed
  isOpenAIStreamEnding: boolean;          // TODO: True if OpenAI session is being gracefully closed by us
  speechHasBegun: boolean;                // True once speech is detected (by OpenAI or VAD)
  finalTranscription: string;             // Stores the final transcript from OpenAI

  // DTMF State
  collectedDtmfDigits: string;            // Accumulates received DTMF digits
  dtmfModeActive: boolean;                // True if DTMF input is currently being processed (speech recognition paused)
  speechRecognitionDisabledDueToDtmf: boolean; // True if speech recognition was explicitly paused for DTMF
  dtmfInterruptedSpeech: boolean;         // True if DTMF input interrupted an ongoing speech/OpenAI stream

  // VAD (Voice Activity Detection) State
  vadSpeechDetected: boolean;             // Current VAD status from TALK_DETECT events
  vadAudioBuffer: Buffer[];               // Buffers audio during VAD before OpenAI stream starts
  isVADBufferingActive: boolean;          // True when VAD is active and audio should be buffered
  isFlushingVADBuffer: boolean;           // TODO: True when VAD buffer is being sent (currently flushed in one go)
  pendingVADBufferFlush: boolean;         // Flag to indicate buffered VAD audio needs to be sent
  vadRecognitionTriggeredAfterInitialDelay: boolean; // True if VAD (not prompt/timer) triggered OpenAI stream
  vadSpeechActiveDuringDelay: boolean;    // True if speech was detected by VAD during initial VAD startup delays
  vadInitialSilenceDelayCompleted: boolean; // Flag for VAD initial silence delay timer
  vadActivationDelayCompleted: boolean;   // Flag for VAD activation delay timer

  // Timer Handles (NodeJS.Timeout | null for all)
  bargeInActivationTimer: NodeJS.Timeout | null;    // For FIXED_DELAY mode: activates OpenAI stream after delay
  noSpeechBeginTimer: NodeJS.Timeout | null;        // After OpenAI stream starts, times out if no speech/transcript
  initialOpenAIStreamIdleTimer: NodeJS.Timeout | null; // After OpenAI stream starts, times out if stream is unresponsive
  speechEndSilenceTimer: NodeJS.Timeout | null;     // After interim transcript, times out if silence follows
  maxRecognitionDurationTimer: NodeJS.Timeout | null; // Overall max duration for the call's recognition phase
  dtmfInterDigitTimer: NodeJS.Timeout | null;       // Timeout between DTMF digits
  dtmfFinalTimer: NodeJS.Timeout | null;            // Final timeout after last DTMF digit to process collected input
  vadMaxWaitAfterPromptTimer: NodeJS.Timeout | null; // In VAD 'afterPrompt' mode, max time to wait for speech after prompt
  vadActivationDelayTimer: NodeJS.Timeout | null;    // In VAD 'vadMode', delay before VAD becomes active after prompt
  vadInitialSilenceDelayTimer: NodeJS.Timeout | null; // In VAD 'vadMode', initial silence period before VAD activates
}

/**
 * Manages Asterisk Realtime Interface (ARI) connections and call lifecycle for OpenAI integration.
 */
export class AriClientService implements AriClientInterface {
  private client: Ari.Client | null = null;             // ARI client instance
  private activeCalls = new Map<string, CallResources>(); // Map of active calls, keyed by main channel ID
  private appOwnedChannelIds = new Set<string>();       // Set of channel IDs created by this app (e.g., externalMedia, snoop)
  private logger = moduleLogger;                        // Logger instance for the service
  private openaiApiKey: string;                         // OpenAI API Key
  private baseConfig: RuntimeConfig;                    // Base configuration loaded at startup

  constructor(openaiApiKey: string) {
    this.openaiApiKey = openaiApiKey;
    if (!this.openaiApiKey) { this.logger.error("FATAL: OPENAI_API_KEY is essential and was not provided."); } // More emphasis
    this.baseConfig = getCallSpecificConfig(this.logger.child({ context: 'AriBaseConfigLoad' })); // Load base config at startup
    this.logger = this.logger.child({ service: 'AriClientService' }); // Create a child logger for this service
  }

  /**
   * Connects to the Asterisk ARI interface and starts the Stasis application.
   */
  public async connect(): Promise<void> {
    try {
      this.client = await Ari.connect(ASTERISK_ARI_URL, ASTERISK_ARI_USERNAME, ASTERISK_ARI_PASSWORD);
      this.logger.info('Successfully connected to Asterisk ARI.');

      // Register global ARI event handlers
      this.client.on('StasisStart', this.onStasisStart.bind(this));
      this.client.on('ChannelDtmfReceived', this._onDtmfReceived.bind(this));
      this.client.on('PlaybackFinished', this.onPlaybackFinished.bind(this));
      this.client.on('PlaybackFailed', this.onPlaybackFailed.bind(this));
      this.client.on('ChannelTalkingStarted', this._onChannelTalkingStarted.bind(this));
      this.client.on('ChannelTalkingFinished', this._onChannelTalkingFinished.bind(this));
      this.client.on('error', (err) => this.onAriError(err)); // Handle generic ARI errors
      this.client.on('close', () => this.onAriClose());     // Handle ARI connection closure

      await this.client.start(ASTERISK_ARI_APP_NAME);
      this.logger.info(`ARI Stasis application '${ASTERISK_ARI_APP_NAME}' started and listening for calls.`);
    } catch (err) {
      this.logger.error('FATAL: Failed to connect to Asterisk ARI or start Stasis app:', err);
      throw err; // Propagate error to halt server startup if critical
    }
  }

  // --- OpenAI Event Callback Implementations ---
  // These methods are called by sessionManager based on events from the OpenAI Realtime API.

  public _onOpenAISpeechStarted(callId: string): void {
    const call = this.activeCalls.get(callId);
    if (!call || call.isCleanupCalled) return;
    call.callLogger.info('OpenAI speech recognition started (or first transcript received).');
    // Clear timer that waits for initial speech, as speech has now begun.
    if (call.noSpeechBeginTimer) { clearTimeout(call.noSpeechBeginTimer); call.noSpeechBeginTimer = null; }
    // Clear stream idle timer as we've received data.
    if (call.initialOpenAIStreamIdleTimer) { clearTimeout(call.initialOpenAIStreamIdleTimer); call.initialOpenAIStreamIdleTimer = null; }
    call.speechHasBegun = true;
  }

  public _onOpenAIInterimResult(callId: string, transcript: string): void {
    const call = this.activeCalls.get(callId);
    if (!call || call.isCleanupCalled) return;
    call.callLogger.debug(`OpenAI interim transcript: "${transcript}"`);

    if (!call.speechHasBegun) { // If speech_started wasn't explicit from OpenAI
        if (call.noSpeechBeginTimer) { clearTimeout(call.noSpeechBeginTimer); call.noSpeechBeginTimer = null; }
        if (call.initialOpenAIStreamIdleTimer) { clearTimeout(call.initialOpenAIStreamIdleTimer); call.initialOpenAIStreamIdleTimer = null; }
        call.speechHasBegun = true;
        call.callLogger.info('Speech implicitly started with first interim transcript.');
    }

    // If a greeting or prompt is playing and barge-in is enabled (implicitly by receiving interim result), stop it.
    if (call.mainPlayback && !call.promptPlaybackStoppedForInterim && call.config.appConfig.bargeInConfig.bargeInModeEnabled) {
      call.callLogger.info('Stopping main prompt due to interim transcript (barge-in).');
      this._stopAllPlaybacks(call).catch(e => call.callLogger.error("Error stopping playback on interim: " + e.message));
      call.promptPlaybackStoppedForInterim = true;
    }

    // Restart silence timer: if no more results for a period, consider utterance complete.
    if (call.speechEndSilenceTimer) clearTimeout(call.speechEndSilenceTimer);
    const silenceTimeout = (call.config.appConfig.appRecognitionConfig.speechCompleteTimeoutSeconds ?? 5) * 1000;
    call.speechEndSilenceTimer = setTimeout(() => {
      if (call.isCleanupCalled || !call.openAIStreamingActive) return; // Only act if stream is supposed to be active
      call.callLogger.warn(`Silence detected for ${silenceTimeout}ms after interim transcript. Stopping OpenAI session for this turn.`);
      sessionManager.stopOpenAISession(callId, 'interim_result_silence_timeout');
      // Note: This stops the current OpenAI stream. The call might not end immediately.
      // Further logic (e.g., playing a response, waiting for next interaction, or a specific "no final result" timeout) would be needed here.
      // For now, this relies on other overarching timers like maxRecognitionDurationTimer or application logic to fully end the call if needed.
    }, silenceTimeout);
  }

  public _onOpenAIFinalResult(callId: string, transcript: string): void {
    const call = this.activeCalls.get(callId);
    if (!call || call.isCleanupCalled) return;
    call.callLogger.info(`OpenAI final transcript received: "${transcript}"`);

    if (call.speechEndSilenceTimer) { clearTimeout(call.speechEndSilenceTimer); call.speechEndSilenceTimer = null; }
    call.finalTranscription = transcript; // Store final transcript

    // TODO: Set FINAL_TRANSCRIPTION channel variable on Asterisk channel
    // if (call.channel) {
    //   call.channel.setVariable({ variable: 'FINAL_TRANSCRIPTION', value: transcript })
    //     .catch(e => call.callLogger.warn(`Error setting FINAL_TRANSCRIPTION: ${e.message}`));
    // }

    // Stop the OpenAI session as we have a final result for this interaction turn.
    // sessionManager.stopOpenAISession(callId, 'final_result_received'); // sessionManager's 'close' handler will call _onOpenAISessionEnded
    // Current application design: A final transcript concludes the interaction.
    this._fullCleanup(callId, false, "FINAL_TRANSCRIPT_RECEIVED");
  }

  public _onOpenAIError(callId: string, error: any): void {
    const call = this.activeCalls.get(callId);
    if (!call || call.isCleanupCalled) return;
    call.callLogger.error('OpenAI stream error reported by sessionManager:', error);
    call.openAIStreamError = error; // Store the error
    // TODO: Set error-related channel variable on Asterisk channel
    this._fullCleanup(callId, true, "OPENAI_STREAM_ERROR"); // Terminate call on stream error
  }

  public _onOpenAISessionEnded(callId: string, reason: string): void {
    const call = this.activeCalls.get(callId);
    if (!call || call.isCleanupCalled) return;

    call.callLogger.info(`OpenAI session ended event from sessionManager. Reason: ${reason}`);
    call.openAIStreamingActive = false; // Mark stream as inactive

    // If cleanup is not already in progress due to a final result or critical error,
    // this might be an unexpected end or a planned stop (e.g., by DTMF, silence timer).
    if (!call.finalTranscription && !call.openAIStreamError && !call.dtmfModeActive) {
        call.callLogger.warn(`OpenAI session ended (reason: ${reason}) without final transcript, error, or DTMF. Call may continue or timeout.`);
        // If this reason indicates a server-side termination or an issue, might need cleanup.
        // Example: if (reason.includes("error") || reason.includes("timeout")) {
        //   this._fullCleanup(callId, true, `OPENAI_SESSION_ENDED_${reason.replace(/\s/g, '_')}`);
        // }
    } else {
        call.callLogger.info(`OpenAI session ended (reason: ${reason}). This is likely part of a normal flow (final result, DTMF, error, or explicit stop).`);
    }
  }

  // --- Helper Methods ---

  /** Stops all known playbacks for a call. */
  private async _stopAllPlaybacks(call: CallResources): Promise<void> {
    const playbacksToStop = [call.mainPlayback, call.waitingPlayback, call.postRecognitionWaitingPlayback];
    for (const playback of playbacksToStop) {
      if (playback) {
        try {
          call.callLogger.debug(`Stopping playback ${playback.id}.`);
          await playback.stop();
        } catch (e:any) { call.callLogger.warn(`Error stopping playback ${playback.id}: ${e.message}`); }
      }
    }
    // Clear playback references
    call.mainPlayback = undefined;
    call.waitingPlayback = undefined;
    call.postRecognitionWaitingPlayback = undefined;
  }

  /** Handles incoming DTMF events. */
  private async _onDtmfReceived(event: ChannelDtmfReceived, channel: Channel): Promise<void> {
    const call = this.activeCalls.get(channel.id);
    if (!call || call.isCleanupCalled) { return; }
    if (call.channel.id !== channel.id) { return; } // Ensure DTMF is on primary channel

    call.callLogger.info(`DTMF digit '${event.digit}' received.`);
    if (!call.config.appConfig.dtmfConfig.dtmfEnabled) {
      call.callLogger.info('DTMF disabled by config. Ignoring.');
      return;
    }

    // Enter DTMF mode: halt speech activities
    call.callLogger.info('Entering DTMF mode: interrupting speech/VAD activities.');
    call.dtmfModeActive = true;
    call.speechRecognitionDisabledDueToDtmf = true;
    call.isVADBufferingActive = false;
    call.vadAudioBuffer = [];
    call.pendingVADBufferFlush = false;

    await this._stopAllPlaybacks(call); // Stop any ongoing prompts or audio

    if (call.openAIStreamingActive) {
      call.callLogger.info('DTMF interrupting active OpenAI stream.');
      call.dtmfInterruptedSpeech = true;
      sessionManager.stopOpenAISession(call.channel.id, 'dtmf_interrupt'); // Request session manager to stop stream
      call.openAIStreamingActive = false;
      // Clear timers related to active speech stream
      if (call.noSpeechBeginTimer) { clearTimeout(call.noSpeechBeginTimer); call.noSpeechBeginTimer = null; }
      if (call.initialOpenAIStreamIdleTimer) { clearTimeout(call.initialOpenAIStreamIdleTimer); call.initialOpenAIStreamIdleTimer = null; }
      if (call.speechEndSilenceTimer) { clearTimeout(call.speechEndSilenceTimer); call.speechEndSilenceTimer = null; }
      call.speechHasBegun = false;
    }

    // Clear VAD timers
    if(call.vadMaxWaitAfterPromptTimer) { clearTimeout(call.vadMaxWaitAfterPromptTimer); call.vadMaxWaitAfterPromptTimer = null; }
    if(call.vadActivationDelayTimer) { clearTimeout(call.vadActivationDelayTimer); call.vadActivationDelayTimer = null; }
    if(call.vadInitialSilenceDelayTimer) { clearTimeout(call.vadInitialSilenceDelayTimer); call.vadInitialSilenceDelayTimer = null; }

    call.collectedDtmfDigits += event.digit;
    call.callLogger.info(`Collected DTMF: ${call.collectedDtmfDigits}`);

    // Restart DTMF timers
    if (call.dtmfInterDigitTimer) clearTimeout(call.dtmfInterDigitTimer);
    const interDigitTimeout = (call.config.appConfig.dtmfConfig.dtmfInterdigitTimeoutSeconds ?? 2) * 1000;
    call.dtmfInterDigitTimer = setTimeout(() => {
      call.callLogger.info('DTMF inter-digit timer expired.');
    }, interDigitTimeout);

    if (call.dtmfFinalTimer) clearTimeout(call.dtmfFinalTimer);
    const finalTimeout = (call.config.appConfig.dtmfConfig.dtmfFinalTimeoutSeconds ?? 3) * 1000;
    call.dtmfFinalTimer = setTimeout(async () => {
      if (call.isCleanupCalled) return;
      call.callLogger.info(`DTMF final timeout. Digits: ${call.collectedDtmfDigits}`);
      if (call.dtmfModeActive && call.collectedDtmfDigits.length > 0) {
        try {
          await call.channel.setChannelVar({ variable: 'DTMF_RESULT', value: call.collectedDtmfDigits });
        } catch (e: any) { call.callLogger.error(`Error setting DTMF_RESULT: ${e.message}`); }
        this._fullCleanup(call.channel.id, false, "DTMF_FINAL_TIMEOUT");
      } else {
        this._fullCleanup(call.channel.id, false, "DTMF_FINAL_TIMEOUT_NO_DIGITS");
      }
    }, finalTimeout);

    // Check for terminator or max digits
    const dtmfConfig = call.config.appConfig.dtmfConfig;
    if (event.digit === dtmfConfig.dtmfTerminatorDigit) {
      call.callLogger.info('DTMF terminator digit received.');
      if (call.dtmfFinalTimer) clearTimeout(call.dtmfFinalTimer);
      try { await call.channel.setChannelVar({ variable: 'DTMF_RESULT', value: call.collectedDtmfDigits }); }
      catch (e:any) { call.callLogger.error(`Error setting DTMF_RESULT: ${e.message}`); }
      this._fullCleanup(call.channel.id, false, "DTMF_TERMINATOR_RECEIVED");
    } else if (call.collectedDtmfDigits.length >= (dtmfConfig.dtmfMaxDigits ?? 16)) {
      call.callLogger.info('Max DTMF digits reached.');
      if (call.dtmfFinalTimer) clearTimeout(call.dtmfFinalTimer);
      try { await call.channel.setChannelVar({ variable: 'DTMF_RESULT', value: call.collectedDtmfDigits }); }
      catch (e:any) { call.callLogger.error(`Error setting DTMF_RESULT: ${e.message}`); }
      this._fullCleanup(call.channel.id, false, "DTMF_MAX_DIGITS_REACHED");
    }
  }

  /** Activates the OpenAI streaming session for a call. */
  private async _activateOpenAIStreaming(callId: string, reason: string): Promise<void> {
    const call = this.activeCalls.get(callId);
    if (!call || call.isCleanupCalled || call.openAIStreamingActive) {
      if(call?.openAIStreamingActive) call.callLogger.debug(`Activate called but stream already active. Reason: ${reason}`);
      return;
    }
    call.callLogger.info(`Activating OpenAI streaming. Reason: ${reason}`);
    call.openAIStreamingActive = true; // Set flag immediately to prevent race conditions

    try {
      // Pass 'this' (AriClientService instance) to sessionManager for callbacks
      await sessionManager.startOpenAISession(callId, this, call.config);
      call.callLogger.info(`Session manager initiated OpenAI session for ${callId}.`);

      // If VAD buffered audio, flush it now that the stream is ready.
      if (call.pendingVADBufferFlush && call.vadAudioBuffer.length > 0) {
        call.callLogger.info(`Flushing ${call.vadAudioBuffer.length} VAD audio packets to OpenAI.`);
        call.isVADBufferingActive = false;
        for (const audioPayload of call.vadAudioBuffer) {
          sessionManager.sendAudioToOpenAI(callId, audioPayload);
        }
        call.vadAudioBuffer = [];
        call.pendingVADBufferFlush = false;
      }

      // Start timers related to an active OpenAI stream
      const noSpeechTimeout = call.config.appConfig.appRecognitionConfig.noSpeechBeginTimeoutSeconds;
      if (noSpeechTimeout > 0 && !call.speechHasBegun) { // Only start if speech hasn't already begun (e.g. via VAD pre-detection)
        call.noSpeechBeginTimer = setTimeout(() => {
          if (call.isCleanupCalled || call.speechHasBegun) return;
          call.callLogger.warn(`No speech from OpenAI in ${noSpeechTimeout}s. Stopping session & call.`);
          sessionManager.stopOpenAISession(callId, "no_speech_timeout_in_ari");
          this._fullCleanup(callId, true, "NO_SPEECH_BEGIN_TIMEOUT");
        }, noSpeechTimeout * 1000);
        call.callLogger.info(`NoSpeechBeginTimer started (${noSpeechTimeout}s).`);
      }

      const streamIdleTimeout = 10; // TODO: Make configurable: call.config.appConfig.appRecognitionConfig.openAIStreamIdleTimeoutSeconds
      call.initialOpenAIStreamIdleTimer = setTimeout(() => {
         if (call.isCleanupCalled || call.speechHasBegun) return;
         call.callLogger.warn(`OpenAI stream idle for ${streamIdleTimeout}s. Stopping session & call.`);
         sessionManager.stopOpenAISession(callId, "initial_stream_idle_timeout_in_ari");
         this._fullCleanup(callId, true, "OPENAI_STREAM_IDLE_TIMEOUT");
      }, streamIdleTimeout * 1000);
      call.callLogger.info(`InitialOpenAIStreamIdleTimer started (${streamIdleTimeout}s).`);

    } catch (error: any) {
        call.callLogger.error(`Error during _activateOpenAIStreaming for ${callId}: ${error.message}`);
        call.openAIStreamingActive = false; // Reset flag as activation failed
        this._onOpenAIError(callId, error); // Trigger error handling flow
    }
  }

  /** Handles completion of VAD startup delays for 'vadMode'. */
  private _handleVADDelaysCompleted(callId: string): void {
    const call = this.activeCalls.get(callId);
    if (!call || call.isCleanupCalled || call.config.appConfig.appRecognitionConfig.recognitionActivationMode !== 'VAD' || call.config.appConfig.appRecognitionConfig.vadRecogActivation !== 'vadMode') {
      return;
    }
    call.callLogger.debug(`VAD delays completed. InitialSilence: ${call.vadInitialSilenceDelayCompleted}, ActivationDelay: ${call.vadActivationDelayCompleted}`);

    if (call.vadInitialSilenceDelayCompleted && call.vadActivationDelayCompleted) {
      call.callLogger.info(`VAD 'vadMode': All initial delays completed.`);
      if (call.vadRecognitionTriggeredAfterInitialDelay || call.openAIStreamingActive) { return; }

      if (call.vadSpeechActiveDuringDelay) {
        call.callLogger.info('VAD 'vadMode': Speech detected during delays. Activating OpenAI stream.');
        this._activateOpenAIStreaming(callId, "vad_speech_during_delay_window");
        call.pendingVADBufferFlush = true;
        if(call.channel) {
            call.channel.setChannelVar({ variable: 'TALK_DETECT(remove)', value: 'true' })
                .catch(e => call.callLogger.warn(`VAD: Error removing TALK_DETECT: ${e.message}`));
        }
      } else {
        call.callLogger.info('VAD 'vadMode': Delays completed, no prior speech. Listening via TALK_DETECT.');
        this._handlePostPromptVADLogic(callId); // Check if any further VAD logic applies
      }
    }
  }

  /** Handles VAD logic after a prompt has played or if no prompt was played in VAD mode. */
  private _handlePostPromptVADLogic(callId: string): void {
    const call = this.activeCalls.get(callId);
    if (!call || call.isCleanupCalled || call.config.appConfig.appRecognitionConfig.recognitionActivationMode !== 'VAD') {
      return;
    }
    call.callLogger.info(`VAD: Handling post-prompt/no-prompt logic for mode '${call.config.appConfig.appRecognitionConfig.vadRecogActivation}'.`);

    const vadRecogActivation = call.config.appConfig.appRecognitionConfig.vadRecogActivation;

    if (vadRecogActivation === 'afterPrompt') {
      if (call.vadRecognitionTriggeredAfterInitialDelay || call.openAIStreamingActive) { return; }
      if (call.vadSpeechDetected) { // Speech was detected (likely during prompt via _onChannelTalkingStarted setting this flag)
        call.callLogger.info('VAD (afterPrompt): Speech previously detected. Activating OpenAI stream.');
        this._activateOpenAIStreaming(callId, "vad_afterPrompt_speech_during_prompt");
        call.pendingVADBufferFlush = true;
        if(call.channel) {
            call.channel.setChannelVar({ variable: 'TALK_DETECT(remove)', value: 'true' })
                .catch(e => call.callLogger.warn(`VAD: Error removing TALK_DETECT: ${e.message}`));
        }
      } else { // No speech detected during prompt, start max wait timer.
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
        } else { // Max wait is 0, implies we don't wait for VAD after prompt if no speech during prompt.
            call.callLogger.info('VAD (afterPrompt): Max wait is 0 and no speech during prompt. Ending call.');
            if(call.channel) { call.channel.setChannelVar({ variable: 'TALK_DETECT(remove)', value: 'true' }).catch(e => call.callLogger.warn(`VAD: Error removing TALK_DETECT: ${e.message}`)); }
            this._fullCleanup(callId, true, "VAD_MAX_WAIT_0_NO_SPEECH");
        }
      }
    } else if (vadRecogActivation === 'vadMode') {
      // This is called from _handleVADDelaysCompleted if no speech occurred *during* the delays.
      // At this point, TALK_DETECT is active and we are waiting for speech.
      // No specific timer is started here for 'vadMode' post-delays by default, relies on TALK_DETECT or maxRecognitionDurationTimer.
      call.callLogger.info("VAD (vadMode): Delays completed, no speech during delay. Actively listening via TALK_DETECT.");
    }
  }

  /** Handles TALK_DETECT speech started events from Asterisk. */
  private async _onChannelTalkingStarted(event: ChannelTalkingStarted, channel: Channel): Promise<void> {
    const call = this.activeCalls.get(channel.id);
    if (!call || call.channel.id !== channel.id || call.isCleanupCalled || call.config.appConfig.appRecognitionConfig.recognitionActivationMode !== 'VAD') {
      return;
    }
    call.callLogger.info(`TALK_DETECT: Speech started on channel ${channel.id}.`);

    if (call.vadRecognitionTriggeredAfterInitialDelay || call.openAIStreamingActive) { return; } // Already handled or streaming

    const vadRecogActivation = call.config.appConfig.appRecognitionConfig.vadRecogActivation;
    if (vadRecogActivation === 'vadMode') {
      if (!call.vadInitialSilenceDelayCompleted || !call.vadActivationDelayCompleted) {
        call.callLogger.debug('VAD (vadMode): Speech detected during initial VAD delays.');
        call.vadSpeechActiveDuringDelay = true;
        call.vadSpeechDetected = true;
        return;
      }
    } else if (vadRecogActivation === 'afterPrompt') {
      if (call.mainPlayback) { // If prompt is still playing
        call.callLogger.debug('VAD (afterPrompt): Speech detected during main prompt.');
        call.vadSpeechDetected = true;
        // Optionally, stop playback here if barge-in on VAD signal during prompt is desired
        // For now, _handlePostPromptVADLogic or this handler (if prompt finishes before VAD) will take action.
        return;
      }
    }

    // Conditions met to potentially trigger recognition (delays passed for 'vadMode', or prompt finished for 'afterPrompt')
    call.callLogger.info('VAD: Speech detected, proceeding to activate stream.');
    call.vadSpeechDetected = true; // General flag
    call.vadRecognitionTriggeredAfterInitialDelay = true;

    if (call.mainPlayback && !call.promptPlaybackStoppedForInterim) {
      try {
        call.callLogger.info('VAD: Stopping main prompt due to speech.');
        await call.mainPlayback.stop(); // This might trigger onPlaybackFinished
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

  /** Handles TALK_DETECT speech finished events from Asterisk. */
  private async _onChannelTalkingFinished(event: ChannelTalkingFinished, channel: Channel): Promise<void> {
    const call = this.activeCalls.get(channel.id);
    if (!call || call.channel.id !== channel.id || call.isCleanupCalled || call.config.appConfig.appRecognitionConfig.recognitionActivationMode !== 'VAD') {
      return;
    }
    call.callLogger.info(`TALK_DETECT: Speech finished. Duration: ${event.duration_ms}ms`);
    call.vadSpeechDetected = false; // Mark current VAD segment as ended
    if (!call.vadInitialSilenceDelayCompleted || !call.vadActivationDelayCompleted) {
        call.vadSpeechActiveDuringDelay = false;
    }
    // This event could be used to trigger end-of-utterance logic if OpenAI's VAD is not solely relied upon.
    // For now, primary end-of-utterance is handled by speechEndSilenceTimer after OpenAI interim results.
  }

  /** Handles PlaybackFinished events, primarily for greeting/prompts. */
  private async onPlaybackFinished(event: PlaybackFinished, playback: Playback): Promise<void> {
    for (const [callId, call] of this.activeCalls.entries()) {
      if (call.mainPlayback?.id === playback.id) {
        call.callLogger.info(`Main playback (greeting/prompt) finished.`);
        call.mainPlayback = undefined; // Clear the playback object

        const activationMode = call.config.appConfig.appRecognitionConfig.recognitionActivationMode;
        if (activationMode === 'VAD') {
          this._handlePostPromptVADLogic(callId); // VAD logic after prompt
        } else if (activationMode === 'fixedDelay') {
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
        // If 'immediate' mode, OpenAI stream might have already started. No specific action here.
        break;
      }
      // TODO: Handle other playback types (waitingPlayback, postRecognitionWaitingPlayback) if they are implemented.
    }
  }

  /** Handles PlaybackFailed events. */
  private async onPlaybackFailed(event: any, playback: Playback): Promise<void> {
    for (const [callId, call] of this.activeCalls.entries()) {
        if (call.mainPlayback?.id === playback.id) {
            call.callLogger.error(`Main playback (greeting/prompt) FAILED. Reason: ${event.message || 'Unknown'}`);
            call.mainPlayback = undefined;
            // If greeting fails, potentially try to activate stream or cleanup.
            const activationMode = call.config.appConfig.appRecognitionConfig.recognitionActivationMode;
            if (activationMode === 'immediate' || (activationMode === 'fixedDelay' && (call.config.appConfig.appRecognitionConfig.bargeInDelaySeconds ?? 0.5) <=0) ) {
                this._activateOpenAIStreaming(callId, `${activationMode}_greeting_failed_direct_activation`);
            } else if (activationMode === 'VAD') {
                this._handlePostPromptVADLogic(callId); // Treat as if prompt finished (silently)
            }
            break;
        }
    }
  }

  /** Main handler for new calls entering the Stasis application. */
  private async onStasisStart(event: any, incomingChannel: Channel): Promise<void> {
    const callId = incomingChannel.id;
    const callLogger = this.logger.child({ callId, channelName: incomingChannel.name }); // Create call-specific logger
    callLogger.info(`StasisStart: New call entering application '${ASTERISK_ARI_APP_NAME}'.`);

    if (this.appOwnedChannelIds.has(callId)) {
      callLogger.info(`Channel ${callId} is app-owned (e.g. externalMedia). Ignoring StasisStart.`); return;
    }

    const callConfig = getCallSpecificConfig(callLogger, incomingChannel);
    // TODO: Set callLogger level based on callConfig.logging.level

    // Initialize resources and state for this call
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
    callLogger.info(`Call resources initialized. Recognition mode: ${callConfig.appConfig.appRecognitionConfig.recognitionActivationMode}`);

    try {
      await incomingChannel.answer();
      callLogger.info(`Call answered.`);

      // Specific StasisEnd handler for this main channel to ensure its cleanup
      incomingChannel.once('StasisEnd', () => {
        callLogger.info(`Primary channel ${callId} StasisEnd event. Initiating cleanup.`);
        this._fullCleanup(callId, false, "PRIMARY_CHANNEL_STASIS_ENDED");
      });

      if (!this.client) { throw new Error("ARI client not connected during StasisStart."); }

      // --- Media Setup ---
      callResources.userBridge = await this.client.bridges.create({ type: 'mixing', name: `user_b_${callId}` });
      callLogger.debug(`User bridge ${callResources.userBridge.id} created.`);
      await callResources.userBridge.addChannel({ channel: callId });
      callLogger.debug(`User channel ${callId} added to user bridge.`);

      callResources.snoopBridge = await this.client.bridges.create({ type: 'mixing', name: `snoop_b_${callId}` });
      callLogger.debug(`Snoop bridge ${callResources.snoopBridge.id} created.`);

      callResources.rtpServer = new RtpServer(callLogger.child({ component: 'RtpServer'}));
      const rtpServerAddress = await callResources.rtpServer.start(0, DEFAULT_RTP_HOST_IP); // TODO: Use host from config
      callLogger.info(`RTP Server started at ${rtpServerAddress.host}:${rtpServerAddress.port}`);

      const externalMediaFormat = callConfig.openAIRealtimeAPI?.inputAudioFormat || DEFAULT_AUDIO_FORMAT_FOR_EXTERNAL_MEDIA;
      callResources.externalMediaChannel = await this.client.channels.externalMedia({
        app: ASTERISK_ARI_APP_NAME,
        external_host: `${rtpServerAddress.host}:${rtpServerAddress.port}`,
        format: externalMediaFormat, // Use configured input format for Asterisk -> RTP
      });
      this.appOwnedChannelIds.add(callResources.externalMediaChannel.id);
      callLogger.info(`External Media channel ${callResources.externalMediaChannel.id} created (format: ${externalMediaFormat}).`);

      // Snoop direction based on VAD mode for potentially more efficient audio processing.
      const snoopDirection = (callConfig.appConfig.appRecognitionConfig.recognitionActivationMode === 'VAD' ? 'in' : 'both') as ('in' | 'out' | 'both');
      callResources.snoopChannel = await this.client.channels.snoopChannelWithId({
        channelId: callId, snoopId: `snoop_${callId}`, app: ASTERISK_ARI_APP_NAME, spy: snoopDirection,
      });
      this.appOwnedChannelIds.add(callResources.snoopChannel.id);
      callLogger.info(`Snoop channel ${callResources.snoopChannel.id} created (direction: ${snoopDirection}).`);

      await callResources.snoopBridge.addChannel({ channel: callResources.externalMediaChannel.id });
      await callResources.snoopBridge.addChannel({ channel: callResources.snoopChannel.id });
      callLogger.debug(`External Media and Snoop channels added to snoop bridge.`);

      // --- RTP Audio Handling ---
      callResources.rtpServer.on('audioPacket', (audioPayload: Buffer) => {
        const call = this.activeCalls.get(callId); // Get current state of call resources
        if (call && !call.isCleanupCalled) {
          if (call.isVADBufferingActive) { // Buffer audio if VAD is active and waiting
            if (call.vadAudioBuffer.length < MAX_VAD_BUFFER_PACKETS) {
              call.vadAudioBuffer.push(audioPayload);
            } else { // Prevent excessive buffer growth
              call.callLogger.warn('VAD audio buffer limit reached. Oldest packet discarded.');
              call.vadAudioBuffer.shift();
              call.vadAudioBuffer.push(audioPayload);
            }
          }
          // Forward to OpenAI only if streaming is active and not VAD-buffering the initial segment
          if (call.openAIStreamingActive && !call.pendingVADBufferFlush) {
            sessionManager.sendAudioToOpenAI(callId, audioPayload);
          }
        }
      });

      // Notify SessionManager about the new call (passes ariClient instance for callbacks)
      sessionManager.handleCallConnection(callId, this.openaiApiKey, this);
      callLogger.info(`Call connection details passed to SessionManager.`);

      // --- Timers and Operational Mode Logic ---
      const appRecogConf = callConfig.appConfig.appRecognitionConfig;

      // Overall Max Recognition Duration Timer
      if (appRecogConf.maxRecognitionDurationSeconds && appRecogConf.maxRecognitionDurationSeconds > 0) {
        callResources.maxRecognitionDurationTimer = setTimeout(() => {
          if (callResources.isCleanupCalled) return;
          callLogger.warn(`Max recognition duration (${appRecogConf.maxRecognitionDurationSeconds}s) reached. Ending call.`);
          this._fullCleanup(callId, true, "MAX_RECOGNITION_DURATION_TIMEOUT");
        }, appRecogConf.maxRecognitionDurationSeconds * 1000);
        callLogger.info(`MaxRecognitionDurationTimer set for ${appRecogConf.maxRecognitionDurationSeconds}s.`);
      }

      const activationMode = appRecogConf.recognitionActivationMode;
      callLogger.info(`Starting call with recognition mode: ${activationMode}`);

      // Handle IMMEDIATE mode: activate OpenAI stream before/during greeting
      if (activationMode === 'IMMEDIATE') {
        this._activateOpenAIStreaming(callId, "immediate_mode_activation_on_start");
      }
      // Handle VAD mode setup
      else if (activationMode === 'VAD') {
        callResources.isVADBufferingActive = true; // Start buffering audio immediately for VAD
        const vadConfig = appRecogConf.vadConfig;
        const talkDetectValue = `${vadConfig.vadRecognitionActivationMs},${vadConfig.vadSilenceThresholdMs}`; // talk_duration,silence_duration
        callLogger.info(`VAD mode: Setting TALK_DETECT on channel ${callId} with value: ${talkDetectValue}`);
        try {
          await incomingChannel.setChannelVar({ variable: 'TALK_DETECT(set)', value: talkDetectValue });
        } catch (e:any) {
          callLogger.error(`FATAL: Failed to set TALK_DETECT for VAD mode: ${e.message}. Cleaning up.`);
          await this._fullCleanup(callId, true, "TALK_DETECT_SETUP_FAILED");
          return; // Critical failure for VAD mode
        }

        // Handle VAD sub-modes ('vadMode' with initial delays vs 'afterPrompt')
        if (appRecogConf.vadRecogActivation === 'vadMode') {
          callResources.vadInitialSilenceDelayCompleted = (appRecogConf.vadInitialSilenceDelaySeconds ?? 0) <= 0;
          callResources.vadActivationDelayCompleted = (appRecogConf.vadActivationDelaySeconds ?? 0) <= 0;

          if (!callResources.vadInitialSilenceDelayCompleted) {
            callLogger.info(`VAD (vadMode): Starting initial silence delay timer (${appRecogConf.vadInitialSilenceDelaySeconds}s).`);
            callResources.vadInitialSilenceDelayTimer = setTimeout(() => {
              if(callResources.isCleanupCalled) return;
              callLogger.info("VAD (vadMode): Initial silence delay completed.");
              callResources.vadInitialSilenceDelayCompleted = true; this._handleVADDelaysCompleted(callId);
            }, (appRecogConf.vadInitialSilenceDelaySeconds ?? 0) * 1000);
          }
          if (!callResources.vadActivationDelayCompleted) {
            callLogger.info(`VAD (vadMode): Starting activation delay timer (${appRecogConf.vadActivationDelaySeconds}s).`);
            callResources.vadActivationDelayTimer = setTimeout(() => {
              if(callResources.isCleanupCalled) return;
              callLogger.info("VAD (vadMode): Activation delay completed.");
              callResources.vadActivationDelayCompleted = true; this._handleVADDelaysCompleted(callId);
            }, (appRecogConf.vadActivationDelaySeconds ?? 0) * 1000);
          }
          // If no delays are configured, proceed to check VAD state
          if (callResources.vadInitialSilenceDelayCompleted && callResources.vadActivationDelayCompleted) {
             this._handleVADDelaysCompleted(callId);
          }
        }
        // For 'afterPrompt', TALK_DETECT is set, and logic is handled in onPlaybackFinished or _onChannelTalkingStarted
      }

      // Play Greeting (if any)
      const greetingAudio = appRecogConf.greetingAudioPath;
      if (greetingAudio && this.client && !callResources.promptPlaybackStoppedForInterim) { // Check if not already stopped by VAD/DTMF
        callLogger.info(`Playing greeting audio: ${greetingAudio}`);
        callResources.mainPlayback = this.client.playbacks.create({ targetUri: `channel:${callId}`, media: greetingAudio });
        await callResources.mainPlayback.control(); // Start playback
        callLogger.debug(`Greeting playback ${callResources.mainPlayback.id} started.`);
      } else {
        callLogger.info(greetingAudio ? 'Greeting playback skipped (e.g. promptPlaybackStoppedForInterim is true or no client).' : 'No greeting audio specified.');
        // If no greeting, trigger post-greeting logic directly for applicable modes
        if (activationMode === 'FIXED_DELAY') {
            const delaySeconds = appRecogConf.bargeInDelaySeconds ?? 0.5;
            callLogger.info(`FixedDelay mode (no greeting): Barge-in delay: ${delaySeconds}s.`);
            if(delaySeconds > 0) {
              if(callResources.bargeInActivationTimer) clearTimeout(callResources.bargeInActivationTimer);
              callResources.bargeInActivationTimer = setTimeout(() => { if(!callResources.isCleanupCalled) this._activateOpenAIStreaming(callId, "fixedDelay_no_greeting_timer_expired"); }, delaySeconds * 1000);
            } else {
              this._activateOpenAIStreaming(callId, "fixedDelay_no_greeting_immediate_activation");
            }
        } else if (activationMode === 'VAD') {
            this._handlePostPromptVADLogic(callId); // Handles logic as if a prompt just finished
        }
      }
      callLogger.info(`StasisStart setup complete for call ${callId}.`);
    } catch (err: any) { // Catch errors during setup
      callLogger.error(`Error during StasisStart setup for call ${callId}:`, err);
      await this._fullCleanup(callId, true, "STASIS_START_SETUP_ERROR");
    }
  }

  /** Handles StasisEnd events for app-owned utility channels (e.g. externalMedia, snoop). */
  private onAppOwnedChannelStasisEnd(event: any, channel: Channel): void {
    this.logger.debug(`App-owned utility channel ${channel.id} (${channel.name}) left Stasis. Removing from tracking.`);
    this.appOwnedChannelIds.delete(channel.id);
    // These channels are typically cleaned up (hung up) during _fullCleanup of the main call.
    // No further action usually needed here unless specific resource recovery for that channel type.
  }

  /** Generic StasisEnd handler, primarily as a fallback or for utility channels not tied to a specific call's lifecycle. */
  private async onStasisEnd(event: any, channel: Channel): Promise<void> {
    // This is a global handler. The specific StasisEnd for the *main user channel* is handled by
    // the .once('StasisEnd', ...) listener attached in onStasisStart.
    const callId = channel.id;
    if (this.appOwnedChannelIds.has(callId)) {
        this.onAppOwnedChannelStasisEnd(event, channel); // Delegate to specific handler
        return;
    }

    const call = this.activeCalls.get(callId);
    if (call && !call.isCleanupCalled) {
      // This might be an unexpected StasisEnd for a call if its specific handler wasn't triggered.
      call.callLogger.warn(`Generic StasisEnd handler caught end for main channel ${callId} (might be duplicate or unexpected).`);
      // await this._fullCleanup(callId, false, "GENERIC_STASIS_END_UNEXPECTED");
    } else if (call && call.isCleanupCalled) {
       // call.callLogger.debug(`Generic StasisEnd: Cleanup already processed for channel ${callId}.`);
    } else {
      // this.logger.debug(`Generic StasisEnd: No active call or cleanup already done for unmanaged channel ${channel.id}.`);
    }
  }

  /** Clears all active timers for a given call. */
  private _clearCallTimers(call: CallResources): void {
    const timers: (keyof CallResources)[] = [
      'bargeInActivationTimer', 'noSpeechBeginTimer', 'initialOpenAIStreamIdleTimer',
      'speechEndSilenceTimer',
      'maxRecognitionDurationTimer',
      'dtmfInterDigitTimer', 'dtmfFinalTimer',
      'vadMaxWaitAfterPromptTimer', 'vadActivationDelayTimer', 'vadInitialSilenceDelayTimer'
    ];
    timers.forEach(timerName => {
      if (call[timerName]) {
        clearTimeout(call[timerName] as NodeJS.Timeout);
        (call[timerName] as NodeJS.Timeout | null) = null; // Set to null after clearing
      }
    });
    call.callLogger.debug('All application-level call timers cleared.');
  }

  /** Performs comprehensive cleanup of all resources associated with a call. */
  private async _fullCleanup(callId: string, hangupMainChannel: boolean, reason: string): Promise<void> {
    const call = this.activeCalls.get(callId);
    if (!call) {
      this.logger.warn(`_fullCleanup called for unknown or already cleaned callId ${callId}. Reason: ${reason}.`);
      return;
    }
    if (call.isCleanupCalled) {
      call.callLogger.debug(`_fullCleanup already initiated for callId ${callId}. Reason: ${reason}. Ignoring duplicate call.`);
      return;
    }

    call.isCleanupCalled = true; // Mark cleanup as started to prevent re-entry
    call.callLogger.info(`Initiating full cleanup for call ${callId}. Reason: ${reason}. Hangup main channel: ${hangupMainChannel}`);

    this._clearCallTimers(call); // Clear all timers first

    // Stop OpenAI stream if it was active
    if (call.openAIStreamingActive) {
      call.callLogger.info('OpenAI stream was active, requesting sessionManager to stop it.');
      sessionManager.stopOpenAISession(callId, `cleanup_reason_${reason}`);
      call.openAIStreamingActive = false; // Mark as inactive locally
    }

    await this._stopAllPlaybacks(call); // Stop any ongoing playbacks

    // Stop RTP server
    if (call.rtpServer?.isReady()) {
      try { await call.rtpServer.stop(); call.callLogger.info('RTP server stopped.'); }
      catch (e:any) { call.callLogger.error(`Error stopping RTP server: ${e.message}`); }
    }

    // Hangup utility channels (snoop, external media)
    const utilityChannels = [call.snoopChannel, call.externalMediaChannel];
    for (const chan of utilityChannels) {
      if (chan) {
        this.appOwnedChannelIds.delete(chan.id); // Remove from tracking
        try { call.callLogger.debug(`Hanging up utility channel ${chan.id}.`); await chan.hangup(); }
        catch (e:any) { call.callLogger.warn(`Error hanging up utility channel ${chan.id}: ${e.message}`); }
      }
    }
    call.snoopChannel = undefined; call.externalMediaChannel = undefined;

    // Destroy bridges
    const bridgesToDestroy = [call.userBridge, call.snoopBridge];
    for (const bridge of bridgesToDestroy) {
      if (bridge) {
        try { call.callLogger.debug(`Destroying bridge ${bridge.id}.`); await bridge.destroy(); }
        catch (e:any) { call.callLogger.warn(`Error destroying bridge ${bridge.id}: ${e.message}`); }
      }
    }
    call.userBridge = undefined; call.snoopBridge = undefined;

    // Hangup main user channel if requested and not already handled by StasisEnd
    if (hangupMainChannel && call.channel) {
      try {
        call.callLogger.info(`Attempting to hang up main channel ${call.channel.id}.`);
        await call.channel.hangup();
        call.callLogger.info(`Main channel ${call.channel.id} hung up successfully.`);
      } catch (e:any) {
        // Common error if channel already hung up (e.g., by StasisEnd)
        if (e.message && (e.message.includes("Channel not found") || e.message.includes("does not exist"))) {
            call.callLogger.warn(`Main channel ${call.channel.id} already hung up or not found.`);
        } else {
            call.callLogger.error(`Error hanging up main channel ${call.channel.id}: ${e.message}`);
        }
      }
    }

    // Remove call from active calls map
    this.activeCalls.delete(callId);
    call.callLogger.info('ARI client local resource cleanup complete.');

    // Notify SessionManager that the ARI side of the call has ended and resources are cleaned.
    // This allows sessionManager to clean up its corresponding session state.
    sessionManager.handleAriCallEnd(callId);
  }

  /** Wrapper for _fullCleanup, typically used by external triggers or less specific event handlers. */
  private async cleanupCallResources(channelId: string, hangupChannel: boolean = false, isAriClosing: boolean = false, loggerInstance?: any ): Promise<void> {
      const call = this.activeCalls.get(channelId);
      const reason = isAriClosing ? "ARI_CONNECTION_CLOSED" : (hangupChannel ? "EXPLICIT_HANGUP_COMMAND" : "INTERNAL_FLOW_OR_ERROR");
      const currentLogger = loggerInstance || (call ? call.callLogger : this.logger.child({callId, action: 'cleanupCallResources'}));

      if (!call || call.isCleanupCalled) {
          currentLogger.debug(`Cleanup not needed or already done for ${channelId}. Reason: ${reason}`);
          return;
      }
      // If ARI is closing, Asterisk will handle channel hangups. Don't actively hangup.
      await this._fullCleanup(channelId, hangupChannel && !isAriClosing, reason);
  }

  /** Handles generic ARI client errors. */
  private onAriError(err: Error): void {
    this.logger.error('General ARI Client Error:', err);
    // This could be a connection error or other unhandled issue from the ari-client library.
    // Consider if all calls need to be cleaned up or if a reconnect attempt is viable.
  }

  /** Handles closure of the ARI connection. */
  private onAriClose(): void {
    this.logger.info('ARI Connection Closed. Cleaning up all active calls as Asterisk is no longer connected.');
    Array.from(this.activeCalls.keys()).forEach(callId => {
      // isAriClosing = true, so main channel hangup will be skipped in _fullCleanup
      this.cleanupCallResources(callId, false, true);
    });
    this.client = null; // Mark client as disconnected
    // TODO: Implement robust reconnection logic for the ARI client if desired.
  }

  /** Plays audio on a channel (simplified, used by sessionManager for OpenAI responses). */
  public async playbackAudio(channelId: string, audioPayloadB64: string): Promise<void> {
    const call = this.activeCalls.get(channelId);
    if (!call || call.isCleanupCalled || !call.channel || !this.client) {
      this.logger.error(`playbackAudio: Call ${channelId} not found, cleaned up, or client disconnected. Cannot play audio.`);
      return;
    }
    // TODO: Manage overlapping playbacks. This might interrupt existing playbacks or need queueing.
    // For now, create and play directly. This might need to be stored in call.waitingPlayback or similar.
    try {
      const playback = this.client.playbacks.create({ targetUri: `channel:${call.channel.id}`, media: 'sound:base64:' + audioPayloadB64 });
      call.callLogger.info(`Playing OpenAI audio response on channel ${call.channel.id}. Playback ID: ${playback.id}`);
      // No await on control() as we don't need to wait for it to finish here.
      // Eventual 'PlaybackFinished' or 'PlaybackFailed' will be handled by global handlers if needed.
    } catch (error: any) {
      call.callLogger.error(`Error initiating audio playback on channel ${call.channel.id}: ${error.message}`);
    }
  }

  /** Public method to explicitly end a call and its resources. */
  public async endCall(channelId: string): Promise<void> {
    const call = this.activeCalls.get(channelId);
    if (call) {
        call.callLogger.info(`External request to end call ${channelId}.`);
        await this._fullCleanup(channelId, true, "EXTERNAL_API_END_CALL_REQUEST");
    } else {
        this.logger.info(`External request to end call ${channelId}, but call not found or already cleaned.`);
    }
  }
}

// --- Singleton Instance and Initialization ---
let ariClientServiceInstance: AriClientService | null = null;

/**
 * Initializes and returns a singleton instance of the AriClientService.
 * Connects to ARI and starts the Stasis application.
 */
export async function initializeAriClient(): Promise<AriClientService> {
  if (!OPENAI_API_KEY) {
      moduleLogger.error("FATAL: Cannot initialize AriClientService - OPENAI_API_KEY is not set.");
      throw new Error("OPENAI_API_KEY is not set. Server cannot start.");
  }
  if (!ariClientServiceInstance) {
    ariClientServiceInstance = new AriClientService(OPENAI_API_KEY);
    await ariClientServiceInstance.connect(); // Connect to ARI
  }
  return ariClientServiceInstance;
}
[end of websocket-server/src/ari-client.ts]
