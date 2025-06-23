# WebApp para Monitoreo y Configuración de Llamadas

Esta aplicación de frontend (Next.js) sirve como interfaz para monitorear y configurar las llamadas telefónicas gestionadas por el `websocket-server`.

## Características Principales

1.  **Visualización del Estado del Servidor:**
    *   Indica si la `webapp` está conectada al `websocket-server` (a través del endpoint `/logs`).
    *   Muestra el estado de la llamada ARI actualmente seleccionada (o primaria).

2.  **Selección de Llamadas Activas:**
    *   Si hay llamadas activas en el `websocket-server`, se muestra un menú desplegable que permite seleccionar una llamada específica para monitoreo y configuración.
    *   La información mostrada en `TopBar` y `ServerStatusIndicator` se actualiza para reflejar la llamada seleccionada.

3.  **Configuración de Sesión por Llamada:**
    *   Una vez seleccionada una llamada, el panel "Session Configuration" permite modificar diversos parámetros para *esa llamada específica*.
    *   **Parámetros Configurables:**
        *   **Instructions (Prompt del Sistema):** Las instrucciones que guían el comportamiento del modelo de IA.
        *   **Voice (TTS):** La voz utilizada para la síntesis de Text-to-Speech de OpenAI.
        *   **OpenAI Model:** El modelo de OpenAI a utilizar para la conversación.
        *   **Tools (Herramientas/Funciones):** Permite definir o seleccionar esquemas de funciones que la IA puede invocar.
        *   **Recognition Activation Mode:** Controla cómo y cuándo se inicia el reconocimiento de voz para el turno del llamante.
            *   `Fixed Delay`: Inicia el envío de audio a OpenAI después de un retardo fijo (`Barge-In Delay`).
            *   `Immediate`: Envía audio a OpenAI inmediatamente.
            *   `VAD (Voice Activity Detection)`: Utiliza VAD local (Asterisk `TALK_DETECT`) para iniciar el envío a OpenAI.
                *   `VAD Recognition Activation`: Define si el VAD local se activa basado en un retardo de silencio inicial (`vadMode`) o después de que un prompt termine (`afterPrompt`).
                *   Timers asociados como `VAD Initial Silence Delay`, `VAD Max Wait After Prompt`, `VAD Silence Threshold`, `VAD Talk Threshold`.
        *   **Speech Timers (OpenAI):** Timers que gobiernan la interacción una vez que el stream a OpenAI está activo (`No Speech Begin Timeout`, `Speech End Silence Timeout`, `Max Recognition Duration`).
        *   **DTMF Configuration:**
            *   Habilitar/Deshabilitar el reconocimiento DTMF.
            *   Timers asociados como `DTMF Inter-Digit Timeout`, `DTMF Final Timeout`.
    *   Al guardar, la configuración se envía al `websocket-server` para la `callId` seleccionada.
    *   El panel carga la configuración actual de la llamada seleccionada cuando esta se elige en el desplegable.

4.  **Visualización de Transcripciones:**
    *   Muestra la transcripción de la conversación para la llamada actualmente seleccionada.
    *   Cuando se selecciona una nueva llamada, se solicita y muestra su historial de conversación completo (almacenado en Redis por el backend).
    *   Los eventos de transcripción en tiempo real del backend se añaden a la vista. (Nota: Actualmente, los eventos en tiempo real pueden actualizar la transcripción independientemente de la llamada seleccionada si el backend los envía globalmente. Un refinamiento futuro podría ser que el backend también etiquete estos eventos con `callId` para un filtrado más preciso en el frontend.)

5.  **Panel de Llamadas a Funciones:**
    *   Muestra información sobre las herramientas/funciones que la IA ha intentado invocar y las respuestas.

## Configuración del Entorno (Frontend)

Asegúrate de tener un archivo `.env.local` (o `.env`) en el directorio raíz de `webapp/` con la siguiente variable:

```
NEXT_PUBLIC_WEBSOCKET_SERVER_BASE_URL=ws://localhost:8081
```

Reemplaza `ws://localhost:8081` con la URL base real donde tu `websocket-server` está escuchando (por ejemplo, `http://your-backend-domain.com` o `ws://your-backend-domain.com/ws` si el servidor WebSocket está en una subruta, aunque el código actual espera una URL base para `/logs`). Si usas `https`, el esquema debería ser `wss://`.

## Ejecución

Desde el directorio `webapp/`:

1.  Instalar dependencias: `npm install`
2.  Ejecutar en modo desarrollo: `npm run dev`
3.  Abrir [http://localhost:3000](http://localhost:3000) (o el puerto que indique Next.js) en el navegador.

Para construir para producción: `npm run build`.
Para iniciar en producción: `npm start`.
