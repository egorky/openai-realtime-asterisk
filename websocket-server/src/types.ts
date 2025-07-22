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
  vadSilenceThresholdMs: number;
  vadRecognitionActivationMs: number;
}

export interface AppRecognitionConfig {
  recognitionActivationMode: "fixedDelay" | "Immediate" | "vad";
  bargeInDelaySeconds: number;
  noSpeechBeginTimeoutSeconds: number;
  speechEndSilenceTimeoutSeconds: number;
  maxRecognitionDurationSeconds: number;
  vadSilenceThresholdMs: number;
  vadTalkThreshold: number;
  vadRecogActivation: "vadMode" | "afterPrompt";
  vadMaxWaitAfterPromptSeconds: number;
  vadInitialSilenceDelaySeconds: number;

  // Fields from the old structure that might still be used internally or need mapping
  vadConfig: VadConfig; // Contains vadSilenceThresholdMs, vadRecognitionActivationMs
  initialOpenAIStreamIdleTimeoutSeconds?: number; // May need to be re-evaluated or removed
  greetingAudioPath?: string; // Still relevant
  speechCompleteTimeoutSeconds?: number; // Replaced by speechEndSilenceTimeoutSeconds
  vadActivationDelaySeconds?: number; // This seems specific and might not be directly in new .env, review usage

  // Async STT Configuration
  asyncSttEnabled?: boolean;
  asyncSttProvider?: "openai_whisper_api" | "google_speech_v1" | string; // string for extensibility
  asyncSttOpenaiModel?: string;
  asyncSttOpenaiApiKey?: string;
  asyncSttLanguage?: string; // Optional language hint for OpenAI
  asyncSttAudioFormat?: "mulaw" | "wav" | "pcm_s16le" | string; // Format of audio passed to async transcriber
  asyncSttAudioSampleRate?: number;
  // Google Specific Async STT settings
  asyncSttGoogleLanguageCode?: string; // e.g., "en-US", "es-ES"
  asyncSttGoogleCredentials?: string; // Optional: Path to Google Cloud credentials JSON file
  voskServerUrl?: string; // URL for the Vosk WebSocket server, e.g., "ws://localhost:2700"

  initialUserPrompt?: string; // Optional synthetic first user message
  ttsPlaybackMode?: "full_chunk" | "stream"; // New: How TTS audio is played back
  firstInteractionRecognitionMode?: "fixedDelay" | "Immediate" | "vad" | ""; // Mode for the first interaction

}

export interface DtmfConfig {
  enableDtmfRecognition: boolean; // Changed from dtmfEnabled
  dtmfInterDigitTimeoutSeconds: number; // Changed from dtmfInterdigitTimeoutSeconds
  dtmfFinalTimeoutSeconds: number;

  // Fields from the old structure that might still be used internally or need mapping
  dtmfEnabled?: boolean; // Old field
  dtmfMaxDigits?: number; // Retained if still used
  dtmfTerminatorDigit?: string; // Retained if still used
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
  model?: string; // Unified model for Realtime API sessions
  language?: string; // e.g., "en" or "en-US"
  inputAudioFormat?: string; // e.g., "pcm_s16le", "g711_ulaw"
  inputAudioSampleRate?: number; // e.g., 8000, 16000
  outputAudioFormat?: string; // e.g., "mp3", "pcm_s16le"
  outputAudioSampleRate?: number; // e.g., 24000, 16000
  ttsVoice?: string; // e.g., "alloy"
  transcriptionIntentOnly?: boolean; // Custom flag if STT is only for intent not full conversation
  responseModalities?: ("audio" | "text")[];
  instructions?: string | ((runContext: any, agent: any) => string | Promise<string>); // Instructions can be string or function
  tools?: any[]; // Añadir propiedad opcional para herramientas

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

export interface AzureOpenAIConfig {
  apiKey?: string;
  endpoint?: string;
  deploymentId?: string;
  apiVersion?: string;
}

export interface CallSpecificConfig extends RuntimeConfig {
  aiProvider?: 'openai' | 'azure';
  azureOpenAI?: AzureOpenAIConfig;
}

// Definition for a generic logger instance
export interface LoggerInstance {
  info: (message: string, ...args: any[]) => void;
  error: (message: string, ...args: any[]) => void;
  warn: (message: string, ...args: any[]) => void;
  debug: (message: string, ...args: any[]) => void;
  child: (bindings: object, callSpecificLogLevel?: string, ariClientServiceRef?: any) => LoggerInstance; // Updated signature
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
  playbackAudio: (channelId: string, audioPayloadB64: string) => Promise<void>;
  _onOpenAIAudioChunk: (callId: string, audioChunkBase64: string, _isLastChunk_deprecated: boolean) => void; // isLastChunk is deprecated
  _onOpenAIAudioStreamEnd: (callId: string) => void; // New method for signaling end of audio stream
  // Potentially other methods like endCall, if sessionManager needs to trigger them directly
}

// Renaming the old AriClient to avoid conflict if it's still used elsewhere,
// though it's better to fully transition to AriClientInterface.
// Removing problematic self-referential export:
// export { AriClient as DeprecatedAriClient } from './types';
