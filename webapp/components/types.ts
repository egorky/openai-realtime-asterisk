export type Item = {
  id: string;
  object: string; // e.g. "realtime.item"
  type: "message" | "function_call" | "function_call_output";
  timestamp?: string;
  status?: "running" | "completed";
  // For "message" items
  role?: "system" | "user" | "assistant" | "tool";
  content?: { type: string; text: string }[];
  // For "function_call" items
  name?: string;
  call_id?: string;
  params?: Record<string, any>;
  // For "function_call_output" items
  output?: string;
};

export interface PhoneNumber {
  sid: string;
  friendlyName: string;
  voiceUrl?: string;
}

export type FunctionCall = {
  name: string;
  params: Record<string, any>;
  completed?: boolean;
  response?: string;
  status?: string;
  call_id?: string; // ensure each call has a call_id
};

// Estructuras de Configuración (reflejando backend CallSpecificConfig)

export interface VadConfig { // Aunque aplanado en AppRecognitionConfig, puede ser útil
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
  // Campos no directamente configurables por UI por ahora:
  // greetingAudioPath?: string;
  // vadConfig?: VadConfig; // Los campos relevantes están aplanados arriba
  // asyncSttEnabled?: boolean;
  // asyncSttProvider?: string;
  // asyncSttOpenaiModel?: string;
  // asyncSttOpenaiApiKey?: string;
  // asyncSttLanguage?: string;
  // asyncSttAudioFormat?: string;
  // asyncSttAudioSampleRate?: number;
}

export interface DtmfConfig {
  enableDtmfRecognition: boolean;
  dtmfInterDigitTimeoutSeconds: number;
  dtmfFinalTimeoutSeconds: number;
  // Campos no directamente configurables por UI por ahora:
  // dtmfMaxDigits?: number;
  // dtmfTerminatorDigit?: string;
}

export interface OpenAIRealtimeAPIConfig {
  model?: string;
  // language?: string; // No configurable desde UI ahora
  ttsVoice?: string;
  instructions?: string;
  tools?: any[]; // Array de schemas de herramientas
}

export interface AppConfig { // Parte de CallSpecificConfig
  appRecognitionConfig: AppRecognitionConfig;
  dtmfConfig: DtmfConfig;
}

export interface CallSpecificConfig { // Estructura principal recibida del backend
  appConfig: AppConfig;
  openAIRealtimeAPI: OpenAIRealtimeAPIConfig;
  logging?: { level: string }; // No configurable desde UI
}
