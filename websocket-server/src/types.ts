// Basic interface for the ARI client, to be expanded as needed
// This will be replaced by the more detailed AriClientInterface below.
// export interface AriClient {
//   playbackAudio: (channelId: string, audioPayload: string) => void;
//   endCall: (channelId: string) => void;
//   // Add other methods like startExternalMedia, answerCall etc. as they are implemented
// }

// Information related to an active Asterisk call
export interface AriCallInfo {
  channelId: string;
  ariClient: AriClientInterface; // Using the new AriClientInterface
}

export interface FunctionCallItem {
  name: string;
  arguments: string;
  call_id?: string;
}

export interface FunctionSchema {
  name: string;
  type: "function";
  description?: string;
  parameters: {
    type: string;
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

export interface FunctionHandler {
  schema: FunctionSchema;
  handler: (args: any) => Promise<string>;
}

// Configuration Types based on default.json structure

export interface VadConfig {
  vadSilenceThresholdMs: number; // For TALK_DETECT silence duration
  vadRecognitionActivationMs: number; // For TALK_DETECT talk duration (previously vadTalkThresholdMs)
}

export interface AppRecognitionConfig {
  recognitionActivationMode: "VAD" | "MANUAL" | "IMMEDIATE" | "FIXED_DELAY"; // Expanded modes
  noSpeechBeginTimeoutSeconds: number;
  speechCompleteTimeoutSeconds: number;
  initialOpenAIStreamIdleTimeoutSeconds?: number;
  vadConfig: VadConfig;
  maxRecognitionDurationSeconds?: number;
  greetingAudioPath?: string;
  bargeInDelaySeconds?: number; // For FIXED_DELAY mode, moved here for consistency from direct usage

  vadRecogActivation?: 'vadMode' | 'afterPrompt'; // How VAD initiates recognition stream
  vadInitialSilenceDelaySeconds?: number; // Delay before VAD becomes active (for vadMode)
  vadActivationDelaySeconds?: number; // Additional delay after prompt before VAD becomes active (for vadMode)
  vadMaxWaitAfterPromptSeconds?: number; // Max time to wait for speech after a prompt in VAD mode
}

export interface DtmfConfig {
  dtmfEnabled: boolean;
  dtmfInterdigitTimeoutSeconds: number;
  dtmfMaxDigits: number;
  dtmfTerminatorDigit: string;
  dtmfFinalTimeoutSeconds?: number; // Timeout after the last DTMF digit before finalizing input
}

export interface BargeInConfig {
  bargeInModeEnabled: boolean;
  bargeInDelaySeconds: number;
  noSpeechBargeInTimeoutSeconds: number;
}

export interface AppConfig {
  appRecognitionConfig: AppRecognitionConfig;
  dtmfConfig: DtmfConfig;
  bargeInConfig: BargeInConfig;
}

export interface OpenAIRealtimeAPIConfig {
  model?: string;
  sttModel?: string; // e.g., "whisper-1"
  ttsModel?: string; // e.g., "tts-1"
  language?: string; // e.g., "en" or "en-US"
  inputAudioFormat?: string; // e.g., "pcm_s16le", "g711_ulaw"
  inputAudioSampleRate?: number; // e.g., 8000, 16000
  outputAudioFormat?: string; // e.g., "mp3", "pcm_s16le"
  outputAudioSampleRate?: number; // e.g., 24000, 16000
  ttsVoice?: string; // e.g., "alloy"
  transcriptionIntentOnly?: boolean; // Custom flag if STT is only for intent not full conversation

  // Deprecated fields, kept for potential reference or if used by older configs:
  audioFormat?: string;
  encoding?: string;
  sampleRate?: number;
  // For any other custom session parameters for OpenAI
  saved_config?: Record<string, any>;
  apiKey?: string; // This was present before, sessionManager now sources from env.
}

export interface LoggingConfig {
  level: "debug" | "info" | "warn" | "error"; // Common log levels
}

export interface RuntimeConfig {
  appConfig: AppConfig;
  openAIRealtimeAPI: OpenAIRealtimeAPIConfig;
  logging: LoggingConfig;
}

export interface CallSpecificConfig extends RuntimeConfig {
}

// Definition for a generic logger instance
export interface LoggerInstance {
  info: (message: string, ...args: any[]) => void;
  error: (message: string, ...args: any[]) => void;
  warn: (message: string, ...args: any[]) => void;
  debug: (message: string, ...args: any[]) => void;
  child: (bindings: object) => LoggerInstance;
  silly?: (message: string, ...args: any[]) => void; // Added
  isLevelEnabled?: (level: string) => boolean;    // Added
}

// Interface for the AriClientService that sessionManager will interact with
export interface AriClientInterface {
  logger: LoggerInstance; // Expose logger for sessionManager if needed
  _onOpenAISpeechStarted: (callId: string) => void;
  _onOpenAIInterimResult: (callId: string, transcript: string) => void;
  _onOpenAIFinalResult: (callId: string, transcript: string) => void;
  _onOpenAIError: (callId: string, error: any) => void;
  _onOpenAISessionEnded: (callId: string, reason: string) => void;
  playbackAudio: (channelId: string, audioPayloadB64: string) => Promise<void>; // Added based on _playTTSToCaller usage
  // Potentially other methods like endCall, if sessionManager needs to trigger them directly
}

// Renaming the old AriClient to avoid conflict if it's still used elsewhere,
// though it's better to fully transition to AriClientInterface.
// Removing problematic self-referential export:
// export { AriClient as DeprecatedAriClient } from './types';
