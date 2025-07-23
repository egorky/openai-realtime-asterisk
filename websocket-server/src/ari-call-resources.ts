// Este archivo contendrá las definiciones de interfaz para CallResources y ActiveCallInfo.
// También podría incluir funciones de ayuda para gestionar estos recursos si es necesario.

import { Channel, Bridge, Playback } from 'ari-client';
import { CallSpecificConfig, LoggerInstance } from './types'; // Asumiendo que types.ts se mantiene o se adapta
import { RtpServer } from './rtp-server'; // Si RtpServer se mantiene como una clase separada
import GoogleSpeechService from './google-speech-service';

// Interfaz para los recursos asociados con una llamada activa.
// Copiado de ari-client.ts
export interface CallResources {
  googleSpeechService?: GoogleSpeechService;
  channel: Channel;
  config: CallSpecificConfig;
  callLogger: LoggerInstance;
  userBridge?: Bridge;
  snoopBridge?: Bridge;
  rtpServer?: RtpServer;
  externalMediaChannel?: Channel;
  snoopChannel?: Channel;
  mainPlayback?: Playback;
  waitingPlayback?: Playback;
  postRecognitionWaitingPlayback?: Playback; // Parece que no se usa, pero se mantiene por ahora
  isCleanupCalled: boolean;
  promptPlaybackStoppedForInterim: boolean;
  fallbackAttempted: boolean; // Parece que no se usa, pero se mantiene por ahora
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
  vadActivationDelayCompleted: boolean; // Parece obsoleto con nueva config, pero se mantiene
  bargeInActivationTimer: NodeJS.Timeout | null;
  noSpeechBeginTimer: NodeJS.Timeout | null;
  initialOpenAIStreamIdleTimer: NodeJS.Timeout | null;
  speechEndSilenceTimer: NodeJS.Timeout | null;
  maxRecognitionDurationTimer: NodeJS.Timeout | null;
  dtmfInterDigitTimer: NodeJS.Timeout | null;
  dtmfFinalTimer: NodeJS.Timeout | null;
  vadMaxWaitAfterPromptTimer: NodeJS.Timeout | null;
  vadActivationDelayTimer: NodeJS.Timeout | null; // Obsoleto
  vadInitialSilenceDelayTimer: NodeJS.Timeout | null;
  playbackFailedHandler?: ((event: any, failedPlayback: Playback) => void) | null;
  waitingPlaybackFailedHandler?: ((event: any, playback: Playback) => void) | null;
  ttsAudioChunks: string[]; // Para el modo "full_chunk" de TTS
  currentTtsResponseId?: string; // Para rastrear la respuesta TTS actual
  callerAudioBufferForCurrentTurn: Buffer[]; // Para STT asíncrono
  currentTurnStartTime: string; // Timestamp para el inicio del turno actual del llamante
  isFirstInteraction: boolean; // Para rastrear la primera interacción para el cambio de modo
  streamedTtsChunkFiles: string[]; // Para almacenar rutas de archivos de chunks TTS transmitidos para limpieza

  // Playlist Management for TTS streaming
  ttsPlaybackQueue: string[]; // URIs of audio chunks
  currentPlayingSoundId: string | null; // ID of the currently playing sound from the queue
  isTtsPlaying: boolean; // Flag to indicate if the TTS queue is being processed
  isOverallTtsResponseActive: boolean; // True if any part of a multi-chunk TTS is playing or queued
  fullTtsAudioBuffer: Buffer[]; // To accumulate all TTS audio chunks for saving in "stream" mode
  pendingToolCall?: string;
}

// Interfaz para la información de llamada activa que se puede enviar al frontend.
// Copiado de ari-client.ts
export interface ActiveCallInfo {
  callId: string;
  callerId: string | undefined;
  startTime: string | undefined; // ISO string
  status: string; // e.g., 'active', 'ringing', 'ended'
  // Añadir otros detalles relevantes si el frontend los necesita para la visualización
}

// Podríamos añadir aquí funciones de utilidad relacionadas con CallResources si fuera necesario.
// Por ejemplo, una función para crear un objeto CallResources inicial.
// export function createInitialCallResources(channel: Channel, config: CallSpecificConfig, callLogger: LoggerInstance): CallResources {
//   return {
//     channel,
//     config,
//     callLogger,
//     isCleanupCalled: false,
//     // ... inicializar todos los demás campos con valores por defecto
//   };
// }
// Esta función de creación se moverá directamente a onStasisStart en ari-events.ts
// para mantener la lógica de inicialización junta.
