# Variables de Configuración y Entorno del `websocket-server`

Este documento describe las variables de entorno y los parámetros de configuración JSON utilizados por la aplicación `websocket-server`. La configuración se carga principalmente desde `config/default.json` y puede ser sobrescrita individualmente por variables de entorno.

**Prioridad de Configuración:**
1.  Variables de Canal de Asterisk (si se implementa la lectura en `getCallSpecificConfig` para una variable específica).
2.  Variables de Entorno (archivo `.env` o seteadas en el sistema).
3.  Valores del archivo `config/default.json`.
4.  Valores por defecto codificados en la aplicación (como último recurso).

## Variables de Entorno (`.env`)

Estas variables se definen en un archivo `.env` en la raíz del directorio `websocket-server`.

### Configuración General del Servidor
*   **`PORT`**:
    *   Descripción: Puerto en el que el servidor WebSocket/HTTP escuchará.
    *   Default (en `server.ts` si no está seteado): `8081`
    *   Ejemplo: `PORT="8081"`
*   **`WEBSOCKET_SERVER_HOST_IP`**:
    *   Descripción: Dirección IP a la que se enlazará el servidor WebSocket/HTTP.
    *   Default (en `server.ts` si no está seteado): `0.0.0.0` (escucha en todas las interfaces)
    *   Ejemplo: `WEBSOCKET_SERVER_HOST_IP="0.0.0.0"`
*   **`PUBLIC_URL`**:
    *   Descripción: (Opcional) URL pública base del servidor. Usada por otros servicios o para generar URLs completas.
    *   Default: `""` (vacío)
    *   Ejemplo: `PUBLIC_URL="http://yourdomain.com:8081"`
*   **`CONFIG_FILE_PATH`**:
    *   Descripción: Ruta al archivo de configuración JSON base.
    *   Default: `config/default.json` (relativo a la raíz del proyecto `websocket-server`)
    *   Ejemplo: `CONFIG_FILE_PATH="config/custom-config.json"`
*   **`LOG_LEVEL`**:
    *   Descripción: Nivel de logging para la aplicación.
    *   Valores: `silly`, `debug`, `info`, `warn`, `error`.
    *   Default: Valor en `config.logging.level` (`info`). `debug` o `silly` son útiles para diagnóstico detallado.
    *   Ejemplo: `LOG_LEVEL="debug"`

### Configuración de OpenAI
*   **`OPENAI_API_KEY`**:
    *   **Descripción**: **REQUERIDA**. Tu clave API secreta de OpenAI.
    *   Default: No hay (la aplicación fallará si no se provee).
    *   Ejemplo: `OPENAI_API_KEY="sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxx"`
*   **`OPENAI_REALTIME_MODEL`**:
    *   **Descripción**: **REQUERIDA**. El ID del modelo Realtime de OpenAI a utilizar.
    *   Default: `gpt-4o-mini-realtime-preview-2024-12-17` (controlado por `config.openAIRealtimeAPI.model`).
    *   Ejemplo: `OPENAI_REALTIME_MODEL="gpt-4o-realtime-..."`
*   **`ACTIVE_AGENT_CONFIG_KEY`**:
    *   Descripción: Clave que identifica la configuración de agente (escenario) a cargar desde `config/agentConfigs/index.ts`. Determina las instrucciones, herramientas y personalidad del asistente. El primer agente en el array del escenario seleccionado será el que reciba la llamada.
    *   Default: `chatSupervisor` (definido en `config/agentConfigs/index.ts` como `defaultAgentSetKey`).
    *   Ejemplo: `ACTIVE_AGENT_CONFIG_KEY="medicalAppointment"`
*   **`OPENAI_RESPONSE_MODALITIES`**:
    *   Descripción: Modalidades de respuesta solicitadas a OpenAI, separadas por coma.
    *   Valores: `audio`, `text`. Combinaciones válidas: `"audio,text"`, `"text"`.
    *   Default: `audio,text` (controlado por `config.openAIRealtimeAPI.responseModalities`).
    *   Ejemplo: `OPENAI_RESPONSE_MODALITIES="text"`
*   **`OPENAI_TTS_MODEL`**:
    *   Descripción: Modelo TTS de OpenAI (ej. `tts-1`, `tts-1-hd`). Usado si la API Realtime no maneja TTS como parte de la sesión, o para funcionalidades TTS separadas/de respaldo.
    *   Default: `tts-1` (controlado por `config.openAIRealtimeAPI.ttsModel`, aunque no existe explícitamente esta variable en `default.json`, se usa el valor de `.env.example`).
    *   Ejemplo: `OPENAI_TTS_MODEL="tts-1-hd"`
*   **`OPENAI_TTS_VOICE`**:
    *   Descripción: Voz para TTS de OpenAI (ej. `alloy`, `echo`, `fable`, `onyx`, `nova`, `shimmer`).
    *   Default: `alloy` (controlado por `config.openAIRealtimeAPI.ttsVoice`).
    *   Ejemplo: `OPENAI_TTS_VOICE="nova"`
*   **`OPENAI_LANGUAGE`**:
    *   Descripción: Código de idioma para STT (ej. `en`, `es`). Para la API Realtime, el soporte de idioma a menudo está ligado a las capacidades del modelo específico y puede manejarse implícitamente o configurarse de manera diferente.
    *   Default: `en` (controlado por `config.openAIRealtimeAPI.language`).
    *   Ejemplo: `OPENAI_LANGUAGE="es"`
*   **`OPENAI_INPUT_AUDIO_FORMAT`**:
    *   Descripción: Formato de audio de entrada enviado a OpenAI. Para passthrough directo de u-law (8kHz) desde Asterisk, usar `"g711_ulaw"` o el string exacto que OpenAI espere. **VERIFICAR CON DOCUMENTACIÓN DE OPENAI.**
    *   Default: `g711_ulaw` (controlado por `config.openAIRealtimeAPI.inputAudioFormat`).
    *   Ejemplo: `OPENAI_INPUT_AUDIO_FORMAT="pcm_s16le_16000hz"` (si se transcodifica a PCM 16kHz)
*   **`OPENAI_INPUT_AUDIO_SAMPLE_RATE`**:
    *   Descripción: Tasa de muestreo para la entrada STT (ej. `8000`, `16000`). Para formatos como `"g711_ulaw"`, la tasa (típicamente 8000 Hz) a menudo está implícita en el string del formato.
    *   Default: `8000` (controlado por `config.openAIRealtimeAPI.inputAudioSampleRate`).
    *   Ejemplo: `OPENAI_INPUT_AUDIO_SAMPLE_RATE="16000"`
*   **`OPENAI_OUTPUT_AUDIO_FORMAT`**:
    *   Descripción: Formato de audio TTS deseado de OpenAI. Para reproducción directa de u-law (8kHz) en Asterisk, se recomienda `"g711_ulaw"`. **VERIFICAR CON DOCUMENTACIÓN DE OPENAI.**
    *   Default: `g711_ulaw` (controlado por `config.openAIRealtimeAPI.outputAudioFormat`).
    *   Ejemplo: `OPENAI_OUTPUT_AUDIO_FORMAT="pcm_s16le_8000hz"` (para WAV 8kHz)
*   **`OPENAI_OUTPUT_AUDIO_SAMPLE_RATE`**:
    *   Descripción: Tasa de muestreo para la salida TTS (ej. `8000`, `24000`). Para formatos como `"g711_ulaw"`, la tasa (típicamente 8000 Hz) a menudo está implícita.
    *   Default: `8000` (controlado por `config.openAIRealtimeAPI.outputAudioSampleRate`).
    *   Ejemplo: `OPENAI_OUTPUT_AUDIO_SAMPLE_RATE="16000"` (si se solicita TTS en 16kHz PCM)

### Configuración de Asterisk ARI
*   **`ASTERISK_ARI_URL`**:
    *   Descripción: URL para la Asterisk REST Interface (ARI).
    *   Default (en `ari-client.ts`): `http://localhost:8088`
    *   Ejemplo: `ASTERISK_ARI_URL="http://asterisk.example.com:8088"`
*   **`ASTERISK_ARI_USERNAME`**:
    *   Descripción: Nombre de usuario para ARI.
    *   Default (en `ari-client.ts`): `asterisk`
    *   Ejemplo: `ASTERISK_ARI_USERNAME="ari_user"`
*   **`ASTERISK_ARI_PASSWORD`**:
    *   Descripción: Contraseña para ARI.
    *   Default (en `ari-client.ts`): `asterisk`
    *   Ejemplo: `ASTERISK_ARI_PASSWORD="securepassword"`
*   **`ASTERISK_ARI_APP_NAME`**:
    *   Descripción: Nombre de la aplicación Stasis en Asterisk (debe coincidir con el plan de marcado).
    *   Default (en `ari-client.ts`): `openai-ari-app`
    *   Ejemplo: `ASTERISK_ARI_APP_NAME="my-voice-assistant"`
*   **`ASTERISK_INBOUND_CONTEXT`**:
    *   Descripción: (Opcional, informativo) Contexto del plan de marcado de Asterisk donde las llamadas entrantes se enrutan a esta aplicación ARI.
    *   Ejemplo: `ASTERISK_INBOUND_CONTEXT="from-pstn"`
*   **`ASTERISK_DIAL_EXTENSION`**:
    *   Descripción: (Opcional, informativo) Extensión dentro de `ASTERISK_INBOUND_CONTEXT` que invoca esta aplicación ARI.
    *   Ejemplo: `ASTERISK_DIAL_EXTENSION="s"`

### Configuración del Servidor RTP (Media)
*   **`RTP_HOST_IP`**:
    *   Descripción: Dirección IP de este servidor que Asterisk debe usar para enviar media RTP. Usar la IP real del host si Asterisk está en una máquina diferente o en Docker.
    *   Default (en `ari-client.ts`): `127.0.0.1`
    *   Ejemplo: `RTP_HOST_IP="192.168.1.100"`
*   **`RTP_MIN_PORT`**:
    *   Descripción: Puerto mínimo para los listeners RTP.
    *   Default: `10000`
    *   Ejemplo: `RTP_MIN_PORT="20000"`
*   **`RTP_MAX_PORT`**:
    *   Descripción: Puerto máximo para los listeners RTP.
    *   Default: `10010`
    *   Ejemplo: `RTP_MAX_PORT="20020"`

### Configuración del Comportamiento de la Aplicación y Modos de Reconocimiento
*   **`RECOGNITION_ACTIVATION_MODE`**:
    *   Descripción: Cómo se activa el reconocimiento de voz para la mayoría de las interacciones.
    *   Valores: `"vad"`, `"Immediate"`, `"fixedDelay"`.
    *   Default: `"vad"` (controlado por `.env.example`, o `fixedDelay` en `default.json`).
    *   Ejemplo: `RECOGNITION_ACTIVATION_MODE="Immediate"`
*   **`FIRST_INTERACTION_RECOGNITION_MODE`**:
    *   Descripción: (Opcional) Anula `RECOGNITION_ACTIVATION_MODE` solo para la primera interacción del llamante. Mismas opciones que `RECOGNITION_ACTIVATION_MODE`. Si está vacío o no se establece, se usa el modo global.
    *   Default: `""` (vacío)
    *   Ejemplo: `FIRST_INTERACTION_RECOGNITION_MODE="Immediate"`
*   **`OPENAI_TTS_PLAYBACK_MODE`**:
    *   Descripción: (Opcional) Cómo se reproduce el audio TTS. `"full_chunk"` espera a que llegue todo el audio antes de reproducir. `"stream"` intenta reproducir los chunks de audio a medida que llegan (experimental, puede requerir ajustes).
    *   Valores: `"full_chunk"`, `"stream"`.
    *   Default: `"full_chunk"`
    *   Ejemplo: `OPENAI_TTS_PLAYBACK_MODE="stream"`
*   **`INITIAL_USER_PROMPT`**:
    *   Descripción: (Opcional) Un mensaje de "usuario" sintético inicial para hacer que el asistente hable primero al inicio de la llamada. Si se establece, este texto se envía al modelo de OpenAI como el primer turno del usuario.
    *   Default: `""` (vacío)
    *   Ejemplo: `INITIAL_USER_PROMPT="Hola, por favor preséntate."`
*   **`GREETING_AUDIO_PATH`**:
    *   Descripción: (Opcional) Ruta a un archivo de audio para el saludo inicial, reconocible por Asterisk (ej. `sound:hello-world` o una ruta absoluta). Anula el saludo por defecto en `default.json`.
    *   Default: `sound:hello-world` (en `default.json`).
    *   Ejemplo: `GREETING_AUDIO_PATH="sound:custom/my-greeting"`
*   **`INITIAL_GREETING_AUDIO_PATH`**:
    *   Descripción: (Opcional) Similar a `GREETING_AUDIO_PATH` pero tiene mayor precedencia si ambos están definidos.
    *   Default: `""` (vacío)
    *   Ejemplo: `INITIAL_GREETING_AUDIO_PATH="sound:urgent-greeting"`

### Configuración de VAD (Voice Activity Detection)
*(Usado cuando `RECOGNITION_ACTIVATION_MODE` o `FIRST_INTERACTION_RECOGNITION_MODE` es `"vad"`)*
*   **`APP_APPRECOGNITION_VADSILENCETHRESHOLDMS`**:
    *   Descripción: Umbral de silencio de Asterisk `TALK_DETECT` en milisegundos. Tiempo de silencio después del habla para disparar `ChannelTalkingFinished`.
    *   Default: `2500` (controlado por `default.json`).
    *   Ejemplo: `APP_APPRECOGNITION_VADSILENCETHRESHOLDMS="3000"`
*   **`APP_APPRECOGNITION_VADTALKTHRESHOLD`**:
    *   Descripción: Umbral de nivel de energía de Asterisk `TALK_DETECT`. Audio por encima de este nivel se considera habla, disparando `ChannelTalkingStarted`.
    *   Default: `256` (controlado por `default.json`).
    *   Ejemplo: `APP_APPRECOGNITION_VADTALKTHRESHOLD="300"`
*   **`APP_APPRECOGNITION_VADRECOGACTIVATION`**:
    *   Descripción: Para el modo VAD: define cuándo se activa el reconocimiento basado en VAD.
    *   Valores: `"vadMode"` (escucha después de un retardo inicial), `"afterPrompt"` (escucha después de que termine el saludo/prompt).
    *   Default: `"vadMode"` (controlado por `default.json`).
    *   Ejemplo: `APP_APPRECOGNITION_VADRECOGACTIVATION="afterPrompt"`
*   **`APP_APPRECOGNITION_VADMAXWAITAFTERPROMPTSECONDS`**:
    *   Descripción: Para el modo VAD: Tiempo máximo (segundos) a esperar por el habla después de que el saludo termine (y después de `APP_APPRECOGNITION_VADINITIALSILENCEDELAYSECONDS` si está en modo `"vadMode"`).
    *   Default: `10.0` (controlado por `default.json`).
    *   Ejemplo: `APP_APPRECOGNITION_VADMAXWAITAFTERPROMPTSECONDS="7.5"`
*   **`APP_APPRECOGNITION_VADINITIALSILENCEDELAYSECONDS`**:
    *   Descripción: Para el modo VAD con `vadRecogActivation="vadMode"`: Retardo (segundos) desde el inicio de la llamada/turno antes de que el VAD escuche activamente los eventos `TALK_DETECT`. El audio se almacena en búfer durante este retardo.
    *   Default: `0.0` (controlado por `default.json`).
    *   Ejemplo: `APP_APPRECOGNITION_VADINITIALSILENCEDELAYSECONDS="1.0"`
*   **`VAD_TALK_DURATION_THRESHOLD_MS`**:
    *   Descripción: (Avanzado) Duración (ms) del habla para la configuración interna `vadRecognitionActivationMs` de `TALK_DETECT` en `default.json`.
    *   Default: `40` (controlado por `default.json` bajo `vadConfig.vadRecognitionActivationMs`).
    *   Ejemplo: `VAD_TALK_DURATION_THRESHOLD_MS="50"`

### Temporizadores de Reconocimiento de Voz (Segundos)
*(Aplican a los modos `fixedDelay`, `Immediate`, y `vad` una vez que el stream de OpenAI está activo y escuchando al usuario)*
*   **`NO_SPEECH_BEGIN_TIMEOUT_SECONDS`**:
    *   Descripción: Tiempo máximo que la aplicación espera a que OpenAI detecte el inicio del habla (evento `speech_started` o primer transcript intermedio).
    *   Default: `5.0` (controlado por `default.json`).
    *   Ejemplo: `NO_SPEECH_BEGIN_TIMEOUT_SECONDS="7.0"`
*   **`SPEECH_END_SILENCE_TIMEOUT_SECONDS`**:
    *   Descripción: Tiempo máximo que la aplicación espera por un transcript final de OpenAI después del último transcript intermedio o actividad de habla.
    *   Default: `1.5` (controlado por `default.json`).
    *   Ejemplo: `SPEECH_END_SILENCE_TIMEOUT_SECONDS="2.0"`
*   **`MAX_RECOGNITION_DURATION_SECONDS`**:
    *   Descripción: Duración máxima absoluta (segundos) para todo el intento de reconocimiento de voz para un solo turno de llamada.
    *   Default: `30.0` (controlado por `default.json`).
    *   Ejemplo: `MAX_RECOGNITION_DURATION_SECONDS="45.0"`
*   **`INITIAL_OPENAI_STREAM_IDLE_TIMEOUT_SECONDS`**:
    *   Descripción: (Avanzado) Timeout en segundos para que el stream inicial de OpenAI se vuelva responsivo (ej. envíe el primer evento). En gran medida reemplazado por `NO_SPEECH_BEGIN_TIMEOUT_SECONDS` para propósitos prácticos, pero se mantiene para diagnósticos más profundos.
    *   Default: `10` (controlado por `default.json`).
    *   Ejemplo: `INITIAL_OPENAI_STREAM_IDLE_TIMEOUT_SECONDS="15"`

### Configuración de DTMF
*   **`DTMF_ENABLED`**:
    *   Descripción: Habilita (`"true"`) o deshabilita (`"false"`) el reconocimiento DTMF.
    *   Default: `"true"` (controlado por `default.json` como `enableDtmfRecognition`).
    *   Ejemplo: `DTMF_ENABLED="false"`
*   **`DTMF_INTERDIGIT_TIMEOUT_SECONDS`**:
    *   Descripción: Timeout en segundos entre dígitos DTMF.
    *   Default: `3.0` (controlado por `default.json`).
    *   Ejemplo: `DTMF_INTERDIGIT_TIMEOUT_SECONDS="2.5"`
*   **`DTMF_FINAL_TIMEOUT_SECONDS`**:
    *   Descripción: Timeout en segundos después del último dígito DTMF para finalizar la entrada.
    *   Default: `5.0` (controlado por `default.json`).
    *   Ejemplo: `DTMF_FINAL_TIMEOUT_SECONDS="4.0"`
*   *Nota: `DTMF_MAX_DIGITS` y `DTMF_TERMINATOR_DIGIT` se configuran en `config/default.json` (actualmente `16` y `"#"` respectivamente) y no suelen anularse mediante `.env`.*

### Configuración de Barge-In (Modo `fixedDelay`)
*   **`BARGE_IN_DELAY_SECONDS`**:
    *   Descripción: Retardo (segundos) antes de activar el reconocimiento en modo `"fixedDelay"`. Permite al llamante hablar después de que comience el saludo/prompt.
    *   Default: `0.2` (controlado por `default.json`).
    *   Ejemplo: `BARGE_IN_DELAY_SECONDS="0.5"`
*   **`BARGE_IN_MODE_ENABLED`**:
    *   Descripción: (Legado, mayormente informativo ya que el barge-in es implícito en los modos).
    *   Default: `"true"` (controlado por `default.json`).
    *   Ejemplo: `BARGE_IN_MODE_ENABLED="true"`

### Configuración de Redis (Opcional - para logueo de conversaciones)
*   **`REDIS_HOST`**:
    *   Descripción: Hostname/IP del servidor Redis.
    *   Default: `"127.0.0.1"`
    *   Ejemplo: `REDIS_HOST="my-redis-instance.example.com"`
*   **`REDIS_PORT`**:
    *   Descripción: Puerto del servidor Redis.
    *   Default: `6379`
    *   Ejemplo: `REDIS_PORT="6380"`
*   **`REDIS_PASSWORD`**:
    *   Descripción: Contraseña para el servidor Redis (si se requiere).
    *   Default: `undefined` (sin contraseña)
    *   Ejemplo: `REDIS_PASSWORD="yourSecurePassword"`
*   **`REDIS_CONVERSATION_TTL_SECONDS`**:
    *   Descripción: Tiempo de vida (TTL) en segundos para los logs de conversación y los parámetros de sesión almacenados en Redis.
    *   Default: `3600` (1 hora)
    *   Ejemplo: `REDIS_CONVERSATION_TTL_SECONDS="86400"` (24 horas)

### Configuración de STT Asíncrono (Fallback STT)
*   **`ASYNC_STT_ENABLED`**:
    *   Descripción: Habilita (`"true"`) o deshabilita (`"false"`) el STT asíncrono.
    *   Default: `"false"` (controlado por `default.json`).
    *   Ejemplo: `ASYNC_STT_ENABLED="true"`
*   **`ASYNC_STT_PROVIDER`**:
    *   Descripción: Proveedor para el STT asíncrono.
    *   Valores: `"openai_whisper_api"`, `"google_speech_v1"`, `"vosk"`.
    *   Default: `"openai_whisper_api"` (controlado por `default.json`).
    *   Ejemplo: `ASYNC_STT_PROVIDER="vosk"`
*   **Configuración Específica de Proveedor Async STT:**
    *   **OpenAI Whisper API:**
        *   `ASYNC_STT_OPENAI_MODEL`: Modelo para OpenAI Whisper (ej. `"whisper-1"`). Default: `"whisper-1"`.
        *   `ASYNC_STT_OPENAI_API_KEY`: Clave API de OpenAI para STT asíncrono. Si está vacía, intenta usar `OPENAI_API_KEY`. Default: `""`.
        *   `ASYNC_STT_LANGUAGE`: Código de idioma opcional para OpenAI Whisper (ej. `"en"`, `"es"`). Default: `"en"`.
    *   **Google Cloud Speech-to-Text V1:**
        *   `ASYNC_STT_GOOGLE_LANGUAGE_CODE`: Código de idioma para Google Speech (ej. `"en-US"`, `"es-ES"`). Default: `"es-ES"`.
        *   `ASYNC_STT_GOOGLE_CREDENTIALS`: (Opcional) Ruta al archivo JSON de credenciales de Google Cloud. Si no se establece, se usarán las Credenciales Predeterminadas de la Aplicación (ADC). Default: `""`.
    *   **Vosk Offline STT:**
        *   `VOSK_SERVER_URL`: URL del WebSocket para la instancia del servidor Vosk.
        *   Ejemplo: `VOSK_SERVER_URL="ws://localhost:2700"`
*   **Configuración Común de Audio para Async STT:**
    *   `ASYNC_STT_AUDIO_FORMAT`: Formato del audio interno pasado al transcriptor asíncrono desde el búfer. Típicamente `"mulaw"` o `"wav"` (si se convierte).
    *   Default: `"mulaw"` (controlado por `default.json`).
    *   Ejemplo: `ASYNC_STT_AUDIO_FORMAT="wav"`
    *   `ASYNC_STT_AUDIO_SAMPLE_RATE`: Tasa de muestreo del búfer de audio para STT asíncrono.
    *   Default: `8000` (controlado por `default.json`).
    *   Ejemplo: `ASYNC_STT_AUDIO_SAMPLE_RATE="16000"`

## Parámetros de Configuración en `config/default.json`

El archivo `config/default.json` (ubicado en `websocket-server/config/default.json`) define los parámetros operativos predeterminados. Su estructura incluye secciones para `appConfig` (con `appRecognitionConfig`, `dtmfConfig`, `bargeInConfig`), `openAIRealtimeAPI`, y `logging`.

**Extracto de la Estructura de `default.json`:**
```json
{
  "appConfig": {
    "appRecognitionConfig": {
      "recognitionActivationMode": "fixedDelay", // "fixedDelay", "Immediate", "vad"
      "bargeInDelaySeconds": 0.2,
      "noSpeechBeginTimeoutSeconds": 5.0,
      "speechEndSilenceTimeoutSeconds": 1.5,
      "maxRecognitionDurationSeconds": 30.0,
      "vadSilenceThresholdMs": 2500,
      "vadTalkThreshold": 256,
      "vadRecogActivation": "vadMode", // "vadMode", "afterPrompt"
      "vadMaxWaitAfterPromptSeconds": 10.0,
      "vadInitialSilenceDelaySeconds": 0.0,
      "vadConfig": { // Configuración interna para TALK_DETECT
        "vadSilenceThresholdMs": 2500,
        "vadRecognitionActivationMs": 40 // Duración del habla para TALK_DETECT
      },
      "greetingAudioPath": "sound:hello-world", // Saludo por defecto
      "initialOpenAIStreamIdleTimeoutSeconds": 10,
      // Configuración Async STT por defecto
      "asyncSttEnabled": false,
      "asyncSttProvider": "openai_whisper_api",
      "asyncSttOpenaiModel": "whisper-1",
      "asyncSttOpenaiApiKey": "",
      "asyncSttLanguage": "en",
      "asyncSttAudioFormat": "mulaw",
      "asyncSttAudioSampleRate": 8000,
      "asyncSttGoogleLanguageCode": "es-ES",
      "asyncSttGoogleCredentials": ""
    },
    "dtmfConfig": {
      "enableDtmfRecognition": true,
      "dtmfInterDigitTimeoutSeconds": 3.0,
      "dtmfFinalTimeoutSeconds": 5.0,
      "dtmfMaxDigits": 16,
      "dtmfTerminatorDigit": "#"
    },
    "bargeInConfig": { // Legado, bargeInDelaySeconds está ahora en appRecognitionConfig
      "bargeInModeEnabled": true
    }
  },
  "openAIRealtimeAPI": {
    "model": "gpt-4o-mini-realtime-preview-2024-12-17",
    "language": "en",
    "inputAudioFormat": "g711_ulaw",
    "inputAudioSampleRate": 8000,
    "ttsVoice": "alloy",
    "outputAudioFormat": "g711_ulaw",
    "outputAudioSampleRate": 8000,
    "responseModalities": ["audio", "text"],
    "instructions": "Este valor se sobrescribirá por la configuración del agente activo.", // Placeholder
    "tools": [] // Placeholder, cargado desde la configuración del agente
  },
  "logging": {
    "level": "info" // silly, debug, info, warn, error
  }
}
```

Es importante consultar `ari-client.ts` (específicamente la función `getCallSpecificConfig`) y `config/default.json` para ver exactamente cómo se leen y priorizan estas configuraciones.
