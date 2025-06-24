# WebSocket Server for Asterisk ARI and OpenAI Realtime API Integration

## Overview

This WebSocket server acts as the backend engine connecting an Asterisk telephony server (via the Asterisk REST Interface - ARI) to OpenAI's Realtime API. Its primary role is to manage the lifecycle of calls, handle media streams, orchestrate interactions with the OpenAI API for speech-to-text and text-to-speech, and manage various operational modes for call handling and speech recognition. It also communicates with a frontend web application (see `webapp/`) for displaying call information, transcripts, and allowing session configuration.

## Architecture

El servidor está construido con Node.js y TypeScript. Los componentes clave incluyen:

1.  **`src/server.ts`**:
    *   Punto de entrada principal de la aplicación.
    *   Configura un servidor HTTP `express` y un servidor WebSocket (`ws`) sobre él.
    *   Maneja las conexiones WebSocket desde la `webapp` (frontend) para:
        *   Enviar logs y eventos del sistema en tiempo real.
        *   Recibir actualizaciones de configuración para la llamada activa (ej. cambio de prompt de IA, voz TTS).
    *   Inicializa y arranca el `AriClientService`.

2.  **`src/ari-client.ts` (Clase `AriClientService`)**:
    *   El núcleo de la aplicación, responsable de todas las interacciones con Asterisk a través de ARI.
    *   Gestiona el estado de cada llamada activa: recursos ARI (canales, puentes), configuración de medios RTP, ciclo de vida de la llamada.
    *   Implementa varios **modos operativos** para la activación del reconocimiento de voz (Inmediato, Retardo Fijo, VAD).
    *   Maneja la entrada DTMF, interrumpiendo el reconocimiento de voz si es necesario.
    *   Orquesta cuándo y cómo iniciar y detener el flujo de voz hacia y desde OpenAI a través de `sessionManager.ts`.
    *   Recibe eventos de `sessionManager.ts` (ej. inicio de habla, transcripciones, audio TTS, errores) y actúa sobre ellos.
    *   **Manejo de Audio TTS**: Cuando recibe el stream de audio TTS de OpenAI, si el formato es PCM, lo **convierte a un archivo WAV con el encabezado apropiado** antes de guardarlo y solicitar a Asterisk su reproducción. Si es uLaw, lo guarda como `.ulaw`.

3.  **`src/rtp-server.ts` (Clase `RtpServer`)**:
    *   Crea un servidor UDP para recibir paquetes RTP (audio del llamante) desde Asterisk.
    *   Extrae el payload de audio de los paquetes RTP y lo emite para que `ari-client.ts` lo procese.

4.  **`src/sessionManager.ts`**:
    *   Gestiona las conexiones WebSocket con la API Realtime de OpenAI para cada llamada activa.
    *   Envía la configuración de la sesión a OpenAI (modelo, formatos de audio, instrucciones, etc.).
    *   Reenvía los datos de audio del llamante (recibidos de `ari-client.ts`) a OpenAI.
    *   Procesa los mensajes entrantes (eventos) de OpenAI y llama a los métodos de callback en `ari-client.ts`.

5.  **`webapp/` (Directorio Separado)**:
    *   Una aplicación de frontend (Next.js) que actúa como interfaz de monitoreo y configuración.
    *   Se conecta al WebSocket expuesto por `src/server.ts`.
    *   Permite visualizar el estado de la llamada y modificar parámetros de la IA en tiempo real.

Para una descripción más detallada de la arquitectura, el flujo de llamadas y un diagrama, consulta el [Documento de Arquitectura](./docs/architecture.md).

## Documentación Detallada

Para una comprensión más profunda de cada archivo y las variables de configuración, consulta los siguientes documentos en el directorio `docs/`:

*   **[architecture.md](./docs/architecture.md)**: Visión general de la arquitectura del sistema.
*   **[file-explanation.md](./docs/file-explanation.md)**: Describe el propósito y la funcionalidad de cada archivo principal.
*   **[variables.md](./docs/variables.md)**: Detalla las variables de entorno y las opciones de configuración en `config/default.json`.

## Configuración

La aplicación utiliza un enfoque de configuración por capas:

1.  **`config/default.json`**: Proporciona el conjunto base de valores predeterminados.
2.  **Variables de Entorno**: Sobrescriben los valores de `default.json`. Son la forma principal de configurar una implementación. Consulta [Variables de Configuración](./docs/variables.md) para más detalles.
3.  **Variables de Canal de Asterisk** (TODO futuro): Para anulaciones por llamada, variables específicas de canal establecidas en el plan de marcado de Asterisk podrían eventualmente anular las variables de entorno o los valores predeterminados.

### Estructura de `config/default.json`

Este archivo (ubicado en `websocket-server/config/default.json`) define los parámetros operativos predeterminados. Su estructura típicamente incluye:

```json
{
  "appConfig": {
    "appRecognitionConfig": {
      // ... recognition settings ...
    },
    "dtmfConfig": {
      // ... DTMF settings ...
    },
    "bargeInConfig": {
      // ... barge-in settings ...
    }
  },
  "openAIRealtimeAPI": {
    "model": "gpt-4o-mini-realtime-preview-2024-12-17",
    "language": "en", // Note: language for OpenAI Realtime API is often model-dependent or set via instructions
    "instructions": "Eres un asistente de IA amigable y servicial. Responde de manera concisa.",
    "inputAudioFormat": "g711_ulaw", // For u-law passthrough
    "inputAudioSampleRate": 8000,    // For u-law passthrough
    "outputAudioFormat": "g711_ulaw",// For u-law passthrough
    "outputAudioSampleRate": 8000,   // For u-law passthrough
    "ttsVoice": "alloy",
    "responseModalities": ["audio", "text"]
  },
  "logging": {
    "level": "info" // debug, info, warn, error, silly
  }
}
```

### Environment Variables

Create a `.env` file in the root of the `websocket-server` directory by copying `.env.example` (`cp .env.example .env`) and then filling in the values. Refer to `websocket-server/docs/variables.md` for a detailed explanation of all variables.

**Key Environment Variables:**

*   **OpenAI Configuration:**
    *   `OPENAI_API_KEY`: **Required.** Your OpenAI API key.
    *   `OPENAI_REALTIME_MODEL`: **Required.** The OpenAI Realtime model ID.
    *   `ACTIVE_AGENT_CONFIG_KEY`: Specifies the agent configuration (instructions, tools) to use.
    *   `OPENAI_RESPONSE_MODALITIES`: Desired response types from OpenAI (e.g., "audio,text").
    *   `OPENAI_TTS_VOICE`: Voice for Text-to-Speech.
    *   `OPENAI_INPUT_AUDIO_FORMAT`, `OPENAI_INPUT_AUDIO_SAMPLE_RATE`: Configuration for audio sent to OpenAI STT.
    *   `OPENAI_OUTPUT_AUDIO_FORMAT`, `OPENAI_OUTPUT_AUDIO_SAMPLE_RATE`: Configuration for audio received from OpenAI TTS.

*   **Asterisk ARI Configuration:**
    *   `ASTERISK_ARI_URL`, `ASTERISK_ARI_USERNAME`, `ASTERISK_ARI_PASSWORD`: Connection details for Asterisk ARI.
    *   `ASTERISK_ARI_APP_NAME`: Name of your Stasis application in Asterisk.

*   **Server & Media Configuration:**
    *   `PORT`: Port for this WebSocket server.
    *   `WEBSOCKET_SERVER_HOST_IP`: Host IP for this server to bind to.
    *   `RTP_HOST_IP`: IP address of this server for Asterisk to send RTP media to.
    *   `RTP_MIN_PORT`, `RTP_MAX_PORT`: Port range for RTP listeners.
    *   `LOG_LEVEL`: Logging verbosity (e.g., `info`, `debug`).

*   **Application Behavior:**
    *   `RECOGNITION_ACTIVATION_MODE`: Default mode for activating speech recognition (e.g., `vad`, `Immediate`, `fixedDelay`).
    *   `FIRST_INTERACTION_RECOGNITION_MODE`: (Optional) Overrides `RECOGNITION_ACTIVATION_MODE` for the first interaction.
    *   `OPENAI_TTS_PLAYBACK_MODE`: (Optional) How TTS audio is played (`full_chunk` or `stream`).
    *   `INITIAL_USER_PROMPT`: (Optional) Text to make the assistant speak first.
    *   `GREETING_AUDIO_PATH`: (Optional) Path to an initial greeting audio file.

*   **VAD (Voice Activity Detection) Settings (for `vad` mode):**
    *   `APP_APPRECOGNITION_VADSILENCETHRESHOLDMS`, `APP_APPRECOGNITION_VADTALKTHRESHOLD`: Asterisk TALK_DETECT parameters.
    *   `APP_APPRECOGNITION_VADRECOGACTIVATION`: Sub-mode for VAD (`vadMode` or `afterPrompt`).
    *   `APP_APPRECOGNITION_VADMAXWAITAFTERPROMPTSECONDS`, `APP_APPRECOGNITION_VADINITIALSILENCEDELAYSECONDS`: Timers for VAD logic.

*   **DTMF Settings:**
    *   `DTMF_ENABLED`: Enable/disable DTMF recognition.
    *   `DTMF_INTERDIGIT_TIMEOUT_SECONDS`, `DTMF_FINAL_TIMEOUT_SECONDS`: Timers for DTMF input.

*   **Asynchronous STT (Fallback):**
    *   `ASYNC_STT_ENABLED`: Enable/disable fallback STT.
    *   `ASYNC_STT_PROVIDER`: Provider for async STT (`openai_whisper_api`, `google_speech_v1`, `vosk`).
    *   Provider-specific settings like API keys, models, language codes (e.g., `ASYNC_STT_OPENAI_MODEL`, `VOSK_SERVER_URL`).

*   **Redis for Conversation Logging (Optional):**
    *   `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`: Connection details for Redis.
    *   `REDIS_CONVERSATION_TTL_SECONDS`: TTL for conversation logs in Redis.

If Redis is configured, the server will log conversation turns (caller speech, bot speech, DTMF, system messages, errors, async STT results) to Redis lists.

## Audio Handling

La aplicación maneja el audio de la siguiente manera:

*   **Entrada (Llamante -> OpenAI STT)**:
    *   Asterisk envía el audio del llamante (generalmente G.711 u-law 8kHz) al `RtpServer`.
    *   Este audio crudo (u-law) se reenvía a OpenAI.
    *   Se debe configurar `OPENAI_INPUT_AUDIO_FORMAT` (ej. `"g711_ulaw"` o `"mulaw_8000hz"`) y `OPENAI_INPUT_AUDIO_SAMPLE_RATE` (ej. `"8000"`) para que OpenAI espere este formato.
    *   Esta estrategia de "passthrough" evita la transcodificación en la aplicación Node.js para el audio de entrada.

*   **Salida (OpenAI TTS -> Llamante)**:
    *   Se solicita a OpenAI que genere audio TTS en un formato específico a través de `OPENAI_OUTPUT_AUDIO_FORMAT` y `OPENAI_OUTPUT_AUDIO_SAMPLE_RATE`.
    *   **Si `OPENAI_OUTPUT_AUDIO_FORMAT` es un tipo PCM (ej. `"pcm_s16le_8000hz"`, `"pcm_s16le_16000hz"`):**
        *   `ari-client.ts` recibe los fragmentos de audio PCM de OpenAI.
        *   Al finalizar el stream de audio, se **genera un encabezado WAV estándar** y se antepone al buffer de audio PCM.
        *   El archivo resultante se guarda como `.wav` en el directorio de sonidos de Asterisk (ej. `/var/lib/asterisk/sounds/openai/`).
        *   Asterisk reproduce este archivo `.wav`. Es crucial que `OPENAI_OUTPUT_AUDIO_SAMPLE_RATE` coincida con la tasa de muestreo real del audio PCM enviado por OpenAI para que el encabezado WAV sea correcto.
    *   **Si `OPENAI_OUTPUT_AUDIO_FORMAT` es `"g711_ulaw"` (o `"mulaw_8000hz"`):**
        *   El audio se guarda como un archivo `.ulaw` crudo.
        *   Asterisk reproduce este archivo `.ulaw`.
    *   Otros formatos (MP3, Opus) se guardan con sus extensiones respectivas y Asterisk intenta reproducirlos.
    *   **Recomendación para TTS**: Usar `OPENAI_OUTPUT_AUDIO_FORMAT="pcm_s16le_8000hz"` y `OPENAI_OUTPUT_AUDIO_SAMPLE_RATE="8000"` para la mejor compatibilidad con Asterisk a través de archivos WAV.

## Troubleshooting Notes
**Enhanced Logging:** El servidor incluye logging detallado. Para depurar, establece la variable de entorno `LOG_LEVEL` a `debug` o `silly` e inspecciona la salida de la consola.
Esto mostrará el flujo de llamadas ARI, interacciones con OpenAI (incluyendo tipos de eventos y errores), y el manejo de audio.
Verifica la configuración de `OPENAI_OUTPUT_AUDIO_FORMAT` y `OPENAI_OUTPUT_AUDIO_SAMPLE_RATE` para asegurar que coincidan con lo que OpenAI envía, especialmente si usas formatos PCM.
Revisa los logs de Asterisk (`/var/log/asterisk/full` o similar) para errores de reproducción de audio si los problemas persisten.

## Operational Modes

The `RECOGNITION_ACTIVATION_MODE` setting (from `appConfig.appRecognitionConfig` or environment variable `RECOGNITION_ACTIVATION_MODE`) controls how and when the OpenAI speech recognition stream is initiated for the caller's turn. DTMF input, if enabled (`DTMF_ENABLED` or `appConfig.dtmfConfig.enableDtmfRecognition`), acts as an interrupt to these modes.

**Common Timers (Once OpenAI Stream is Active for Speech Recognition):**
Regardless of the initial activation mode, once the OpenAI stream is active and listening for the caller's speech, the following timers (from `appConfig.appRecognitionConfig`) typically govern the interaction:
*   `noSpeechBeginTimeoutSeconds`: Max time to wait for OpenAI to detect speech (or send the first transcript event like `input_audio_buffer.speech_started`) after the stream is active. If this expires, the interaction for the current turn may end.
*   `speechEndSilenceTimeoutSeconds`: Max time the application waits for a final transcript from OpenAI after the last interim transcript or speech activity. If OpenAI indicates speech has stopped and this timeout is reached without a final result, the current recognition attempt might be concluded. (This replaces `speechCompleteTimeoutSeconds`).
*   `maxRecognitionDurationSeconds`: An absolute maximum duration for the entire speech recognition attempt for a single turn. This prevents excessively long recognition cycles.

These timers are generally managed within `ari-client.ts` when `_activateOpenAIStreaming` is called and during the processing of OpenAI events (`_onOpenAISpeechStarted`, `_onOpenAIInterimResult`).

---

1.  **`fixedDelay` Mode**:
    *   **Purpose**: To start sending audio to OpenAI after a fixed, short delay from when the system is ready for the caller to speak (e.g., after a prompt starts playing or if no prompt, immediately). This allows for barge-in.
    *   **Behavior**:
        *   The system waits for `bargeInDelaySeconds` (from `appConfig.appRecognitionConfig.bargeInDelaySeconds` or `BARGE_IN_DELAY_SECONDS` env var).
        *   After this delay, audio captured from the caller is sent to OpenAI.
        *   OpenAI's own VAD and speech processing then determine when speech starts and ends.
    *   **Key Configuration**: `RECOGNITION_ACTIVATION_MODE="fixedDelay"`, `BARGE_IN_DELAY_SECONDS`.
    *   **Relevant Timers**: `noSpeechBeginTimeoutSeconds`, `speechEndSilenceTimeoutSeconds`, `maxRecognitionDurationSeconds` (once OpenAI stream is active).
    *   **Ignored Timers/Settings**: Local VAD settings (`APP_APPRECOGNITION_VADSILENCETHRESHOLDMS`, `APP_APPRECOGNITION_VADTALKTHRESHOLD`, `APP_APPRECOGNITION_VADRECOGACTIVATION`, `APP_APPRECOGNITION_VADMAXWAITAFTERPROMPTSECONDS`, `APP_APPRECOGNITION_VADINITIALSILENCEDELAYSECONDS`) are not used. DTMF timers are separate.

---

2.  **`Immediate` Mode**:
    *   **Purpose**: To start sending audio to OpenAI immediately when the system is ready for the caller to speak.
    *   **Behavior**:
        *   As soon as the call is established and it's the caller's turn (e.g., after a prompt starts or if no prompt), audio is sent to OpenAI without any delay or local VAD.
        *   OpenAI handles all VAD and speech detection.
    *   **Key Configuration**: `RECOGNITION_ACTIVATION_MODE="Immediate"`.
    *   **Relevant Timers**: `noSpeechBeginTimeoutSeconds`, `speechEndSilenceTimeoutSeconds`, `maxRecognitionDurationSeconds` (once OpenAI stream is active).
    *   **Ignored Timers/Settings**: `BARGE_IN_DELAY_SECONDS` and all local VAD settings are not used. DTMF timers are separate.

---

3.  **`vad` (Local Voice Activity Detection) Mode**:
    *   **Purpose**: Uses Asterisk's `TALK_DETECT` feature (local VAD) to control when to start sending audio to OpenAI, aiming to reduce unnecessary audio transmission.
    *   **Behavior**:
        *   Asterisk's `TALK_DETECT(set)` is applied to the channel using `APP_APPRECOGNITION_VADTALKTHRESHOLD` (energy level) and `APP_APPRECOGNITION_VADSILENCETHRESHOLDMS` (silence duration). This allows Asterisk to send `ChannelTalkingStarted` and `ChannelTalkingFinished` events to the application.
        *   Audio from the RTP stream can be buffered locally (`vadAudioBuffer`) before the OpenAI stream is activated, especially if `vadInitialSilenceDelaySeconds` is used.
        *   The exact moment OpenAI streaming begins depends on `APP_APPRECOGNITION_VADRECOGACTIVATION`:
            *   **`vadRecogActivation: "vadMode"`**:
                *   The system waits for `APP_APPRECOGNITION_VADINITIALSILENCEDELAYSECONDS` before actively listening for `ChannelTalkingStarted`.
                *   Audio might be buffered during this initial silence delay.
                *   If `ChannelTalkingStarted` is received *after* this delay (or if speech was ongoing when the delay expired), the prompt (if any) is stopped, and audio (including buffered audio) is sent to OpenAI.
                *   If no speech is detected within `APP_APPRECOGNITION_VADMAXWAITAFTERPROMPTSECONDS` (this timer starts after the initial silence delay and after any prompt finishes), the turn may end.
            *   **`vadRecogActivation: "afterPrompt"`**:
                *   The system waits for the current prompt to finish playing.
                *   After the prompt, it listens for `ChannelTalkingStarted`.
                *   Upon receiving `ChannelTalkingStarted`, audio is sent to OpenAI.
                *   If no speech is detected within `APP_APPRECOGNITION_VADMAXWAITAFTERPROMPTSECONDS` (timer starts after prompt finishes), the turn may end.
        *   Once `ChannelTalkingStarted` triggers OpenAI activation, `TALK_DETECT` is typically removed from the channel for that turn, and OpenAI's VAD takes over.
    *   **Key Configuration**: `RECOGNITION_ACTIVATION_MODE="vad"`, `APP_APPRECOGNITION_VADSILENCETHRESHOLDMS`, `APP_APPRECOGNITION_VADTALKTHRESHOLD`, `APP_APPRECOGNITION_VADRECOGACTIVATION`. Depending on `vadRecogActivation`: `APP_APPRECOGNITION_VADINITIALSILENCEDELAYSECONDS`, `APP_APPRECOGNITION_VADMAXWAITAFTERPROMPTSECONDS`.
    *   **Relevant Timers**: `noSpeechBeginTimeoutSeconds`, `speechEndSilenceTimeoutSeconds`, `maxRecognitionDurationSeconds` (once OpenAI stream is active). Also, `vadInitialSilenceDelayTimer` and `vadMaxWaitAfterPromptTimer` for controlling VAD stages.
    *   **Ignored Timers/Settings**: `BARGE_IN_DELAY_SECONDS`. DTMF timers are separate.

---

4.  **`DTMF` Mode (Interrupts other modes)**:
    *   **Purpose**: Allows user to input digits using their keypad, which takes precedence over and typically interrupts any active speech recognition or playback.
    *   **Behavior**:
        *   This mode is activated if `DTMF_ENABLED` (or `appConfig.dtmfConfig.enableDtmfRecognition`) is true and a DTMF digit is received.
        *   **Interruption**: Any ongoing audio playback (prompts) is stopped. All other recognition modes (`fixedDelay`, `Immediate`, `vad`) are halted. Any active OpenAI stream is terminated. Local VAD (`TALK_DETECT`) is removed from the channel.
        *   **Timer Invalidation**: All speech recognition timers (`noSpeechBeginTimeoutSeconds`, `speechEndSilenceTimeoutSeconds`, `maxRecognitionDurationSeconds`) and VAD-specific timers (`vadInitialSilenceDelayTimer`, `vadMaxWaitAfterPromptTimer`, `bargeInDelaySeconds`) are cleared.
        *   **DTMF Collection**: Received digits are collected.
        *   **DTMF Timers**:
            *   `dtmfInterDigitTimeoutSeconds` (from `DTMF_INTERDIGIT_TIMEOUT_SECONDS`): Time to wait for the next digit. If it expires, the collected DTMF sequence is considered complete.
            *   `dtmfFinalTimeoutSeconds` (from `DTMF_FINAL_TIMEOUT_SECONDS`): Overall timeout for DTMF input. If active and expires, the collected DTMF sequence is considered complete.
        *   **Termination**: DTMF input also finalizes if a `dtmfTerminatorDigit` (from `config.appConfig.dtmfConfig.dtmfTerminatorDigit`) is received or if `dtmfMaxDigits` (from `config.appConfig.dtmfConfig.dtmfMaxDigits`) is reached.
        *   **Result**: The collected DTMF string is set as the `DTMF_RESULT` channel variable on the Asterisk channel. The application then typically ends the current interaction phase, allowing the Asterisk dialplan to proceed based on `DTMF_RESULT`.
    *   **Key Configuration**: `DTMF_ENABLED`, `DTMF_INTERDIGIT_TIMEOUT_SECONDS`, `DTMF_FINAL_TIMEOUT_SECONDS`. Also `dtmfTerminatorDigit` and `dtmfMaxDigits` from `config/default.json`.
    *   **Standard Active Timers**: The common speech-related timers are NOT active during DTMF mode.

## Timeout Management

Key timers from `appConfig.appRecognitionConfig` and `appConfig.dtmfConfig` control call flow and prevent stuck calls:

*   **General Speech Recognition Timers (used by `fixedDelay`, `Immediate`, `vad` once OpenAI is active):**
    *   `noSpeechBeginTimeoutSeconds`: Prevents indefinite waiting if OpenAI doesn't detect speech.
    *   `speechEndSilenceTimeoutSeconds`: Determines end-of-utterance based on silence after speech.
    *   `maxRecognitionDurationSeconds`: Overall cap on a single speech recognition turn.

*   **Mode-Specific Timers:**
    *   `fixedDelay` Mode:
        *   `bargeInDelaySeconds`: Delays start of OpenAI streaming.
    *   `vad` Mode:
        *   `vadInitialSilenceDelaySeconds` (`APP_APPRECOGNITION_VADINITIALSILENCEDELAYSECONDS`): Delays VAD activation in `vadMode="vadMode"`.
        *   `vadMaxWaitAfterPromptSeconds` (`APP_APPRECOGNITION_VADMAXWAITAFTERPROMPTSECONDS`): Max time to wait for speech after a prompt (in `vadMode="afterPrompt"`) or after initial delays (in `vadMode="vadMode"`).
    *   `DTMF` Mode:
        *   `dtmfInterDigitTimeoutSeconds` (`DTMF_INTERDIGIT_TIMEOUT_SECONDS`): Timeout between DTMF digits.
        *   `dtmfFinalTimeoutSeconds` (`DTMF_FINAL_TIMEOUT_SECONDS`): Overall timeout for the DTMF sequence.

All these timers are managed in `ari-client.ts` and are cleared during call cleanup (`_fullCleanup`) or when transitioning between modes (e.g., speech to DTMF).

## Asterisk Dialplan Integration

To route a call to this Stasis application, you need to configure your Asterisk dialplan (e.g., in `extensions.conf`).

**Sample Dialplan Snippet:**

Assuming your `ASTERISK_ARI_APP_NAME` (from `.env`) is `openai-ari-app` and you want to trigger the app by dialing extension `7000`:

```
[from-your-sip-provider-or-internal] ; Replace with your actual inbound context
exten => 7000,1,NoOp(Call to OpenAI ARI Assistant)
 same => n,Stasis(openai-ari-app)
 same => n,Hangup()
```

**Overriding Configuration with Channel Variables (Example - Conceptual):**

While full support for overriding all configurations via channel variables is a TODO in `ari-client.ts`, the mechanism would look like this in the dialplan:

```
exten => 7001,1,NoOp(Call to OpenAI with VAD mode forced)
 same => n,Set(APP_RECOGNITION_ACTIVATION_MODE=VAD) ; Overrides .env or default.json
 same => n,Set(APP_GREETING_AUDIO_PATH=sound:your-custom-greeting)
 same => n,Stasis(openai-ari-app)
 same => n,Hangup()
```
The `ari-client.ts`'s `getCallSpecificConfig` function would need to be enhanced to read these `APP_` prefixed variables.

**Channel Variables Set by the Application:**

The application may set the following channel variables on the original channel before hanging up:

*   `DTMF_RESULT`: If DTMF input is collected, this variable will contain the final string of digits.
*   `FINAL_TRANSCRIPTION`: (TODO) The final transcript from OpenAI could be set here.
*   `RECOGNITION_ERROR`: (TODO) If an error occurred during speech recognition.

These variables can be used by subsequent steps in your Asterisk dialplan after the Stasis application returns.
