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

*   **`APP_OPENAI_INSTRUCTIONS`** (o `OPENAI_INSTRUCTIONS` en `default.json`):
    *   Descripción: El "system prompt" o instrucciones base para el modelo de IA.
    *   Default: `"Eres un asistente de IA amigable y servicial. Responde de manera concisa."` (controlado por `config.openAIRealtimeAPI.instructions`).
    *   Ejemplo: `APP_OPENAI_INSTRUCTIONS="Actúa como un experto en vinos y recomienda maridajes."`

*   **`APP_OPENAI_RESPONSE_MODALITIES`** (o `OPENAI_RESPONSE_MODALITIES` en `default.json`):
    *   Descripción: Modalidades de respuesta solicitadas a OpenAI, separadas por coma. Ej: `audio,text`.
    *   Default: `audio,text` (controlado por `config.openAIRealtimeAPI.responseModalities`).
    *   Ejemplo: `APP_OPENAI_RESPONSE_MODALITIES=audio`

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
    "instructions": "Eres un asistente de IA amigable y servicial. Responde de manera concisa.",
    "tools": [] // Array de esquemas de herramientas/funciones si se usan
  },
  "logging": {
    "level": "info" // silly, debug, info, warn, error
  }
}
```

### Parámetros Notables en `default.json`:

*   **`appConfig.appRecognitionConfig`**:
    *   `recognitionActivationMode`: Cómo se activa el reconocimiento.
        *   `IMMEDIATE`: Inicia el stream a OpenAI inmediatamente al contestar.
        *   `FIXED_DELAY`: Espera un retardo fijo (`bargeInDelaySeconds`) después del saludo (o inmediatamente si no hay saludo) antes de activar el stream.
        *   `VAD`: Utiliza Voice Activity Detection.
    *   `vadConfig`: Parámetros para VAD (umbrales de silencio y habla).
    *   `vadRecogActivation`: Para modo VAD, si la activación es `vadMode` (basada en delays y detección de habla directa) o `afterPrompt` (espera habla después de que el saludo termine).
    *   `initialOpenAIStreamIdleTimeoutSeconds`: Cuánto tiempo esperar por el primer audio o evento de OpenAI una vez que el stream está activo, antes de considerar un timeout.

*   **`appConfig.dtmfConfig`**:
    *   `dtmfEnabled`: Habilita o deshabilita la detección DTMF.
    *   `dtmfInterdigitTimeoutSeconds`, `dtmfMaxDigits`, `dtmfTerminatorDigit`, `dtmfFinalTimeoutSeconds`: Parámetros para la recolección de DTMF.

*   **`openAIRealtimeAPI.tools`**:
    *   Un array que puede contener las definiciones de "herramientas" (funciones) que el modelo de IA puede solicitar ejecutar. Cada herramienta se define con un esquema.

Es importante consultar `ari-client.ts` (específicamente la función `getCallSpecificConfig`) para ver exactamente cómo se leen y priorizan estas configuraciones desde el archivo JSON y las variables de entorno.

Ahora actualizaré el `README.md`.
