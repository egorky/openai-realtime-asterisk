import { RawData, WebSocket } from "ws";
import functions from "./functionHandlers";
import { CallSpecificConfig, OpenAIRealtimeAPIConfig, AriClientInterface } from "./types";
import { AriClientService } from "./ari-service"; // Apuntar a la nueva ubicación de la clase
import { executeTool, OpenAIToolCall, ToolResultPayload } from './toolExecutor';
import OpenAI from "openai";
import { OpenAIClient, AzureKeyCredential } from "@azure/openai";


interface OpenAISession {
  ws: WebSocket;
  ariClient: AriClientInterface; // Usar la interfaz aquí
  callId: string;
  config: CallSpecificConfig;
  processingToolCalls?: boolean; // Para rastrear si estamos en un ciclo de herramientas
  functionCallArguments?: string;
}

const activeOpenAISessions = new Map<string, OpenAISession>();

// --- Sección de código legado (marcada para posible refactorización/eliminación) ---
interface LegacyCallSessionData {
  callId: string;
  ariClient: AriClientService; // Implementación concreta para lógica legada
  frontendConn?: WebSocket;
  modelConn?: WebSocket;
  config?: CallSpecificConfig; // Puede ser undefined en el flujo legado
  lastAssistantItemId?: string;
  responseStartTimestamp?: number;
}
const legacyActiveSessions = new Map<string, LegacyCallSessionData>();

function getLegacySession(callId: string, operation: string): LegacyCallSessionData | undefined {
  const session = legacyActiveSessions.get(callId);
  // Silenciado para reducir ruido de logs no críticos para la funcionalidad principal.
  // if (!session) {
  //   console.error(`SessionManager (Legacy): ${operation} failed. No active legacy session for callId ${callId}.`);
  // }
  return session;
}

export function handleCallConnection(callId: string, ariClient: AriClientService) { // ariClient aquí es AriClientService
  if (legacyActiveSessions.has(callId)) {
    // console.warn(`SessionManager (Legacy): Legacy call connection for ${callId} already exists.`);
    const oldSession = legacyActiveSessions.get(callId);
    if (oldSession?.modelConn && isOpen(oldSession.modelConn)) {
      oldSession.modelConn.close();
    }
  }
  const newLegacySessionData: Partial<LegacyCallSessionData> = { callId, ariClient };
  legacyActiveSessions.set(callId, newLegacySessionData as LegacyCallSessionData);
}

let globalFrontendConn: WebSocket | undefined; // Para logs globales o mensajes no específicos de llamada

export function handleFrontendConnection(ws: WebSocket) {
  // Esta conexión es ahora principalmente para que server.ts reciba session.update
  // y para que sessionManager envíe logs globales si es necesario.
  if (isOpen(globalFrontendConn) && globalFrontendConn !== ws) {
    // console.log("SessionManager: Closing previous global frontend WebSocket connection.");
    globalFrontendConn.close();
  }
  globalFrontendConn = ws;
  // console.log("SessionManager: Global frontend WebSocket client connected/updated.");

  ws.on("close", () => {
    if (globalFrontendConn === ws) {
      globalFrontendConn = undefined;
      // console.log("SessionManager: Global frontend WebSocket client disconnected.");
    }
  });
  ws.on("error", (error) => {
    // console.error("SessionManager: Global frontend WebSocket error:", error);
    if (globalFrontendConn === ws) {
      globalFrontendConn = undefined; // Asegurar que se limpie en caso de error también
    }
  });
}
// --- Fin de sección de código legado ---


export function startOpenAISession(callId: string, ariClient: AriClientInterface, config: CallSpecificConfig): void {
  const sessionLogger = ariClient.logger;
  sessionLogger.info(`SessionManager: Request to ensure OpenAI Realtime session is active for callId ${callId}.`);

  const existingSession = activeOpenAISessions.get(callId);
  if (existingSession && isOpen(existingSession.ws)) {
    sessionLogger.info(`SessionManager: OpenAI Realtime session for ${callId} is already active and open. Re-sending session.update if config changed.`);
    existingSession.config = config;
    sendSessionUpdateToOpenAI(callId, config.openAIRealtimeAPI);
    return;
  } else if (existingSession && existingSession.ws) {
    // Store the readyState before the !isOpen check, as existingSession.ws is known to be a WebSocket here.
    const currentState = existingSession.ws.readyState;
    if (!isOpen(existingSession.ws)) {
        sessionLogger.warn(`SessionManager: OpenAI Realtime session for ${callId} exists but WebSocket is not open (state: ${currentState}). Will attempt to create a new one.`);
        activeOpenAISessions.delete(callId);
    } else {
        // This path implies isOpen(existingSession.ws) is true, which should have been caught by the first 'if'.
        // This is anomalous. Log it and treat as if it's open.
        sessionLogger.warn(`SessionManager: Anomaly - session for ${callId} (state: ${currentState}) was not caught by the primary 'isOpen' check but is open now. Proceeding as open.`);
        existingSession.config = config;
        sendSessionUpdateToOpenAI(callId, config.openAIRealtimeAPI);
        return;
    }
  } else if (existingSession && !existingSession.ws) {
    sessionLogger.warn(`SessionManager: OpenAI Realtime session data for ${callId} exists but WebSocket object is missing. Will attempt to create a new one.`);
    activeOpenAISessions.delete(callId);
  }
  else { // No existingSession at all
     sessionLogger.info(`SessionManager: No active OpenAI session found for ${callId}. Creating new session.`);
  }

  let ws;
  const realtimeConfig = config.openAIRealtimeAPI;
  const model = realtimeConfig?.model || "gpt-4o-mini-realtime-preview-2024-12-17";

  if (config.aiProvider === 'azure') {
    if (!config.azureOpenAI?.endpoint || !config.azureOpenAI?.apiKey || !config.azureOpenAI?.deploymentId) {
      sessionLogger.error(`SessionManager: CRITICAL - Azure config not found. Cannot start Realtime session for ${callId}.`);
      ariClient._onOpenAIError(callId, new Error("Azure OpenAI config not configured on server."));
      return;
    }
    const client = new OpenAIClient(config.azureOpenAI.endpoint, new AzureKeyCredential(config.azureOpenAI.apiKey));
    const { socket } = client.getRealtimeClient(config.azureOpenAI.deploymentId);
    ws = socket;
    sessionLogger.info(`[${callId}] Connecting to Azure OpenAI Realtime WebSocket...`);
  } else {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      sessionLogger.error(`SessionManager: CRITICAL - OPENAI_API_KEY not found. Cannot start Realtime session for ${callId}.`);
      ariClient._onOpenAIError(callId, new Error("OPENAI_API_KEY not configured on server."));
      return;
    }

    const openai = new OpenAI({ apiKey });
    const { socket } = openai.realtime.connect({ model });
    ws = socket;
    sessionLogger.info(`[${callId}] Connecting to OpenAI Realtime WebSocket...`);
  }
  const newOpenAISession: OpenAISession = { ws, ariClient, callId, config };
  activeOpenAISessions.set(callId, newOpenAISession);

  ws.on('open', () => {
    sessionLogger.info(`SessionManager: OpenAI Realtime WebSocket connection established for callId ${callId}.`);
    const currentRealtimeConfig = newOpenAISession.config.openAIRealtimeAPI;
    const sessionUpdateEvent = {
      type: "session.update",
      session: {
        input_audio_format: currentRealtimeConfig?.inputAudioFormat || "g711_ulaw",
        output_audio_format: currentRealtimeConfig?.outputAudioFormat || "g711_ulaw",
        voice: currentRealtimeConfig?.ttsVoice || 'alloy',
        instructions: currentRealtimeConfig?.instructions,
      }
    };
    if (ws.readyState === WebSocket.OPEN) {
      try {
        const eventString = JSON.stringify(sessionUpdateEvent);
        ws.send(eventString);
        // Check if sessionLogger has isLevelEnabled (i.e., it's our custom logger)
        if (typeof (sessionLogger as any).isLevelEnabled === 'function' && (sessionLogger as any).isLevelEnabled('debug')) {
          sessionLogger.debug(`[${callId}] OpenAI Realtime: Sent initial session.update: ${eventString}`);
        } else {
          sessionLogger.info(`[${callId}] OpenAI Realtime: Sent initial session.update event (details in debug log if enabled). Event: ${JSON.stringify(sessionUpdateEvent.session)}`);
        }
        (ariClient as AriClientService).sendEventToFrontend({
          type: 'openai_session_established',
          callId: callId,
          timestamp: new Date().toISOString(),
          source: 'SESSION_MANAGER',
          payload: { initialConfig: sessionUpdateEvent.session },
          logLevel: 'INFO'
        });

        // Send initial user prompt if configured
        const initialUserPrompt = process.env.INITIAL_USER_PROMPT;
        if (initialUserPrompt && initialUserPrompt.trim() !== "") {
          sessionLogger.info(`[${callId}] OpenAI Realtime: Sending initial user prompt: "${initialUserPrompt}"`);
          // Use a brief timeout to ensure session.update is processed before the prompt
          setTimeout(() => {
            if (isOpen(ws)) {
              requestOpenAIResponse(callId, initialUserPrompt, newOpenAISession.config);
            } else {
              sessionLogger.warn(`[${callId}] OpenAI Realtime: WebSocket closed before initial user prompt could be sent.`);
            }
          }, 100); // 100ms delay, adjust if needed
        }
      } catch (e: any) {
        sessionLogger.error(`[${callId}] OpenAI Realtime: Failed to send initial session.update or initial prompt: ${e.message}`);
      }
    }
  });

  ws.on('message', (data: RawData) => {
    let messageContent: string = '';
    const session = activeOpenAISessions.get(callId);
    if (!session) {
      // console.warn(`[${callId}] OpenAI message received but no active session found.`);
      return;
    }
    const currentAriClient = session.ariClient;
    const msgSessionLogger = currentAriClient.logger;

    if (Buffer.isBuffer(data)) { messageContent = data.toString('utf8'); }
    else if (Array.isArray(data)) { try { messageContent = Buffer.concat(data).toString('utf8'); } catch (e: any) { msgSessionLogger.error(`[${callId}] OpenAI: Error concatenating Buffer array: ${e.message}`); messageContent = ''; }}
    else if (data instanceof ArrayBuffer) { messageContent = Buffer.from(data).toString('utf8'); }
    else { msgSessionLogger.error(`[${callId}] OpenAI: Received unexpected data type.`); if (typeof data === 'string') { messageContent = data; } else if (data && typeof (data as any).toString === 'function') { messageContent = (data as any).toString(); msgSessionLogger.warn(`[${callId}] OpenAI: Used generic .toString() on unexpected data type.`);} else { messageContent = ''; msgSessionLogger.error(`[${callId}] OpenAI: Data has no .toString() method.`);}}

    if (messageContent && messageContent.trim().length > 0) {
      try {
        const serverEvent = JSON.parse(messageContent);
        // Loguear el evento completo como string JSON para máxima verbosidad en debug
        if (msgSessionLogger.isLevelEnabled?.('debug')) {
          msgSessionLogger.debug(`[${callId}] OpenAI Raw Parsed Server Event (${serverEvent.type}): ${JSON.stringify(serverEvent, null, 2)}`);
        } else { // Loguear de forma más concisa si no es debug
          msgSessionLogger.info(`[${callId}] OpenAI Parsed Server Event Type: ${serverEvent.type}`);
        }

        switch (serverEvent.type) {
          case 'session.created':
            msgSessionLogger.info(`[${callId}] OpenAI session.created. ID: ${serverEvent.session?.id}`);
            break;
          case 'session.updated':
            msgSessionLogger.info(`[${callId}] OpenAI session.updated. Input: ${serverEvent.session?.input_audio_format}, Output: ${serverEvent.session?.output_audio_format}, Voice: ${serverEvent.session?.voice}`);
            break;

          case 'response.delta': {
            if (serverEvent.delta && serverEvent.delta.part) {
              const part = serverEvent.delta.part;
              if (part.type === 'text' && typeof part.text === 'string') {
                // Este es el texto de la respuesta del LLM.
                // _onOpenAIInterimResult se encarga de acumularlo.
                // No es necesario loguear aquí si ya se loguea en _onOpenAIInterimResult.
                // msgSessionLogger.debug(`[${callId}] OpenAI response.delta (text): "${part.text}"`);
                currentAriClient._onOpenAIInterimResult(callId, part.text);
              } else if (part.type === 'tool_calls' && Array.isArray(part.tool_calls) && part.tool_calls.length > 0) {
                msgSessionLogger.info(`[${callId}] OpenAI response.delta (tool_calls) received. Count: ${part.tool_calls.length}`);
                if (session) session.processingToolCalls = true; // Marcar que estamos procesando herramientas

                const toolCallsFromOpenAI: OpenAIToolCall[] = part.tool_calls.map((tc: any) => ({
                  call_id: tc.id,
                  type: tc.type,
                  function: {
                    name: tc.function.name,
                    arguments: tc.function.arguments,
                  }
                }));

                Promise.allSettled(
                  toolCallsFromOpenAI.map(tc =>
                    executeTool(tc, callId, msgSessionLogger, session.config)
                  )
                ).then(results => {
                  if (!isOpen(session.ws)) {
                    msgSessionLogger.warn(`[${callId}] WebSocket closed before tool results could be sent.`);
                    return;
                  }
                  const toolResultsPayload: ToolResultPayload[] = [];
                  results.forEach(settledResult => {
                    if (settledResult.status === 'fulfilled') {
                      toolResultsPayload.push(settledResult.value);
                    } else {
                      msgSessionLogger.error(`[${callId}] executeTool promise was rejected:`, settledResult.reason);
                      // Podríamos crear un ToolResultPayload de error aquí si un tool_call_id específico falló
                      // y OpenAI espera una respuesta para cada tool_call_id.
                      // Por ahora, solo incluimos los exitosos.
                    }
                  });

                  if (toolResultsPayload.length > 0) {
                    msgSessionLogger.info(`[${callId}] Sending ${toolResultsPayload.length} tool results back to OpenAI.`);
                    const toolResultsEvent = {
                      type: "conversation.item.create",
                      item: { type: "tool_results", tool_results: toolResultsPayload }
                    };
                    session.ws.send(JSON.stringify(toolResultsEvent));
                    msgSessionLogger.debug(`[${callId}] OpenAI Realtime: Sent conversation.item.create (tool_results): ${JSON.stringify(toolResultsEvent)}`);

                    const responseCreateEvent = {
                      type: "response.create",
                      response: { modalities: session.config.openAIRealtimeAPI?.responseModalities || ["audio", "text"] }
                    };
                    session.ws.send(JSON.stringify(responseCreateEvent));
                    msgSessionLogger.debug(`[${callId}] OpenAI Realtime: Sent response.create after tool_results.`);
                  } else {
                     msgSessionLogger.warn(`[${callId}] No tool results were successfully generated or all failed. Not sending tool_results to OpenAI.`);
                     if (session) session.processingToolCalls = false; // Resetear si no se envían resultados
                     // Considerar si se debe enviar un error o finalizar el turno aquí.
                  }
                }).catch(error => {
                    msgSessionLogger.error(`[${callId}] Critical error in Promise.allSettled for tool execution: ${error}`);
                    if (session) session.processingToolCalls = false;
                    currentAriClient._onOpenAIError(callId, new Error("Failed to process tool calls."));
                });
                // Si hemos manejado tool_calls, no deberíamos procesar más partes de este delta como texto normal.
                // El flujo de 'response.text.delta' separado se encargará de los deltas de texto.
              } else if (part.type === 'tool_calls' && Array.isArray(part.tool_calls) && part.tool_calls.length === 0) {
                // OpenAI indicó tool_calls pero la lista está vacía. Esto es inusual.
                msgSessionLogger.warn(`[${callId}] OpenAI response.delta (tool_calls) received but the tool_calls array is empty.`);
              }
            }
            break;
          }
          // El case 'response.text.delta' original ya no es necesario si 'response.delta' con part.type === 'text' lo maneja.
          // Lo comentaré para evitar doble procesamiento. Si hay problemas, se puede restaurar.
          /*
          case 'response.text.delta':
            if (serverEvent.delta && typeof serverEvent.delta.text === 'string') {
              currentAriClient._onOpenAIInterimResult(callId, serverEvent.delta.text);
            }
            break;
          */
          case 'response.done':
            msgSessionLogger.info(`[${callId}] OpenAI response.done. ID: ${serverEvent.response?.id}. Current processingToolCalls: ${session.processingToolCalls || false}`);
            if (session) {
              const call = (session.ariClient as AriClientService).activeCalls.get(callId);
              if (call) {
                (call as any).lastOpenAIResponse = serverEvent.response;
              }
            }
            if (session.processingToolCalls) {
              msgSessionLogger.info(`[${callId}] response.done received while/after processing tool calls. Resetting flag, awaiting final LLM response or audio.`);
              session.processingToolCalls = false;
              // No llamar a _onOpenAIFinalResult aquí, porque la respuesta final de texto/audio vendrá en eventos subsiguientes.
              // 'response.done' aquí significa que OpenAI terminó de procesar los tool_results y *comenzará* a generar la respuesta final.
            } else {
              // Esta es la respuesta final al usuario (o un turno sin herramientas)
              let finalTranscriptText = "";
              if (serverEvent.response?.output?.length > 0) {
                const textOutput = serverEvent.response.output.find((item: any) => item.type === 'text_content' || (item.content && item.content.find((c:any) => c.type === 'text')));
                if (textOutput) {
                    if (textOutput.type === 'text_content') finalTranscriptText = textOutput.text;
                    else if (textOutput.content) {
                        const textPart = textOutput.content.find((c:any) => c.type === 'text');
                        if (textPart) finalTranscriptText = textPart.text;
                    }
                } else {
                    const altTextOutput = serverEvent.response.output.find((item:any) => item.transcript); // Check for older transcript field
                    if (altTextOutput) finalTranscriptText = altTextOutput.transcript;
                }
            }
            if (finalTranscriptText) {
              currentAriClient._onOpenAIFinalResult(callId, finalTranscriptText);
            } else if (serverEvent.response?.status !== 'cancelled' && serverEvent.response?.status !== 'tool_calls_completed') {
                 msgSessionLogger.warn(`[${callId}] OpenAI response.done, but no final text transcript in output. Status: ${serverEvent.response?.status}`);
            } // Cierre del else
            } // Cierre del if/else (session.processingToolCalls)
            break; // Break para el case 'response.done'
          case 'response.audio.delta':
            if (serverEvent.delta && typeof serverEvent.delta === 'string') { // OpenAI envía audio en base64
              currentAriClient._onOpenAIAudioChunk(callId, serverEvent.delta, false);
            }
            break;
          case 'response.audio.done':
            msgSessionLogger.info(`[${callId}] OpenAI response.audio.done. Resp ID: ${serverEvent.response_id}, Item ID: ${serverEvent.item_id}.`);
            currentAriClient._onOpenAIAudioStreamEnd(callId);
            break;
          case 'input_audio_buffer.speech_started':
               msgSessionLogger.info(`[${callId}] OpenAI detected speech started. Item ID: ${serverEvent.item_id}`);
               currentAriClient._onOpenAISpeechStarted(callId);
               break;
          case 'input_audio_buffer.speech_stopped':
               msgSessionLogger.info(`[${callId}] OpenAI detected speech stopped. Item ID: ${serverEvent.item_id}`);
               break;
          case 'input_audio_buffer.committed':
            msgSessionLogger.info(`[${callId}] OpenAI input_audio_buffer.committed: item_id=${serverEvent.item_id}`);
            break;
          case 'conversation.item.created':
            msgSessionLogger.info(`[${callId}] OpenAI conversation.item.created: item_id=${serverEvent.item?.id}, role=${serverEvent.item?.role}`);
            break;
          case 'response.created':
            msgSessionLogger.info(`[${callId}] OpenAI response.created: response_id=${serverEvent.response?.id}, status=${serverEvent.response?.status}`);
            break;
          case 'response.output_item.added':
            msgSessionLogger.info(`[${callId}] OpenAI response.output_item.added: response_id=${serverEvent.response_id}, item_id=${serverEvent.item?.id}`);
            break;
          case 'response.audio_transcript.delta':
            msgSessionLogger.debug(`[${callId}] OpenAI response.audio_transcript.delta: "${serverEvent.delta}"`);
            break;
          case 'response.audio_transcript.done':
            msgSessionLogger.info(`[${callId}] OpenAI response.audio_transcript.done: transcript="${serverEvent.transcript}"`);
            break;
          case 'response.content_part.added':
            msgSessionLogger.debug(`[${callId}] OpenAI response.content_part.added: item_id=${serverEvent.item_id}, content_type=${serverEvent.part?.type}`);
            break;
          case 'response.content_part.done':
            msgSessionLogger.debug(`[${callId}] OpenAI response.content_part.done: item_id=${serverEvent.item_id}, content_type=${serverEvent.part?.type}`);
            if (serverEvent.part?.type === 'audio' && serverEvent.part?.transcript) {
              msgSessionLogger.info(`[${callId}] OpenAI TTS transcript (from content_part.done): "${serverEvent.part.transcript}"`);
            }
            break;
          case 'response.output_item.done':
            msgSessionLogger.info(`[${callId}] OpenAI response.output_item.done: item_id=${serverEvent.item?.id}, role=${serverEvent.item?.role}`);
            break;
          case 'response.function_call_arguments.delta':
            if (session) {
              if (!session.functionCallArguments) {
                session.functionCallArguments = '';
              }
              session.functionCallArguments += serverEvent.delta;
            }
            break;
          case 'response.function_call_arguments.done':
            if (session) {
              const toolCall = {
                function: {
                  name: serverEvent.name,
                  arguments: session.functionCallArguments,
                },
                call_id: serverEvent.call_id,
                type: 'function',
              };
              executeTool(toolCall as any, callId, msgSessionLogger, session.config).then(result => {
                if (isOpen(session.ws)) {
                  const toolResultsEvent = {
                    type: "conversation.item.create",
                      item: { type: "function_call_output", output: result.output, call_id: result.tool_call_id }
                  };
                  session.ws.send(JSON.stringify(toolResultsEvent));
                  const responseCreateEvent = {
                    type: "response.create",
                    response: { modalities: session.config.openAIRealtimeAPI?.responseModalities || ["audio", "text"] }
                  };
                  session.ws.send(JSON.stringify(responseCreateEvent));
                }
              });
              session.functionCallArguments = '';
            }
            break;
          case 'rate_limits.updated':
            msgSessionLogger.info(`[${callId}] OpenAI rate_limits.updated:`, serverEvent.rate_limits);
            break;
          case 'error':
            msgSessionLogger.error(`[${callId}] OpenAI Server Error:`, serverEvent.error || serverEvent);
            currentAriClient._onOpenAIError(callId, serverEvent.error || serverEvent);
            break;
          default:
            msgSessionLogger.warn(`[${callId}] OpenAI: Unhandled event type '${serverEvent.type}'.`);
        }
      } catch (e: any) {
        msgSessionLogger.error(`[${callId}] OpenAI Realtime: Error parsing JSON message: ${e.message}. Raw: "${messageContent}"`);
        currentAriClient._onOpenAIError(callId, new Error(`Failed to process STT message: ${e.message}`));
      }
    } else if (messageContent !== '') {
        msgSessionLogger.warn(`[${callId}] OpenAI Realtime: Message content was empty after conversion/trimming.`);
    }
  });

  ws.on('error', (error: Error) => {
    sessionLogger.error(`SessionManager: OpenAI Realtime WebSocket error for callId ${callId}:`, error);
    ariClient._onOpenAIError(callId, error);
    if (activeOpenAISessions.has(callId)) { activeOpenAISessions.delete(callId); }
  });

  ws.on('close', (code: number, reason: Buffer) => {
    const reasonStr = reason.toString() || "Unknown reason";
    sessionLogger.info(`SessionManager: OpenAI Realtime WebSocket closed for callId ${callId}. Code: ${code}, Reason: ${reasonStr}`);
    if (activeOpenAISessions.has(callId)) {
        const closedSession = activeOpenAISessions.get(callId);
        closedSession?.ariClient._onOpenAISessionEnded(callId, reasonStr);
        activeOpenAISessions.delete(callId);
    }
  });
}

export function stopOpenAISession(callId: string, reason: string): void {
  const session = activeOpenAISessions.get(callId);
  const loggerToUse = session?.ariClient?.logger || console;
  loggerToUse.info(`SessionManager: Request to stop OpenAI Realtime session for callId ${callId}. Reason: ${reason}`);
  if (session?.ariClient) { // Check if ariClient exists to send event
    (session.ariClient as AriClientService).sendEventToFrontend({
      type: 'openai_session_stopping',
      callId: callId,
      timestamp: new Date().toISOString(),
      source: 'SESSION_MANAGER',
      payload: { reason: reason },
      logLevel: 'INFO'
    });
  }
  if (session?.ws && isOpen(session.ws)) {
    loggerToUse.info(`SessionManager: Closing OpenAI Realtime WebSocket for ${callId}.`);
    session.ws.close(1000, reason);
  } else if (session) {
    loggerToUse.info(`SessionManager: OpenAI Realtime WebSocket for ${callId} was already closed or not in OPEN state.`);
  } else {
    loggerToUse.warn(`SessionManager: stopOpenAISession called for ${callId}, but no active Realtime session data found.`);
  }
}

export function sendAudioToOpenAI(callId: string, audioPayload: Buffer): void {
  const session = activeOpenAISessions.get(callId);
  if (session?.ws && isOpen(session.ws)) {
    const sessionLogger = session.ariClient.logger;
    const base64AudioChunk = audioPayload.toString('base64');
    const audioEvent = { type: 'input_audio_buffer.append', audio: base64AudioChunk };
    try {
      const eventString = JSON.stringify(audioEvent);
      session.ws.send(eventString);
      // El log de debug ya es bastante bueno aquí, no necesita el JSON completo usualmente.
      sessionLogger.debug(`[${callId}] OpenAI Realtime: Sent input_audio_buffer.append (base64 chunk length: ${base64AudioChunk.length}, JSON event length: ${eventString.length})`);
      (session.ariClient as AriClientService).sendEventToFrontend({
        type: 'openai_audio_sent',
        callId: callId,
        timestamp: new Date().toISOString(),
        source: 'SESSION_MANAGER',
        payload: { chunkSizeBytes: base64AudioChunk.length }, // base64 length, not raw buffer
        logLevel: 'TRACE'
      });
    } catch (e:any) {
      sessionLogger.error(`[${callId}] Error sending audio event to OpenAI: ${e.message}`);
    }
  }
}

export function requestOpenAIResponse(callId: string, transcript: string, config: CallSpecificConfig): void {
  const session = activeOpenAISessions.get(callId);
  const sessionLogger = session?.ariClient?.logger || console;

  if (!session || !session.ws || !isOpen(session.ws)) {
    sessionLogger.error(`[${callId}] Cannot request OpenAI response: session not found or WebSocket not open.`);
    return;
  }

  try {
    const conversationItemCreateEvent = {
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text: transcript }] }
    };
    const convEventString = JSON.stringify(conversationItemCreateEvent);
    session.ws.send(convEventString);
    if (typeof (sessionLogger as any).isLevelEnabled === 'function' && (sessionLogger as any).isLevelEnabled('debug')) {
      sessionLogger.debug(`[${callId}] OpenAI Realtime: Sent conversation.item.create: ${convEventString}`);
    } else {
      sessionLogger.info(`[${callId}] OpenAI Realtime: Sent conversation.item.create (content details in debug log if enabled).`);
    }


    const responseCreateEvent = {
      type: "response.create",
      response: { modalities: config.openAIRealtimeAPI?.responseModalities || ["audio", "text"] }
    };
    const respEventString = JSON.stringify(responseCreateEvent);
    session.ws.send(respEventString);
    if (typeof (sessionLogger as any).isLevelEnabled === 'function' && (sessionLogger as any).isLevelEnabled('debug')) {
      sessionLogger.debug(`[${callId}] OpenAI Realtime: Sent response.create: ${respEventString}`);
    } else {
      sessionLogger.info(`[${callId}] OpenAI Realtime: Sent response.create (details in debug log if enabled). Modalities: ${responseCreateEvent.response.modalities.join(', ')}`);
    }

  } catch (e:any) {
    sessionLogger.error(`[${callId}] Error sending request for OpenAI response: ${e.message}`);
  }
}

export function handleAriCallEnd(callId: string) {
  const openAISession = activeOpenAISessions.get(callId);
  const loggerToUse = openAISession?.ariClient?.logger || console; // Fallback to console
  loggerToUse.info(`SessionManager: ARI call ${callId} ended. Cleaning up associated OpenAI Realtime session data.`);
  if (openAISession?.ws && isOpen(openAISession.ws)) {
    loggerToUse.info(`SessionManager: Closing active OpenAI Realtime connection for ended call ${callId}.`);
    openAISession.ws.close(1000, "Call ended");
  }
  activeOpenAISessions.delete(callId);

  const oldSession = legacyActiveSessions.get(callId);
  if (oldSession) {
    if (isOpen(oldSession.modelConn)) { oldSession.modelConn.close(); }
    if (oldSession.frontendConn && isOpen(oldSession.frontendConn)) {
         jsonSend(oldSession.frontendConn, {type: "call_ended", callId: callId });
    }
    legacyActiveSessions.delete(callId);
  } else if (!openAISession) {
    loggerToUse.warn(`SessionManager: Received ARI call end for callId ${callId}, but no session data was found.`);
  }
}

function parseMessage(data: RawData): any {
  try { return JSON.parse(data.toString()); }
  catch (e) {
    // console.error("SessionManager: Failed to parse incoming JSON message:", data.toString(), e);
    return null;
  }
}
function jsonSend(ws: WebSocket | undefined, obj: unknown) {
  if (isOpen(ws)) { ws.send(JSON.stringify(obj)); }
}
function isOpen(ws?: WebSocket): ws is WebSocket { return !!ws && ws.readyState === WebSocket.OPEN; }

export function sendSessionUpdateToOpenAI(callId: string, currentOpenAIConfig: OpenAIRealtimeAPIConfig) {
  const session = activeOpenAISessions.get(callId);
  const loggerToUse = session?.ariClient?.logger || console; // Fallback to console

  if (!session || !session.ws || !isOpen(session.ws)) {
    loggerToUse.warn(`[${callId}] SessionManager: Cannot send session.update to OpenAI, session not found or WebSocket not open.`);
    return;
  }
  const sessionUpdatePayload: any = {};
  if (currentOpenAIConfig.ttsVoice) {
    sessionUpdatePayload.voice = currentOpenAIConfig.ttsVoice;
  }
  if (currentOpenAIConfig.instructions) {
    sessionUpdatePayload.instructions = currentOpenAIConfig.instructions;
  }
  // Incluir tools en la actualización de sesión si están definidos
  // OpenAI espera un array de tool schemas. Si está vacío, se puede enviar un array vacío.
  if (typeof currentOpenAIConfig.tools !== 'undefined') {
    sessionUpdatePayload.tools = currentOpenAIConfig.tools;
  }

  if (Object.keys(sessionUpdatePayload).length === 0) {
    loggerToUse.info(`[${callId}] SessionManager: No relevant config changes to send to OpenAI via session.update.`);
    return;
  }
  const sessionUpdateEvent = { type: "session.update", session: sessionUpdatePayload };
  loggerToUse.info(`[${callId}] SessionManager: Sending session.update to OpenAI with new config:`, JSON.stringify(sessionUpdatePayload, null, 2));
  try {
    session.ws.send(JSON.stringify(sessionUpdateEvent));
    loggerToUse.info(`[${callId}] SessionManager: Successfully sent session.update to OpenAI.`);
    // Send event to frontend
    if (session.ariClient) { // Make sure ariClient is available
        (session.ariClient as AriClientService).sendEventToFrontend({
            type: 'openai_session_config_updated_sent', // More specific event type
            callId: callId,
            timestamp: new Date().toISOString(),
            source: 'SESSION_MANAGER',
            payload: { updatedConfig: sessionUpdatePayload },
            logLevel: 'INFO'
        });
    }
  } catch (e: any) {
    loggerToUse.error(`[${callId}] SessionManager: Error sending session.update to OpenAI: ${e.message}`);
    if (session.ariClient) {
        (session.ariClient as AriClientService).sendEventToFrontend({
            type: 'openai_session_config_update_failed',
            callId: callId,
            timestamp: new Date().toISOString(),
            source: 'SESSION_MANAGER',
            payload: { attemptedConfig: sessionUpdatePayload, errorMessage: e.message },
            logLevel: 'ERROR'
        });
    }
  }
}
