# Variables de Configuración y Entorno del `websocket-server`

Este documento describe las variables de entorno y los parámetros de configuración JSON utilizados por la aplicación `websocket-server`. La configuración se carga principalmente desde `config/default.json` y puede ser sobrescrita individualmente por variables de entorno.

## Variables de Entorno Principales (`.env`)

Estas son las variables más críticas que generalmente se configuran en un archivo `.env` en la raíz del directorio `websocket-server`.

*   **`PORT`**:
    *   Descripción: El puerto en el que el servidor WebSocket/HTTP escuchará las conexiones.
    *   Default (en `server.ts` si no está seteado): `8081`
    *   Ejemplo: `PORT=8081`

*   **`WEBSOCKET_SERVER_HOST_IP`**:
    *   Descripción: La dirección IP en la que el servidor WebSocket/HTTP se enlazará.
    *   Default (en `server.ts` si no está seteado): `0.0.0.0` (escucha en todas las interfaces de red disponibles)
    *   Ejemplo: `WEBSOCKET_SERVER_HOST_IP=0.0.0.0`

*   **`PUBLIC_URL`**:
    *   Descripción: La URL pública base del servidor. Puede ser utilizada por otros servicios o para generar URLs completas si es necesario.
    *   Default: `""` (vacío)
    *   Ejemplo: `PUBLIC_URL=http://localhost:8081`

*   **`OPENAI_API_KEY`**:
    *   **Descripción**: **Requerida**. Tu clave API secreta de OpenAI.
    *   Default: No hay (la aplicación fallará si no se provee).
    *   Ejemplo: `OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxx`

*   **`ASTERISK_ARI_URL`**:
    *   Descripción: La URL base para la Asterisk REST Interface (ARI).
    *   Default (en `ari-client.ts`): `http://localhost:8088`
    *   Ejemplo: `ASTERISK_ARI_URL=http://asterisk.example.com:8088`

*   **`ASTERISK_ARI_USERNAME`**:
    *   Descripción: El nombre de usuario para la conexión ARI.
    *   Default (en `ari-client.ts`): `asterisk`
    *   Ejemplo: `ASTERISK_ARI_USERNAME=ari_user`

*   **`ASTERISK_ARI_PASSWORD`**:
    *   Descripción: La contraseña para la conexión ARI.
    *   Default (en `ari-client.ts`): `asterisk`
    *   Ejemplo: `ASTERISK_ARI_PASSWORD=securepassword`

*   **`ASTERISK_ARI_APP_NAME`**:
    *   Descripción: El nombre de la aplicación Stasis que Asterisk debe invocar. Debe coincidir con la configuración en `stasis.conf` o `extensions.conf` de Asterisk.
    *   Default (en `ari-client.ts`): `openai-ari-app`
    *   Ejemplo: `ASTERISK_ARI_APP_NAME=my-custom-ari-app`

*   **`RTP_HOST_IP`**:
    *   Descripción: La dirección IP que el `RtpServer` usará para enlazar el socket UDP. Generalmente es la IP local del servidor donde corre la aplicación Node.js, accesible desde Asterisk.
    *   Default (en `ari-client.ts`): `127.0.0.1`
    *   Ejemplo: `RTP_HOST_IP=192.168.1.100`

*   **`CONFIG_FILE_PATH`**:
    *   Descripción: Ruta al archivo de configuración JSON base.
    *   Default (en `ari-client.ts`): `../config/default.json` (relativo al directorio `src`)
    *   Ejemplo: `CONFIG_FILE_PATH=/etc/my-app/config.json`

*   **`LOG_LEVEL`**:
    *   Descripción: Nivel de logging para la aplicación. Puede ser `silly`, `debug`, `info`, `warn`, `error`.
    *   Default: El valor en `config.logging.level` del archivo JSON (que es `info` por defecto).
    *   Ejemplo: `LOG_LEVEL=debug`

*   **`INITIAL_GREETING_AUDIO_PATH`** / **`GREETING_AUDIO_PATH`**:
    *   Descripción: Ruta al archivo de audio para el saludo inicial. Puede ser una ruta de archivo local de Asterisk (ej. `sound:hello-world`) o una ruta absoluta. `INITIAL_GREETING_AUDIO_PATH` tiene precedencia.
    *   Default: `sound:hello-world` (controlado por `config.appConfig.appRecognitionConfig.greetingAudioPath`).
    *   Ejemplo: `GREETING_AUDIO_PATH=sound:custom/my-greeting`

*   **`MAX_RECOGNITION_DURATION_SECONDS`**:
    *   Descripción: Duración máxima en segundos para un turno de reconocimiento de voz.
    *   Default: `30` (controlado por `config.appConfig.appRecognitionConfig.maxRecognitionDurationSeconds`).
    *   Ejemplo: `MAX_RECOGNITION_DURATION_SECONDS=60`

*   **`NO_SPEECH_BEGIN_TIMEOUT_SECONDS`**:
    *   Descripción: Segundos a esperar por el inicio del habla (desde que se activa el stream a OpenAI) antes de considerar un timeout.
    *   Default: `3` (controlado por `config.appConfig.appRecognitionConfig.noSpeechBeginTimeoutSeconds`).
    *   Ejemplo: `NO_SPEECH_BEGIN_TIMEOUT_SECONDS=5`

*   **`SPEECH_COMPLETE_TIMEOUT_SECONDS`**:
    *   Descripción: Segundos de silencio después de que el usuario deja de hablar antes de considerar que la entrada de voz está completa.
    *   Default: `5` (controlado por `config.appConfig.appRecognitionConfig.speechCompleteTimeoutSeconds`).
    *   Ejemplo: `SPEECH_COMPLETE_TIMEOUT_SECONDS=3`

*   **`OPENAI_REALTIME_MODEL`**:
    *   Descripción: El modelo de OpenAI a utilizar para la API Realtime.
    *   Default: `gpt-4o-mini-realtime-preview-2024-12-17` (controlado por `config.openAIRealtimeAPI.model`).
    *   Ejemplo: `OPENAI_REALTIME_MODEL=gpt-4o-realtime-preview-2024-07-01`

*   **`OPENAI_LANGUAGE`**:
    *   Descripción: Código de idioma para OpenAI (puede afectar STT y TTS).
    *   Default: `en` (controlado por `config.openAIRealtimeAPI.language`).
    *   Ejemplo: `OPENAI_LANGUAGE=es`

*   **`OPENAI_INPUT_AUDIO_FORMAT`**:
    *   Descripción: Formato de audio que se enviará a OpenAI. Ej: `g711_ulaw`, `pcm_s16le_8000hz`, `pcm_s16le_16000hz`.
    *   Default: `mulaw_8000hz` (controlado por `config.openAIRealtimeAPI.inputAudioFormat`).
    *   Ejemplo: `OPENAI_INPUT_AUDIO_FORMAT=pcm_s16le_8000hz`

*   **`OPENAI_INPUT_AUDIO_SAMPLE_RATE`**:
    *   Descripción: Tasa de muestreo del audio enviado a OpenAI (en Hz). Debe coincidir con `OPENAI_INPUT_AUDIO_FORMAT`.
    *   Default: `8000` (controlado por `config.openAIRealtimeAPI.inputAudioSampleRate`).
    *   Ejemplo: `OPENAI_INPUT_AUDIO_SAMPLE_RATE=8000`

*   **`APP_OPENAI_TTS_VOICE`** (o `OPENAI_TTS_VOICE` en `default.json`):
    *   Descripción: La voz a utilizar para la síntesis de Text-to-Speech (TTS) de OpenAI.
    *   Default: `alloy` (controlado por `config.openAIRealtimeAPI.ttsVoice`).
    *   Ejemplo: `APP_OPENAI_TTS_VOICE=nova`

*   **`OPENAI_OUTPUT_AUDIO_FORMAT`**:
    *   Descripción: Formato de audio solicitado a OpenAI para el TTS. Ej: `g711_ulaw`, `pcm_s16le_8000hz`, `pcm_s16le_16000hz`, `pcm_s16le_24000hz`, `mp3`, `opus`.
    *   Default: `g711_ulaw` (controlado por `config.openAIRealtimeAPI.outputAudioFormat`).
    *   Ejemplo: `OPENAI_OUTPUT_AUDIO_FORMAT=pcm_s16le_8000hz` (Recomendado para la nueva lógica de WAV).

*   **`OPENAI_OUTPUT_AUDIO_SAMPLE_RATE`**:
    *   Descripción: Tasa de muestreo del audio TTS solicitado a OpenAI (en Hz). **Importante que coincida con `OPENAI_OUTPUT_AUDIO_FORMAT` si es PCM, para la correcta generación del encabezado WAV.**
    *   Default: `8000` (si `outputAudioFormat` es uLaw) o `24000` (fallback en `ari-client.ts` si no, pero el `default.json` puede tener otro valor). Idealmente, si se usa PCM, este valor debe ser explícitamente la tasa del PCM (ej. 8000 o 16000).
    *   Ejemplo: `OPENAI_OUTPUT_AUDIO_SAMPLE_RATE=8000`

*   **`ACTIVE_AGENT_CONFIG_KEY`**:
    *   Descripción: La clave que identifica qué configuración de agente (escenario) se cargará desde `config/agentConfigs/index.ts`. Las instrucciones y herramientas para el modelo de IA provendrán de esta configuración.
    *   Default: `chatSupervisor` (definido en `config/agentConfigs/index.ts` como `defaultAgentSetKey`).
    *   Ejemplo: `ACTIVE_AGENT_CONFIG_KEY=customerServiceRetail`

*   **~~`APP_OPENAI_INSTRUCTIONS`~~** / **~~`OPENAI_INSTRUCTIONS`~~**:
    *   Descripción: Esta variable ha sido **eliminada**. Las instrucciones para el modelo de IA ahora se cargan desde el escenario del agente seleccionado mediante `ACTIVE_AGENT_CONFIG_KEY`.

*   **`APP_OPENAI_RESPONSE_MODALITIES`** (o `OPENAI_RESPONSE_MODALITIES` en `default.json`):
    *   Descripción: Modalidades de respuesta solicitadas a OpenAI, separadas por coma. Ej: `audio,text`.
    *   Default: `audio,text` (controlado por `config.openAIRealtimeAPI.responseModalities`).
    *   Ejemplo: `APP_OPENAI_RESPONSE_MODALITIES=audio`

### Variables de Entorno para Redis (Opcional):

*   **`REDIS_HOST`**:
    *   Descripción: Hostname o dirección IP del servidor Redis.
    *   Default: `127.0.0.1`
    *   Ejemplo: `REDIS_HOST=myredisserver.example.com`
*   **`REDIS_PORT`**:
    *   Descripción: Puerto del servidor Redis.
    *   Default: `6379`
    *   Ejemplo: `REDIS_PORT=6380`
*   **`REDIS_PASSWORD`**:
    *   Descripción: Contraseña para la autenticación con el servidor Redis (si está configurada).
    *   Default: `undefined` (sin contraseña)
    *   Ejemplo: `REDIS_PASSWORD=yourredispassword`
*   **`REDIS_CONVERSATION_TTL_SECONDS`**:
    *   Descripción: Tiempo de vida (TTL) en segundos para las conversaciones almacenadas en Redis.
    *   Default: `3600` (1 hora)
    *   Ejemplo: `REDIS_CONVERSATION_TTL_SECONDS=86400` (24 horas)


## Parámetros de Configuración en `config/default.json`

El archivo `config/default.json` contiene una estructura jerárquica para estos parámetros y otros más detallados. Las variables de entorno listadas arriba generalmente sobrescriben los valores correspondientes en este archivo.

### Estructura General de `default.json`:

```json
{
  "appConfig": {
    "appRecognitionConfig": {
      "recognitionActivationMode": "VAD", // "IMMEDIATE", "FIXED_DELAY", "VAD"
      "noSpeechBeginTimeoutSeconds": 3,
      "speechCompleteTimeoutSeconds": 5,
      "vadConfig": {
        "vadSilenceThresholdMs": 250,
        "vadRecognitionActivationMs": 40
      },
      "maxRecognitionDurationSeconds": 30,
      "greetingAudioPath": "sound:hello-world",
      "bargeInDelaySeconds": 0.5, // Para FIXED_DELAY
      "vadRecogActivation": "afterPrompt", // "vadMode", "afterPrompt"
      "vadInitialSilenceDelaySeconds": 0,
      "vadActivationDelaySeconds": 0,
      "vadMaxWaitAfterPromptSeconds": 5,
      "initialOpenAIStreamIdleTimeoutSeconds": 10 // Nuevo timeout potencial
    },
    "dtmfConfig": {
      "dtmfEnabled": true,
      "dtmfInterdigitTimeoutSeconds": 2,
      "dtmfMaxDigits": 16,
      "dtmfTerminatorDigit": "#",
      "dtmfFinalTimeoutSeconds": 3
    },
    "bargeInConfig": { // Puede estar parcialmente obsoleto o integrado en appRecognitionConfig
      "bargeInModeEnabled": true,
      "bargeInDelaySeconds": 0.5,
      "noSpeechBargeInTimeoutSeconds": 5
    }
  },
  "openAIRealtimeAPI": {
    "model": "gpt-4o-mini-realtime-preview-2024-12-17",
    "language": "en",
    "inputAudioFormat": "mulaw_8000hz", // Opciones: g711_ulaw, pcm_s16le_8000hz, etc.
    "inputAudioSampleRate": 8000,
    "ttsVoice": "alloy", // Opciones: alloy, echo, fable, onyx, nova, shimmer
    "outputAudioFormat": "g711_ulaw", // Opciones: g711_ulaw, pcm_s16le_8000hz, pcm_s16le_16000hz, pcm_s16le_24000hz, mp3, opus
    "outputAudioSampleRate": 8000, // Importante para PCM -> WAV. Debe coincidir con la tasa real del audio de OpenAI.
    "responseModalities": ["audio", "text"], // "audio", "text"
    // "instructions" y "tools" se cargan dinámicamente desde la configuración del agente seleccionada por ACTIVE_AGENT_CONFIG_KEY
    // "instructions": "Este valor se sobrescribe.",
    // "tools": [] // Este valor se sobrescribe.
  },
  "logging": {
    "level": "info" // silly, debug, info, warn, error
  },
  "asyncSttConfig": { // Placeholder, actual values are under appRecognitionConfig in default.json
      "asyncSttEnabled": false,
      "asyncSttProvider": "openai_whisper_api",
      "asyncSttOpenaiModel": "whisper-1",
      "asyncSttOpenaiApiKey": "", // Should take from OPENAI_API_KEY if not set
      "asyncSttLanguage": "en",
      "asyncSttAudioFormat": "mulaw",
      "asyncSttAudioSampleRate": 8000
  }
}
```

### Variables de Entorno para Modos de Reconocimiento, VAD y STT Asíncrono:

Estas variables de entorno controlan los nuevos modos de activación del reconocimiento y el comportamiento del VAD local. Sobrescriben los valores en `config.appConfig.appRecognitionConfig`.

*   **`RECOGNITION_ACTIVATION_MODE`**:
    *   Descripción: Define cómo se inicia el reconocimiento de voz.
    *   Valores: `"fixedDelay"`, `"immediate"`, `"vad"`, `"manual"`. (Nota: "manual" no está completamente implementado en la lógica actual pero es una opción teórica).
    *   Default (en `default.json`): `"fixedDelay"` (El código en `ari-client.ts` usa `"fixedDelay"` como fallback si la config no lo especifica, pero `.env.example` ahora sugiere `"vad"`).
    *   Ejemplo: `RECOGNITION_ACTIVATION_MODE="vad"`

*   **`BARGE_IN_DELAY_SECONDS`**:
    *   Descripción: Para `RECOGNITION_ACTIVATION_MODE="fixedDelay"`. Retardo en segundos antes de activar el reconocimiento, permitiendo al llamante interrumpir el saludo.
    *   Default (en `default.json`): `0.2`
    *   Ejemplo: `BARGE_IN_DELAY_SECONDS=0.5`

*   **`SPEECH_END_SILENCE_TIMEOUT_SECONDS`**:
    *   Descripción: Tiempo máximo en segundos que la aplicación espera por una transcripción final de OpenAI después de cada turno de habla.
    *   Default (en `default.json`): `1.5`
    *   Ejemplo: `SPEECH_END_SILENCE_TIMEOUT_SECONDS=2.0`

*   **`APP_APPRECOGNITION_VADSILENCETHRESHOLDMS`**:
    *   Descripción: Para modo VAD. Umbral de silencio de Asterisk TALK_DETECT en milisegundos. Tiempo de silencio después del habla para disparar `ChannelTalkingFinished`.
    *   Default (en `default.json`): `2500`
    *   Ejemplo: `APP_APPRECOGNITION_VADSILENCETHRESHOLDMS=3000`

*   **`APP_APPRECOGNITION_VADTALKTHRESHOLD`**:
    *   Descripción: Para modo VAD. Umbral de nivel de energía de Asterisk TALK_DETECT por encima del cual el audio se considera habla, disparando `ChannelTalkingStarted`.
    *   Default (en `default.json`): `256`
    *   Ejemplo: `APP_APPRECOGNITION_VADTALKTHRESHOLD=300`

*   **`APP_APPRECOGNITION_VADRECOGACTIVATION`**:
    *   Descripción: Para modo VAD. Define cuándo se activa el reconocimiento basado en VAD.
    *   Valores: `"vadMode"`, `"afterPrompt"`.
    *   Default (en `default.json`): `"vadMode"`
    *   Ejemplo: `APP_APPRECOGNITION_VADRECOGACTIVATION="afterPrompt"`

*   **`APP_APPRECOGNITION_VADMAXWAITAFTERPROMPTSECONDS`**:
    *   Descripción: Para modo VAD. Tiempo máximo (segundos) a esperar por el habla después de que el saludo termine y después de que `vadInitialSilenceDelaySeconds` hayan pasado (si aplica).
    *   Default (en `default.json`): `10.0`
    *   Ejemplo: `APP_APPRECOGNITION_VADMAXWAITAFTERPROMPTSECONDS=7.5`

*   **`APP_APPRECOGNITION_VADINITIALSILENCEDELAYSECONDS`**:
    *   Descripción: Para modo VAD con `vadRecogActivation="vadMode"`. Retardo en segundos desde el inicio de la llamada antes de que el proceso VAD escuche activamente. El audio se almacena en búfer durante este retardo.
    *   Default (en `default.json`): `0.0`
    *   Ejemplo: `APP_APPRECOGNITION_VADINITIALSILENCEDELAYSECONDS=1.0`

### Variables de Entorno para DTMF:

Estas variables controlan la funcionalidad DTMF. Sobrescriben los valores en `config.appConfig.dtmfConfig`.

*   **`DTMF_ENABLED`**:
    *   Descripción: Habilita (`true`) o deshabilita (`false`) el reconocimiento DTMF.
    *   Default (en `default.json`, como `enableDtmfRecognition`): `true`
    *   Ejemplo: `DTMF_ENABLED=false`

*   **`DTMF_INTERDIGIT_TIMEOUT_SECONDS`**:
    *   Descripción: Tiempo máximo en segundos entre dígitos DTMF antes de considerar la entrada completa.
    *   Default (en `default.json`): `3.0`
    *   Ejemplo: `DTMF_INTERDIGIT_TIMEOUT_SECONDS=2.5`

*   **`DTMF_FINAL_TIMEOUT_SECONDS`**:
    *   Descripción: Tiempo máximo en segundos después del último dígito DTMF para finalizar la entrada.
    *   Default (en `default.json`): `5.0`
    *   Ejemplo: `DTMF_FINAL_TIMEOUT_SECONDS=4.0`

### Variables de Entorno para Transcripción Asíncrona (Async STT):

Estas variables controlan el comportamiento del servicio de transcripción de respaldo si OpenAI no proporciona una transcripción. Se configuran en `config.appConfig.appRecognitionConfig` y pueden ser sobrescritas por variables de entorno.

*   **`ASYNC_STT_ENABLED`**:
    *   Descripción: Habilita (`true`) o deshabilita (`false`) la transcripción asíncrona.
    *   Default (en `default.json` bajo `appRecognitionConfig`): `false`
    *   Ejemplo: `ASYNC_STT_ENABLED=true`
*   **`ASYNC_STT_PROVIDER`**:
    *   Descripción: Proveedor del servicio STT asíncrono.
    *   Valores: `"openai_whisper_api"`, (futuro: `"google_speech_v1"`)
    *   Default (en `default.json`): `"openai_whisper_api"`
    *   Ejemplo: `ASYNC_STT_PROVIDER="openai_whisper_api"`
*   **`ASYNC_STT_OPENAI_MODEL`**:
    *   Descripción: Modelo a usar si `ASYNC_STT_PROVIDER` es `openai_whisper_api`.
    *   Default (en `default.json`): `"whisper-1"`
    *   Ejemplo: `ASYNC_STT_OPENAI_MODEL="whisper-1"`
*   **`ASYNC_STT_OPENAI_API_KEY`**:
    *   Descripción: Clave API para el proveedor de STT asíncrono (ej. OpenAI). Si está vacía y el proveedor es OpenAI, intentará usar la variable global `OPENAI_API_KEY`.
    *   Default (en `default.json`): `""` (vacío)
    *   Ejemplo: `ASYNC_STT_OPENAI_API_KEY="sk-anotherKeyForWhisper"`
*   **`ASYNC_STT_LANGUAGE`**:
    *   Descripción: Código de idioma opcional como pista para el modelo STT asíncrono (ej. `en`, `es`).
    *   Default (en `default.json`): `"en"`
    *   Ejemplo: `ASYNC_STT_LANGUAGE="es"`
*   **`ASYNC_STT_AUDIO_FORMAT`**:
    *   Descripción: Formato del audio que se pasa al transcriptor asíncrono (actualmente `mulaw` es el formato del buffer interno).
    *   Default (en `default.json`): `"mulaw"`
    *   Ejemplo: `ASYNC_STT_AUDIO_FORMAT="mulaw"` (Nota: el transcriptor podría necesitar convertirlo a WAV para APIs como Whisper).
*   **`ASYNC_STT_AUDIO_SAMPLE_RATE`**:
    *   Descripción: Tasa de muestreo del audio para el STT asíncrono.
    *   Default (en `default.json`): `8000`
    *   Ejemplo: `ASYNC_STT_AUDIO_SAMPLE_RATE=8000`
*   **`ASYNC_STT_GOOGLE_LANGUAGE_CODE`**:
    *   Descripción: Código de idioma para Google Cloud Speech-to-Text (ej. `en-US`, `es-ES`).
    *   Default (en `ari-client.ts` si no está seteado): `"es-ES"`
    *   Ejemplo: `ASYNC_STT_GOOGLE_LANGUAGE_CODE="en-US"`
*   **`ASYNC_STT_GOOGLE_CREDENTIALS`**:
    *   Descripción: (Opcional) Ruta al archivo JSON de credenciales de Google Cloud. Si no se establece, se utilizarán las Credenciales Predeterminadas de la Aplicación (ADC), por ejemplo, si la variable de entorno `GOOGLE_APPLICATION_CREDENTIALS` está configurada globalmente.
    *   Default: `undefined` (vacío)
    *   Ejemplo: `ASYNC_STT_GOOGLE_CREDENTIALS="/path/to/your/google-credentials.json"`

*   **`INITIAL_USER_PROMPT`**:
    *   Descripción: (Opcional) Un mensaje sintético inicial del "usuario" para hacer que el asistente hable primero al inicio de la llamada. Si se establece, este texto se enviará al modelo de OpenAI como el primer turno del usuario.
    *   Default: `undefined` (vacío)
    *   Ejemplo: `INITIAL_USER_PROMPT="Hola"` o `INITIAL_USER_PROMPT="Comenzar la conversación."`

### Parámetros Notables en `default.json` (Actualizado):

La estructura de `default.json` se ha actualizado para reflejar estas nuevas variables (dentro de `appRecognitionConfig`):

```json
{
  "appConfig": {
    "appRecognitionConfig": {
      "recognitionActivationMode": "fixedDelay", // "fixedDelay", "Immediate", "vad"
      "bargeInDelaySeconds": 0.2,
      "noSpeechBeginTimeoutSeconds": 5.0,
      "speechEndSilenceTimeoutSeconds": 1.5, // Nuevo, reemplaza speechCompleteTimeoutSeconds
      "maxRecognitionDurationSeconds": 30.0,
      "vadSilenceThresholdMs": 2500,         // Corresponde a APP_APPRECOGNITION_VADSILENCETHRESHOLDMS
      "vadTalkThreshold": 256,             // Corresponde a APP_APPRECOGNITION_VADTALKTHRESHOLD
      "vadRecogActivation": "vadMode",       // "vadMode", "afterPrompt"
      "vadMaxWaitAfterPromptSeconds": 10.0,
      "vadInitialSilenceDelaySeconds": 0.0,
      // vadConfig anidado se mantiene por compatibilidad con la lógica de TALK_DETECT existente,
      // pero sus valores deben ser consistentes con los de nivel superior.
      "vadConfig": {
        "vadSilenceThresholdMs": 2500, // Debería coincidir con vadSilenceThresholdMs arriba
        "vadRecognitionActivationMs": 40 // Umbral de duración de habla para TALK_DETECT, no directamente el de energía.
                                         // Este valor podría necesitar una variable de entorno dedicada si se quiere configurar.
      },
      "initialOpenAIStreamIdleTimeoutSeconds": 10, // Tiempo de espera si el stream de OpenAI está inactivo al inicio.
      "asyncSttEnabled": false,
      "asyncSttProvider": "openai_whisper_api",
      "asyncSttOpenaiModel": "whisper-1",
      "asyncSttOpenaiApiKey": "",
      "asyncSttLanguage": "en",
      "asyncSttAudioFormat": "mulaw",
      "asyncSttAudioSampleRate": 8000
    },
    "dtmfConfig": {
      "enableDtmfRecognition": true, // Corresponde a DTMF_ENABLED
      "dtmfInterDigitTimeoutSeconds": 3.0,
      "dtmfFinalTimeoutSeconds": 5.0,
      "dtmfMaxDigits": 16, // Heredado, aún relevante
      "dtmfTerminatorDigit": "#" // Heredado, aún relevante
    },
    // bargeInConfig podría estar obsoleto ya que bargeInDelaySeconds está ahora en appRecognitionConfig.
    // Se mantiene por si alguna lógica interna aún lo referencia.
    "bargeInConfig": {
      "bargeInModeEnabled": true
    }
  },
  "openAIRealtimeAPI": {
    // ... sin cambios significativos aquí respecto a la funcionalidad principal ...
    "model": "gpt-4o-mini-realtime-preview-2024-12-17",
    "language": "en",
    "inputAudioFormat": "g711_ulaw",
    "inputAudioSampleRate": 8000,
    "ttsVoice": "alloy",
    "outputAudioFormat": "g711_ulaw",
    "outputAudioSampleRate": 8000,
    "responseModalities": ["audio", "text"],
    "instructions": "Eres un asistente de IA amigable y servicial. Responde de manera concisa.",
    "tools": []
  },
  "logging": {
    "level": "info"
  }
}
```

Es importante consultar `ari-client.ts` (específicamente la función `getCallSpecificConfig`) para ver exactamente cómo se leen y priorizan estas configuraciones desde el archivo JSON y las variables de entorno.
