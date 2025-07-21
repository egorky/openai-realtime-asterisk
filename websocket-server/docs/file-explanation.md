# Explicación de Archivos del `websocket-server`

Este documento detalla el propósito y la funcionalidad de cada archivo principal dentro del directorio `websocket-server`.

## Directorio Raíz (`websocket-server/`)

*   **`package.json`**: Define los metadatos del proyecto, dependencias (como `ari-client`, `ws`, `express`, `dotenv`), y scripts (como `start`, `build`, `dev`).
*   **`package-lock.json`**: Registra las versiones exactas de las dependencias instaladas, asegurando compilaciones consistentes.
*   **`tsconfig.json`**: Archivo de configuración para el compilador de TypeScript. Especifica opciones como el directorio de salida (`dist`), el módulo de destino (CommonJS), y las rutas base.
*   **`.env.example`**: Archivo de ejemplo para variables de entorno. Los usuarios deben copiarlo a `.env` y rellenar los valores necesarios. (Actualizado para reflejar todas las variables).
*   **`.gitignore`**: Especifica los archivos y directorios que Git debe ignorar (ej. `node_modules`, `dist`, `.env`).
*   **`README.md`**: Documentación principal del proyecto, incluyendo instrucciones de instalación, configuración y ejecución. (Actualizado para reflejar nuevas variables y funcionalidades).
*   **`TESTING.md`**: (Si existe) Documento con instrucciones o notas sobre cómo probar la aplicación.

## Directorio de Configuración (`websocket-server/config/`)

*   **`default.json`**: Archivo de configuración base en formato JSON. Contiene parámetros por defecto para la aplicación, como la configuración de logging, los parámetros de la API de OpenAI (modelo, formatos de audio), configuración de VAD, DTMF, etc. Estos valores pueden ser sobrescritos por variables de entorno. (Actualizado para incluir `voskServerUrl`).
*   **`agentConfigs/`**: Directorio que contiene las configuraciones específicas de los agentes de IA, incluyendo sus prompts de sistema (instrucciones) y las herramientas que pueden utilizar.
    *   **`index.ts`**: Exporta las diferentes configuraciones de agentes disponibles.
    *   **`types.ts`**: Define los tipos para las configuraciones de los agentes.
    *   Archivos individuales por agente (ej. `chatSupervisor.ts`, `customerServiceRetail.ts`): Definen el comportamiento específico de cada agente.

## Directorio de Documentación (`websocket-server/docs/`)

*   **`architecture.md`**: Describe la arquitectura general del sistema, los componentes principales, el flujo de una llamada, y un diagrama de secuencia.
*   **`file-explanation.md`**: (Este archivo) Explica el propósito de cada archivo en el proyecto. (Actualizado).
*   **`variables.md`**: Detalla todas las variables de entorno y de configuración importantes. (Actualizado).
*   **`configuring-new-agents.md`**: Guía sobre cómo definir y configurar nuevos agentes de IA.

## Directorio de Código Fuente (`websocket-server/src/`)

*   **`server.ts`**:
    *   **Propósito**: Punto de entrada principal de la aplicación. Configura y arranca el servidor HTTP Express y el servidor WebSocket (`ws`).
    *   **Funciones Clave**:
        *   `initializeExpressApp()`: Configura la aplicación Express con middleware básico.
        *   `initializeWebSocketServer()`: Crea el servidor WebSocket sobre el servidor HTTP.
        *   Maneja conexiones WebSocket entrantes en la ruta `/logs` desde el frontend (`webapp`) para enviar logs y eventos del sistema en tiempo real.
        *   Recibe mensajes del frontend para actualizaciones de configuración de llamadas activas (ej. `session.update` para cambiar el prompt de IA, la voz TTS) y los reenvía a `AriClientService`.
        *   Llama a `initializeAriClient()` para conectar con Asterisk e iniciar la lógica de manejo de llamadas.
        *   Inicia el servidor HTTP para escuchar en el puerto y host configurados.
        *   `sendGenericEventToFrontend()`: Función de utilidad para enviar eventos al frontend.

*   **`ari-client.ts`**:
    *   **Propósito**: Núcleo de la aplicación. Gestiona la comunicación con Asterisk mediante ARI y orquesta el flujo completo de la llamada, incluyendo la interacción con OpenAI y el manejo de media.
    *   **Clase `AriClientService`**:
        *   `connect()`: Establece la conexión con Asterisk ARI y se suscribe a la aplicación Stasis.
        *   `onStasisStart()`: Manejador principal para nuevas llamadas. Realiza la configuración inicial:
            *   Responde la llamada.
            *   Crea puentes (bridges) de Asterisk para el audio.
            *   Inicia `RtpServer` para recibir audio del llamante.
            *   Configura `snoopChannel` para capturar el audio del llamante.
            *   Inicia el canal de media externo para enviar audio a OpenAI.
            *   Maneja la lógica de los modos de activación de reconocimiento (`Immediate`, `fixedDelay`, `vad`) y configura los temporizadores correspondientes (`bargeInActivationTimer`, `vadInitialSilenceDelayTimer`, etc.).
            *   Reproduce saludos iniciales (`greetingAudioPath`).
            *   Inicia la sesión con `sessionManager.startOpenAISession()`.
        *   `_onDtmfReceived()`: Maneja la recepción de dígitos DTMF, interrumpiendo el reconocimiento de voz y gestionando la entrada DTMF.
        *   `_onChannelTalkingStarted()`, `_onChannelTalkingFinished()`: Manejadores para los eventos de VAD de Asterisk (`TALK_DETECT`), utilizados en el modo `vad`.
        *   `_activateOpenAIStreaming()`: Activa el envío de audio a OpenAI y configura temporizadores como `noSpeechBeginTimer` y `initialOpenAIStreamIdleTimer`.
        *   `_onOpenAISpeechStarted()`, `_onOpenAIInterimResult()`, `_onOpenAIFinalResult()`: Callbacks invocados por `sessionManager` ante eventos de transcripción de OpenAI. Gestionan temporizadores de silencio y la lógica de barge-in.
        *   `_onOpenAIAudioChunk()`, `_onOpenAIAudioStreamEnd()`: Callbacks para recibir y procesar los chunks de audio TTS de OpenAI. Acumulan los chunks, los guardan en un archivo (WAV para PCM, uLaw para uLaw) y los reproducen. (Será modificado para el playback por streaming).
        *   `_onOpenAIError()`, `_onOpenAISessionEnded()`: Manejan errores y el cierre de la sesión de OpenAI.
        *   `playbackAudio()`: Reproduce un archivo de audio en el canal del llamante.
        *   `updateActiveCallConfig()`: Actualiza la configuración de una llamada activa (prompt, voz TTS, etc.) basado en solicitudes del frontend.
        *   `_fullCleanup()`, `cleanupCallResources()`: Limpian todos los recursos de Asterisk (canales, puentes) y detienen servicios asociados al finalizar la llamada o en caso de error.
        *   `getCallSpecificConfig()`: Carga y fusiona la configuración desde `default.json` y las variables de entorno para una llamada específica.
        *   `createWavHeader()`: Función de utilidad para generar encabezados de archivo WAV para datos PCM.
        *   Gestión de múltiples llamadas (`activeCalls` Map) y la noción de una `currentPrimaryCallId`.

*   **`rtp-server.ts`**:
    *   **Propósito**: Escuchar paquetes RTP (audio del llamante) enviados por Asterisk.
    *   **Clase `RtpServer`**:
        *   `start()`: Crea un socket UDP (`dgram`) y se enlaza a un host y puerto para recibir RTP.
        *   Al recibir un mensaje UDP, si es un paquete RTP válido, extrae el payload de audio (asumiendo cabecera RTP de 12 bytes).
        *   Emite un evento `audioPacket` con el buffer de audio crudo (generalmente uLaw).
        *   `stop()`: Cierra el socket UDP.

*   **`sessionManager.ts`**:
    *   **Propósito**: Abstraer la comunicación WebSocket con el proveedor de IA (OpenAI o Azure OpenAI).
    *   **Funciones Clave**:
        *   `startOpenAISession()`: Basado en la variable de entorno `AI_PROVIDER`, establece una conexión WebSocket con la API Realtime de OpenAI o Azure OpenAI. Utiliza los SDK `@openai/api` o `@azure/openai` correspondientes.
        *   Maneja los eventos del ciclo de vida del WebSocket (`open`, `message`, `error`, `close`).
        *   Al recibir mensajes del proveedor de IA (`ws.on('message')`):
            *   Parsea el JSON del evento.
            *   Identifica el tipo de evento (`session.created`, `response.delta`, `response.audio.delta`, `response.done`, `tool_calls`, `error`, etc.).
            *   Invoca los callbacks correspondientes en la instancia de `AriClientService`.
            *   Si se reciben `tool_calls`, invoca `executeTool()` del `toolExecutor.ts`.
        *   `sendAudioToOpenAI()`: Envía un buffer de audio (codificado en base64) al proveedor de IA.
        *   `requestOpenAIResponse()`: Envía la transcripción final del usuario al proveedor de IA y solicita una respuesta.
        *   `stopOpenAISession()`: Cierra la conexión WebSocket.
        *   `sendSessionUpdateToOpenAI()`: Envía una actualización de configuración (ej. cambio de prompt, voz TTS, herramientas) a una sesión activa.
        *   Mantiene un mapa de sesiones activas (`activeOpenAISessions`).

*   **`ari-config.ts`**:
    *   **Propósito**: Cargar y gestionar todas las configuraciones de la aplicación desde variables de entorno y el archivo `config/default.json`.
    *   **Funciones Clave**:
        *   `getCallSpecificConfig()`: Crea una configuración específica para cada llamada, fusionando la configuración base con las variables de entorno.
        *   Carga las variables del proveedor de IA (`AI_PROVIDER`) y las credenciales tanto para OpenAI (`OPENAI_API_KEY`) como para Azure OpenAI (`AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT_ID`).
        *   Exporta constantes de configuración utilizadas en toda la aplicación.

*   **`toolExecutor.ts`**:
    *   **Propósito**: Ejecutar las "herramientas" (tools/functions) que la IA puede solicitar.
    *   **Funciones Clave**:
        *   `executeTool()`:
            *   Recibe un objeto `OpenAIToolCall` de `sessionManager.ts`.
            *   Busca el manejador de la herramienta correspondiente en `functionHandlers.ts`.
            *   **Caso Especial `endCall`**: Si la herramienta es `endCall`, invoca `ariClientServiceInstance.endCall(ariCallId)` para terminar la llamada de Asterisk.
            *   Ejecuta la lógica de la herramienta y devuelve un `ToolResultPayload` con el resultado, que `sessionManager.ts` envía de vuelta a la IA.

*   **`functionHandlers.ts`**:
    *   **Propósito**: Definir los esquemas (schemas) y los manejadores de las "herramientas" (tools) que la IA puede invocar.
    *   **Funcionalidad**:
        *   Exporta un array de objetos `FunctionHandler`.
        *   Incluye la definición del schema para la herramienta `endCall`, que permite a la IA finalizar la llamada.
        *   Las implementaciones reales de las herramientas se encuentran en `toolExecutor.ts`.

*   **`redis-client.ts`**:
    *   **Propósito**: Gestionar la conexión con un servidor Redis y proporcionar funciones para registrar el historial de la conversación.
    *   **Funciones Clave**:
        *   Inicializa y gestiona el cliente Redis (`ioredis`).
        *   `logConversationToRedis()`: Guarda un "turno" de la conversación (objeto `ConversationTurn`) en una lista de Redis asociada al `callId`. Establece un TTL para la clave.
        *   `getConversationHistory()`: Recupera el historial de conversación para un `callId` desde Redis.
        *   `isRedisAvailable()`: Verifica si la conexión con Redis está activa.

*   **`toolExecutor.ts`**:
    *   **Propósito**: Ejecutar las "herramientas" (tools/functions) que la IA de OpenAI puede solicitar.
    *   **Funciones Clave**:
        *   `executeTool()`:
            *   Recibe un objeto `OpenAIToolCall` de `sessionManager.ts`.
            *   Busca el manejador de la herramienta correspondiente en `functionHandlers.ts` (o una estructura similar donde se definan las herramientas).
            *   Ejecuta la lógica de la herramienta (actualmente simulada con placeholders).
            *   Devuelve un `ToolResultPayload` con el resultado de la ejecución de la herramienta, que luego `sessionManager.ts` envía de vuelta a OpenAI.

*   **`functionHandlers.ts`**:
    *   **Propósito**: Definir los esquemas (schemas) de las "herramientas" (tools) que la IA podría invocar, siguiendo el formato esperado por OpenAI.
    *   **Funcionalidad**:
        *   Exporta un array de objetos `FunctionDefinition` (o similar), donde cada objeto describe el nombre, descripción y parámetros de una función/herramienta.
        *   Actualmente, las implementaciones reales de estas funciones no están en este archivo, sino que `toolExecutor.ts` las simularía o llamaría a lógica externa.

*   **`types.ts`**:
    *   **Propósito**: Definir tipos e interfaces de TypeScript utilizados en toda la aplicación para asegurar la consistencia y proveer chequeo de tipos estático.
    *   **Funcionalidad**:
        *   Contiene definiciones para:
            *   Estructuras de configuración (ej. `RuntimeConfig`, `CallSpecificConfig`, `OpenAIRealtimeAPIConfig`, `AppRecognitionConfig`, `DtmfConfig`).
            *   Interfaces para servicios (ej. `AriClientInterface`, `LoggerInstance`).
            *   Tipos para datos de la conversación (ej. `ConversationTurn`).
            *   Tipos para herramientas y llamadas a funciones de OpenAI.

Este desglose debería ayudar a entender el rol de cada archivo en el sistema `websocket-server`.
