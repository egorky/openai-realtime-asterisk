// Este archivo contendrá la lógica para cargar y gestionar configuraciones.
// Incluirá baseConfig, currentCallSpecificConfig, getCallSpecificConfig y las funciones getVar*.

import dotenv from 'dotenv'; // Asegurar que dotenv se importe
dotenv.config(); // Llamar a dotenv.config() al inicio

import fs from 'node:fs';
import path from 'node:path';
import { CallSpecificConfig, RuntimeConfig, AppRecognitionConfig, DtmfConfig, OpenAIRealtimeAPIConfig, LoggerInstance } from './types';
import { allAgentSets, defaultAgentSetKey } from '../config/agentConfigs';

let baseConfig: RuntimeConfig;
// La variable global currentCallSpecificConfig se elimina.
// Cada llamada obtendrá su propia configuración a través de getCallSpecificConfig.

// Carga de configuración base
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
        vadConfig: { vadSilenceThresholdMs: 2500, vadRecognitionActivationMs: 40 },
        greetingAudioPath: 'sound:hello-world',
      },
      dtmfConfig: {
        enableDtmfRecognition: true,
        dtmfInterDigitTimeoutSeconds: 3.0,
        dtmfFinalTimeoutSeconds: 5.0,
        dtmfMaxDigits: 16,
        dtmfTerminatorDigit: "#"
      },
      bargeInConfig: { bargeInModeEnabled: true, bargeInDelaySeconds: 0.2, noSpeechBargeInTimeoutSeconds: 5.0 },
    },
    openAIRealtimeAPI: { model: "gpt-4o-mini-realtime-preview-2024-12-17", inputAudioFormat: "g711_ulaw", inputAudioSampleRate: 8000, outputAudioFormat: "g711_ulaw", outputAudioSampleRate: 8000, responseModalities: ["audio", "text"], instructions: "Eres un asistente de IA amigable y servicial. Responde de manera concisa." },
    logging: { level: "info" },
  };
}

export function getVar(logger: LoggerInstance, channel: Ari.Channel | undefined, envVarName: string, defaultValue?: string, channelVarName?: string): string | undefined {
  const astVarName = channelVarName || `APP_${envVarName}`;
  let value: string | undefined;
  // Nota: La lógica para obtener variables de canal de Asterisk (ej. getChannelVar)
  // no está implementada aquí, ya que requeriría capacidades asíncronas
  // y acceso directo al objeto del canal de una manera que no es trivial en este contexto síncrono.
  // Esta función actualmente solo considera variables de entorno y valores predeterminados.
  if (value === undefined) { value = process.env[envVarName]; }
  if (value === undefined) { value = defaultValue; }
  return value;
}

export function getVarAsInt(logger: LoggerInstance, channel: Ari.Channel | undefined, envVarName: string, defaultValue?: number, channelVarName?: string): number | undefined {
  const value = getVar(logger, channel, envVarName, defaultValue?.toString(), channelVarName);
  if (value === undefined) return undefined;
  const intValue = parseInt(value, 10);
  if (isNaN(intValue)) { logger.warn(`Invalid int for ${envVarName}: ${value}, using default ${defaultValue}`); return defaultValue; }
  return intValue;
}

export function getVarAsFloat(logger: LoggerInstance, channel: Ari.Channel | undefined, envVarName: string, defaultValue?: number, channelVarName?: string): number | undefined {
  const value = getVar(logger, channel, envVarName, defaultValue?.toString(), channelVarName);
  if (value === undefined) return undefined;
  const floatValue = parseFloat(value);
  if (isNaN(floatValue)) { logger.warn(`Invalid float for ${envVarName}: ${value}, using default ${defaultValue}`); return defaultValue; }
  return floatValue;
}

export function getVarAsBoolean(logger: LoggerInstance, channel: Ari.Channel | undefined, envVarName: string, defaultValue?: boolean, channelVarName?: string): boolean | undefined {
  const value = getVar(logger, channel, envVarName, defaultValue?.toString(), channelVarName);
  if (value === undefined) return undefined;
  if (typeof value === 'string') { return value.toLowerCase() === 'true' || value === '1'; }
  return defaultValue;
}

export function getCallSpecificConfig(logger: LoggerInstance, channel?: Ari.Channel): CallSpecificConfig {
  // Crea una copia profunda de baseConfig para evitar modificarla directamente.
  const callConfig: CallSpecificConfig = JSON.parse(JSON.stringify(baseConfig));

  callConfig.logging.level = getVar(logger, channel, 'LOG_LEVEL', baseConfig.logging.level) as any || baseConfig.logging.level;

  const arc = callConfig.appConfig.appRecognitionConfig = callConfig.appConfig.appRecognitionConfig || {} as AppRecognitionConfig;

  arc.recognitionActivationMode = getVar(logger, channel, 'RECOGNITION_ACTIVATION_MODE', arc.recognitionActivationMode) as "fixedDelay" | "Immediate" | "vad" || "fixedDelay";
  arc.bargeInDelaySeconds = getVarAsFloat(logger, channel, 'BARGE_IN_DELAY_SECONDS', arc.bargeInDelaySeconds) ?? 0.2;
  arc.noSpeechBeginTimeoutSeconds = getVarAsFloat(logger, channel, 'NO_SPEECH_BEGIN_TIMEOUT_SECONDS', arc.noSpeechBeginTimeoutSeconds) ?? 5.0;
  arc.speechEndSilenceTimeoutSeconds = getVarAsFloat(logger, channel, 'SPEECH_END_SILENCE_TIMEOUT_SECONDS', arc.speechEndSilenceTimeoutSeconds) ?? 1.5;
  arc.maxRecognitionDurationSeconds = getVarAsFloat(logger, channel, 'MAX_RECOGNITION_DURATION_SECONDS', arc.maxRecognitionDurationSeconds) ?? 30.0;

  arc.vadSilenceThresholdMs = getVarAsInt(logger, channel, 'APP_APPRECOGNITION_VADSILENCETHRESHOLDMS', arc.vadSilenceThresholdMs) ?? 2500;
  arc.vadTalkThreshold = getVarAsInt(logger, channel, 'APP_APPRECOGNITION_VADTALKTHRESHOLD', arc.vadTalkThreshold) ?? 256;
  arc.vadRecogActivation = getVar(logger, channel, 'APP_APPRECOGNITION_VADRECOGACTIVATION', arc.vadRecogActivation) as "vadMode" | "afterPrompt" || "vadMode";
  arc.vadMaxWaitAfterPromptSeconds = getVarAsFloat(logger, channel, 'APP_APPRECOGNITION_VADMAXWAITAFTERPROMPTSECONDS', arc.vadMaxWaitAfterPromptSeconds) ?? 10.0;
  arc.vadInitialSilenceDelaySeconds = getVarAsFloat(logger, channel, 'APP_APPRECOGNITION_VADINITIALSILENCEDELAYSECONDS', arc.vadInitialSilenceDelaySeconds) ?? 0.0;

  arc.asyncSttEnabled = getVarAsBoolean(logger, channel, 'ASYNC_STT_ENABLED', arc.asyncSttEnabled) ?? false;
  arc.asyncSttProvider = getVar(logger, channel, 'ASYNC_STT_PROVIDER', arc.asyncSttProvider) ?? "openai_whisper_api";
  arc.asyncSttOpenaiModel = getVar(logger, channel, 'ASYNC_STT_OPENAI_MODEL', arc.asyncSttOpenaiModel) ?? "whisper-1";
  arc.asyncSttOpenaiApiKey = getVar(logger, channel, 'ASYNC_STT_OPENAI_API_KEY', arc.asyncSttOpenaiApiKey);
  arc.asyncSttLanguage = getVar(logger, channel, 'ASYNC_STT_LANGUAGE', arc.asyncSttLanguage);
  arc.asyncSttAudioFormat = getVar(logger, channel, 'ASYNC_STT_AUDIO_FORMAT', arc.asyncSttAudioFormat) as any ?? "mulaw";
  arc.asyncSttAudioSampleRate = getVarAsInt(logger, channel, 'ASYNC_STT_AUDIO_SAMPLE_RATE', arc.asyncSttAudioSampleRate) ?? 8000;
  arc.asyncSttGoogleLanguageCode = getVar(logger, channel, 'ASYNC_STT_GOOGLE_LANGUAGE_CODE', arc.asyncSttGoogleLanguageCode) ?? "es-ES";
  arc.asyncSttGoogleCredentials = getVar(logger, channel, 'ASYNC_STT_GOOGLE_CREDENTIALS', arc.asyncSttGoogleCredentials);
  arc.voskServerUrl = getVar(logger, channel, 'VOSK_SERVER_URL', arc.voskServerUrl);

  arc.ttsPlaybackMode = getVar(logger, channel, 'OPENAI_TTS_PLAYBACK_MODE', arc.ttsPlaybackMode) as "full_chunk" | "stream" || "full_chunk";
  arc.firstInteractionRecognitionMode = getVar(logger, channel, 'FIRST_INTERACTION_RECOGNITION_MODE', arc.firstInteractionRecognitionMode) as "fixedDelay" | "Immediate" | "vad" | "" || "";
  arc.initialUserPrompt = getVar(logger, channel, 'INITIAL_USER_PROMPT', arc.initialUserPrompt);

  const initialGreetingEnv = getVar(logger, channel, 'INITIAL_GREETING_AUDIO_PATH', undefined);
  const greetingEnv = getVar(logger, channel, 'GREETING_AUDIO_PATH', undefined);
  if (initialGreetingEnv !== undefined) { arc.greetingAudioPath = initialGreetingEnv; }
  else if (greetingEnv !== undefined) { arc.greetingAudioPath = greetingEnv; }
  else if (baseConfig.appConfig.appRecognitionConfig.greetingAudioPath !== undefined) { arc.greetingAudioPath = baseConfig.appConfig.appRecognitionConfig.greetingAudioPath; }
  else { arc.greetingAudioPath = 'sound:hello-world'; }

  arc.vadConfig = arc.vadConfig || { vadSilenceThresholdMs: 2500, vadRecognitionActivationMs: 40 };
  arc.vadConfig.vadSilenceThresholdMs = arc.vadSilenceThresholdMs;
  arc.vadConfig.vadRecognitionActivationMs = getVarAsInt(logger, channel, 'VAD_TALK_DURATION_THRESHOLD_MS', arc.vadConfig.vadRecognitionActivationMs) ?? 40;

  const dtmfConf = callConfig.appConfig.dtmfConfig = callConfig.appConfig.dtmfConfig || {} as DtmfConfig;
  dtmfConf.enableDtmfRecognition = getVarAsBoolean(logger, channel, 'DTMF_ENABLED', dtmfConf.enableDtmfRecognition) ?? true;
  dtmfConf.dtmfInterDigitTimeoutSeconds = getVarAsFloat(logger, channel, 'DTMF_INTERDIGIT_TIMEOUT_SECONDS', dtmfConf.dtmfInterDigitTimeoutSeconds) ?? 3.0;
  dtmfConf.dtmfFinalTimeoutSeconds = getVarAsFloat(logger, channel, 'DTMF_FINAL_TIMEOUT_SECONDS', dtmfConf.dtmfFinalTimeoutSeconds) ?? 5.0;
  dtmfConf.dtmfMaxDigits = getVarAsInt(logger, channel, 'DTMF_MAX_DIGITS', dtmfConf.dtmfMaxDigits) ?? 16;
  dtmfConf.dtmfTerminatorDigit = getVar(logger, channel, 'DTMF_TERMINATOR_DIGIT', dtmfConf.dtmfTerminatorDigit) ?? "#";

  const oaiConf = callConfig.openAIRealtimeAPI = callConfig.openAIRealtimeAPI || {} as OpenAIRealtimeAPIConfig;
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

  const activeAgentKey = getVar(logger, channel, 'ACTIVE_AGENT_CONFIG_KEY', defaultAgentSetKey) || defaultAgentSetKey;
  const selectedAgentSet = allAgentSets[activeAgentKey];

  if (selectedAgentSet && selectedAgentSet.length > 0) {
    const primaryAgentConfig = selectedAgentSet[0];
    if (typeof primaryAgentConfig.instructions === 'function') {
      logger.warn(`Agent "${activeAgentKey}" uses dynamic (function-based) instructions. This is not directly passed to OpenAI's session.update. Using default string instructions.`);
      oaiConf.instructions = "Eres un asistente de IA amigable y servicial. Responde de manera concisa.";
    } else {
      oaiConf.instructions = primaryAgentConfig.instructions || "Eres un asistente de IA amigable y servicial. Responde de manera concisa.";
    }
    if (primaryAgentConfig.tools && Array.isArray(primaryAgentConfig.tools)) {
      oaiConf.tools = primaryAgentConfig.tools.map((t: any) => {
        let toolDetails = t.function || t;
        return {
          type: "function",
          name: toolDetails.name,
          description: toolDetails.description,
          parameters: toolDetails.parameters,
        };
      });
    } else {
      oaiConf.tools = [];
    }
    const instructionsForLog = typeof oaiConf.instructions === 'string' ? oaiConf.instructions : "";
    logger.info(`Loaded agent configuration for key: ${activeAgentKey}. Instructions: "${instructionsForLog.substring(0,50)}...", Tools count: ${oaiConf.tools?.length || 0}`);
  } else {
    logger.warn(`Agent configuration for key "${activeAgentKey}" not found or is empty. Falling back to default instructions and no tools.`);
    oaiConf.instructions = "Eres un asistente de IA amigable y servicial. Responde de manera concisa.";
    oaiConf.tools = [];
  }

  const baseModalities = baseConfig.openAIRealtimeAPI?.responseModalities?.join(',') || 'audio,text';
  const modalitiesStr = getVar(logger, channel, 'OPENAI_RESPONSE_MODALITIES', baseModalities, 'APP_OPENAI_RESPONSE_MODALITIES');
  let finalModalities: ("audio" | "text")[] = ["audio", "text"];

  if (modalitiesStr) {
    const validModalitiesSet = new Set(["audio", "text"]);
    const parsedModalities = modalitiesStr.split(',').map(m => m.trim().toLowerCase()).filter(m => validModalitiesSet.has(m)) as ("audio" | "text")[];
    if (parsedModalities.length === 1 && parsedModalities[0] === 'audio') {
      logger.warn(`OPENAI_RESPONSE_MODALITIES was resolved to ['audio'], which is invalid. Forcing to ['audio', 'text'].`);
      finalModalities = ["audio", "text"];
    } else if (parsedModalities.length > 0) {
      finalModalities = parsedModalities;
    } else {
      finalModalities = baseConfig.openAIRealtimeAPI?.responseModalities || ["audio", "text"];
    }
  } else {
    finalModalities = baseConfig.openAIRealtimeAPI?.responseModalities || ["audio", "text"];
  }
  oaiConf.responseModalities = finalModalities;

  if (oaiConf.tools === undefined) { oaiConf.tools = []; }

  // Add AI provider information to the config
  callConfig.aiProvider = getVar(logger, channel, 'AI_PROVIDER', 'openai') as 'openai' | 'azure';
  if (callConfig.aiProvider === 'azure') {
    callConfig.azureOpenAI = {
      apiKey: getVar(logger, channel, 'AZURE_OPENAI_API_KEY', ''),
      endpoint: getVar(logger, channel, 'AZURE_OPENAI_ENDPOINT', ''),
      deploymentId: getVar(logger, channel, 'AZURE_OPENAI_DEPLOYMENT_ID', ''),
    };
  }

  if (callConfig.aiProvider === 'openai' && !process.env.OPENAI_API_KEY) {
    logger.error("CRITICAL: AI_PROVIDER is 'openai' but OPENAI_API_KEY is not set.");
  } else if (callConfig.aiProvider === 'azure' && (!callConfig.azureOpenAI?.apiKey || !callConfig.azureOpenAI?.endpoint || !callConfig.azureOpenAI?.deploymentId)) {
    logger.error("CRITICAL: AI_PROVIDER is 'azure' but one or more Azure environment variables are not set.");
  }

  return callConfig;
}

// Constantes globales de configuración (copiado de ari-client.ts)
export const ASTERISK_ARI_URL = process.env.ASTERISK_ARI_URL || 'http://localhost:8088';
export const ASTERISK_ARI_USERNAME = process.env.ASTERISK_ARI_USERNAME || 'asterisk';
export const ASTERISK_ARI_PASSWORD = process.env.ASTERISK_ARI_PASSWORD || 'asterisk';
export const ASTERISK_ARI_APP_NAME = process.env.ASTERISK_ARI_APP_NAME || 'openai-ari-app';
export const AI_PROVIDER = process.env.AI_PROVIDER || "openai";
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
export const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY || "";
export const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || "";
export const AZURE_OPENAI_DEPLOYMENT_ID = process.env.AZURE_OPENAI_DEPLOYMENT_ID || "";
export const DEFAULT_RTP_HOST_IP = process.env.RTP_HOST_IP || '127.0.0.1';
export const MAX_VAD_BUFFER_PACKETS = 200;

if (AI_PROVIDER === "openai" && !OPENAI_API_KEY) {
  console.error("FATAL: AI_PROVIDER is 'openai' but OPENAI_API_KEY environment variable is not set.");
} else if (AI_PROVIDER === "azure" && (!AZURE_OPENAI_API_KEY || !AZURE_OPENAI_ENDPOINT || !AZURE_OPENAI_DEPLOYMENT_ID)) {
  console.error("FATAL: AI_PROVIDER is 'azure' but one or more Azure environment variables (API_KEY, ENDPOINT, DEPLOYMENT_ID) are not set.");
}

export { baseConfig }; // Exportar baseConfig si es necesario globalmente
// currentCallSpecificConfig no se exporta porque debe ser específica de cada llamada.
// getCallSpecificConfig es la forma de obtenerla.

// Nota: 'ari-client' importaba Ari from 'ari-client'. Necesitaremos Ari.Channel aquí.
// Esto podría requerir pasar el tipo Ari.Channel o importar 'ari-client' aquí también,
// aunque el objetivo es reducir las dependencias cruzadas.
// Por ahora, se asume que el tipo Ari.Channel estará disponible a través de importaciones.
import Ari from 'ari-client';
