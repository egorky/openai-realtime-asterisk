// Basic interface for the ARI client, to be expanded as needed
export interface AriClient {
  playbackAudio: (channelId: string, audioPayload: string) => void;
  endCall: (channelId: string) => void;
  // Add other methods like startExternalMedia, answerCall etc. as they are implemented
}

// Information related to an active Asterisk call
export interface AriCallInfo {
  channelId: string;
  ariClient: AriClient; // Using the AriClient interface
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
  // vadMode: 'vadMode' | 'afterPrompt'; // Specific VAD activation mode - This seems to be 'vadRecogActivation' in JS example
}

export interface AppRecognitionConfig {
  recognitionActivationMode: "VAD" | "MANUAL" | "IMMEDIATE" | "FIXED_DELAY"; // Expanded modes
  noSpeechBeginTimeoutSeconds: number;
  speechCompleteTimeoutSeconds: number;
  vadConfig: VadConfig;
  maxRecognitionDurationSeconds?: number;
  greetingAudioPath?: string;
  bargeInDelaySeconds?: number; // For FIXED_DELAY mode, moved here for consistency from direct usage

  // VAD specific configurations
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
  model?: string; // e.g., "gpt-4o-realtime-preview-2024-12-17"
  language?: string; // e.g., "en-US"
  inputAudioFormat?: string; // e.g., "g711_ulaw", "pcm_s16le"
  inputAudioSampleRate?: number; // e.g., 8000, 16000
  outputAudioFormat?: string; // e.g., "g711_ulaw", "pcm_s16le"
  outputAudioSampleRate?: number; // e.g., 8000, 16000
  // Deprecated fields, kept for potential reference or if used by older configs:
  audioFormat?: string;
  encoding?: string;
  sampleRate?: number;
  // For any other custom session parameters for OpenAI
  saved_config?: Record<string, any>;
}

export interface LoggingConfig {
  level: "debug" | "info" | "warn" | "error"; // Common log levels
}

// This will be the structure of the config loaded from default.json and environment variables
export interface RuntimeConfig {
  appConfig: AppConfig;
  openAIRealtimeAPI: OpenAIRealtimeAPIConfig;
  logging: LoggingConfig;
  // Future: Add other top-level config sections here
}

// For call-specific config, which might have overrides from channel variables
export interface CallSpecificConfig extends RuntimeConfig {
  // Potentially add call-specific overrides or additional fields if needed in the future
  // For now, it's structurally the same as RuntimeConfig but represents the config *for a call*.
}
