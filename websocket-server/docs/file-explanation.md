# Explicación de Archivos del `websocket-server`

Este documento detalla el propósito y la funcionalidad de cada archivo principal dentro del directorio `websocket-server`.

## Directorio Raíz (`websocket-server/`)

*   **`package.json`**: Define los metadatos del proyecto, dependencias (como `ari-client`, `ws`, `express`, `dotenv`), y scripts (como `start`, `build`, `dev`).
*   **`package-lock.json`**: Registra las versiones exactas de las dependencias instaladas, asegurando compilaciones consistentes.
*   **`tsconfig.json`**: Archivo de configuración para el compilador de TypeScript. Especifica opciones como el directorio de salida (`dist`), el módulo de destino (CommonJS), y las rutas base.
*   **`.env.example`**: Archivo de ejemplo para variables de entorno. Los usuarios deben copiarlo a `.env` y rellenar los valores necesarios (claves API, URLs de Asterisk, etc.).
*   **`.gitignore`**: Especifica los archivos y directorios que Git debe ignorar (ej. `node_modules`, `dist`, `.env`).
*   **`README.md`**: Documentación principal del proyecto, incluyendo instrucciones de instalación, configuración y ejecución. (Este archivo será actualizado).
*   **`TESTING.md`**: (Si existe) Documento con instrucciones o notas sobre cómo probar la aplicación.

## Directorio de Configuración (`websocket-server/config/`)

*   **`default.json`**: Archivo de configuración base en formato JSON. Contiene parámetros por defecto para la aplicación, como la configuración de logging, los parámetros de la API de OpenAI (modelo, formatos de audio, prompt inicial), configuración de VAD, DTMF, etc. Estos valores pueden ser sobrescritos por variables de entorno.

## Directorio de Documentación (`websocket-server/docs/`)

*   **`architecture.md`**: (Actualizado) Describe la arquitectura general del sistema, los componentes principales, el flujo de una llamada, y un diagrama de secuencia.
*   **`file-explanation.md`**: (Este archivo) Explica el propósito de cada archivo en el proyecto.
*   **`variables.md`**: (A crear) Detallará todas las variables de entorno y de configuración importantes.

## Directorio de Código Fuente (`websocket-server/src/`)

*   **`server.ts`**:
    *   **Propósito**: Punto de entrada principal de la aplicación y servidor WebSocket/HTTP.
    *   **Funcionalidad**:
        *   Inicializa `dotenv` para cargar variables de entorno.
        *   Crea un servidor HTTP `express` y un servidor WebSocket (`ws`) sobre él.
        *   Maneja las conexiones WebSocket entrantes desde el frontend (`webapp`):
            *   Ruta `/logs`: Establece una conexión para enviar logs y eventos del sistema al frontend.
            *   Recibe mensajes del frontend, como actualizaciones de configuración para la llamada activa (ej. `session.update` para cambiar el prompt de IA, la voz TTS).
        *   Expone un endpoint HTTP (ej. `/public-url`, `/tools`) para proveer información adicional.
        *   Llama a `initializeAriClient()` para conectar con Asterisk e iniciar la lógica de manejo de llamadas.
        *   Inicia el servidor para escuchar en el puerto y host configurados.

*   **`ari-client.ts`**:
    *   **Propósito**: Gestionar la comunicación con Asterisk mediante la Asterisk REST Interface (ARI) y orquestar el flujo de la llamada.
    *   **Funcionalidad**:
        *   `AriClientService` clase:
            *   Se conecta a ARI y se suscribe a la aplicación Stasis.
            *   `onStasisStart`: Maneja nuevas llamadas entrantes. Configura los canales, puentes (bridges) de Asterisk, inicia el `RtpServer`, y el `snoopChannel` para capturar el audio del llamante.
            *   Reproduce saludos iniciales.
            *   Interactúa con `sessionManager.ts` para iniciar y detener sesiones de OpenAI.
            *   Recibe callbacks del `sessionManager` con eventos de OpenAI (transcripciones, audio TTS).
            *   `_onOpenAIAudioChunk`, `_onOpenAIAudioStreamEnd`: Acumula fragmentos de audio TTS de OpenAI. Al finalizar el stream de audio, si el formato es PCM, lo envuelve en un **encabezado WAV** y lo guarda como archivo `.wav`. Si es uLaw, lo guarda como `.ulaw`. Luego instruye a Asterisk para reproducir este archivo.
            *   Maneja eventos DTMF (`_onDtmfReceived`).
            *   Maneja eventos de inicio/fin de habla del canal (`_onChannelTalkingStarted`, `_onChannelTalkingFinished`) para la lógica de VAD.
            *   `updateActiveCallConfig`: Actualiza la configuración de una llamada activa (prompt, voz TTS) basado en solicitudes del `server.ts` (originadas por la `webapp`).
            *   `_fullCleanup`: Limpia todos los recursos de Asterisk (canales, puentes) y detiene servicios asociados (RTP server, sesión OpenAI) al finalizar la llamada o en caso de error.
        *   `initializeAriClient`: Función para crear e inicializar la instancia de `AriClientService`.
        *   `createWavHeader`: Función de utilidad para generar encabezados de archivo WAV para datos PCM.
        *   Carga la configuración (`baseConfig`, `currentCallSpecificConfig`) desde `default.json` y variables de entorno.

*   **`rtp-server.ts`**:
    *   **Propósito**: Escuchar paquetes RTP de Asterisk y extraer el payload de audio.
    *   **Funcionalidad**:
        *   `RtpServer` clase:
            *   Crea un socket UDP (`dgram`).
            *   Se enlaza a un host y puerto (generalmente `127.0.0.1` y un puerto efímero).
            *   Al recibir un mensaje UDP, si es un paquete RTP válido, extrae el payload de audio (asumiendo que la cabecera RTP tiene 12 bytes).
            *   Emite un evento `audioPacket` con el buffer de audio crudo.
            *   Maneja eventos de error, escucha y cierre del socket.

*   **`sessionManager.ts`**:
    *   **Propósito**: Abstraer la comunicación con la API Realtime de OpenAI (u otro servicio de IA similar).
    *   **Funcionalidad**:
        *   `startOpenAISession`: Establece una conexión WebSocket con la URL de la API Realtime de OpenAI. Envía la configuración inicial de la sesión (formato de audio de entrada/salida, voz, instrucciones).
        *   Maneja los eventos del ciclo de vida del WebSocket de OpenAI (`open`, `message`, `error`, `close`).
        *   Al recibir mensajes de OpenAI:
            *   Parsea el JSON.
            *   Identifica el tipo de evento (ej. `session.created`, `response.text.delta`, `response.audio.delta`, `response.done`, `error`).
            *   Invoca los callbacks correspondientes en la instancia de `AriClientService` (ej. `_onOpenAIInterimResult`, `_onOpenAIAudioChunk`, `_onOpenAIError`).
        *   `sendAudioToOpenAI`: Recibe un buffer de audio, lo codifica a base64 (si es necesario por la API) y lo envía a OpenAI como un evento `input_audio_buffer.append`.
        *   `requestOpenAIResponse`: Envía la transcripción final del usuario a OpenAI y solicita una respuesta (que puede incluir audio y texto).
        *   `stopOpenAISession`: Cierra la conexión WebSocket con OpenAI.
        *   `sendSessionUpdateToOpenAI`: Envía una actualización de configuración (ej. cambio de prompt o voz TTS) a una sesión de OpenAI activa.
        *   Mantiene un mapa de sesiones activas (`activeOpenAISessions`).

*   **`functionHandlers.ts`**:
    *   **Propósito**: Definir las "herramientas" (tools) que la IA podría invocar si el modelo de OpenAI está configurado para usar `tool_calls`.
    *   **Funcionalidad**:
        *   Exporta un array de objetos, donde cada objeto describe el esquema de una función (nombre, descripción, parámetros).
        *   (Actualmente, la implementación de la ejecución de estas funciones y el envío de resultados de vuelta a OpenAI no parece ser el foco principal, pero los esquemas están definidos).

*   **`types.ts`**:
    *   **Propósito**: Definir tipos e interfaces de TypeScript utilizados en toda la aplicación.
    *   **Funcionalidad**:
        *   Contiene definiciones para estructuras de configuración (ej. `RuntimeConfig`, `CallSpecificConfig`, `OpenAIRealtimeAPIConfig`, `AppRecognitionConfig`), estados de llamada, interfaces para servicios (ej. `AriClientInterface`, `LoggerInstance`), y tipos para eventos o datos específicos.
        *   Ayuda a mantener la consistencia y provee chequeo de tipos estático.

Este desglose debería ayudar a entender el rol de cada archivo en el sistema `websocket-server`.
Ahora crearé el documento de variables: `websocket-server/docs/variables.md`.
