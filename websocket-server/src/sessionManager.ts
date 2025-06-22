import { RawData, WebSocket } from "ws";
import functions from "./functionHandlers";
import { CallSpecificConfig, OpenAIRealtimeAPIConfig, AriClientInterface } from "./types";
import { AriClientService } from "./ari-client";

interface OpenAISession {
  ws: WebSocket;
  ariClient: AriClientInterface;
  callId: string;
  config: CallSpecificConfig;
}

const activeOpenAISessions = new Map<string, OpenAISession>();

// --- Inicio de sección de código antiguo (posiblemente para eliminar/refactorizar después) ---
interface CallSessionData {
  callId: string;
  ariClient: AriClientService;
  frontendConn?: WebSocket;
  modelConn?: WebSocket;
  config: CallSpecificConfig;
  lastAssistantItemId?: string;
  responseStartTimestamp?: number;
}
const activeSessions = new Map<string, CallSessionData>();
function getSession(callId: string, operation: string): CallSessionData | undefined {
  const session = activeSessions.get(callId);
  if (!session) {
    // console.error(`SessionManager (Legacy): ${operation} failed. No active session found for callId ${callId}.`);
  }
  return session;
}
export function handleCallConnection(callId: string, ariClient: AriClientService) {
  if (activeSessions.has(callId)) {
    // console.warn(`SessionManager (Legacy): Call connection for ${callId} already exists. Will clean up old OpenAI model connection if any.`);
    const oldSession = activeSessions.get(callId);
    if (oldSession?.modelConn && isOpen(oldSession.modelConn)) {
      oldSession.modelConn.close();
    }
  }
  // console.log(`SessionManager (Legacy): Initializing session data placeholder for call: ${callId}`);
  const newSessionData: Partial<CallSessionData> = { callId, ariClient };
  activeSessions.set(callId, newSessionData as CallSessionData);
}
let globalFrontendConn: WebSocket | undefined;
export function handleFrontendConnection(ws: WebSocket) {
  if (isOpen(globalFrontendConn)) globalFrontendConn.close();
  globalFrontendConn = ws;
  console.log("SessionManager: Global frontend WebSocket client connected (used for legacy message forwarding).");
  ws.on("message", (data) => handleFrontendMessage(null, data)); // Pass null for callId initially
  ws.on("close", () => {
    globalFrontendConn = undefined;
    console.log("SessionManager: Global frontend WebSocket client disconnected.");
  });
}
function handleFrontendMessage(callId: string | null, data: RawData) {
  const msg = parseMessage(data);
  if (!msg) return;
  // This function is now primarily for server.ts to handle session.update.
  // Legacy modelConn logic might be here if needed.
  // For session.update, server.ts will handle it directly.
}
function handleModelMessage(callId: string, data: RawData) {
  // This function handles messages from an older/different OpenAI model connection, not Realtime API.
  // Kept for now if parts of the system still use it.
  const session = getSession(callId, "handleModelMessage");
  if (!session) return;
  const event = parseMessage(data);
  if (!event) {
    console.error(`SessionManager (Legacy): Failed to parse JSON message from old OpenAI model for call ${callId}:`, data.toString());
    return;
  }
  // console.debug(`[${callId}] (Legacy) Received message from old OpenAI model: type '${event?.type}'`);
  jsonSend(globalFrontendConn || session.frontendConn, event); // Forward to frontend
}
async function handleFunctionCall(callId: string, item: { name: string; arguments: string, call_id?: string }) {
  // This seems to be for a legacy function call mechanism.
  // console.log(`SessionManager (Legacy): Handling function call '${item.name}' for callId ${callId}. Args: ${item.arguments}`);
}
function closeModelConnection(callId: string) {
  const session = activeSessions.get(callId);
  if (session) {
    session.modelConn = undefined;
  }
}
export function handleFrontendDisconnection() {
    if(isOpen(globalFrontendConn)) {
        globalFrontendConn.close();
    }
    globalFrontendConn = undefined;
    // console.log("SessionManager: Global frontend WebSocket connection has been reset/cleared.");
}
// --- Fin de sección de código antiguo ---

export function startOpenAISession(callId: string, ariClient: AriClientInterface, config: CallSpecificConfig): void {
  const sessionLogger = ariClient.logger || console;
  sessionLogger.info(`SessionManager: Attempting to start OpenAI Realtime session for callId ${callId}.`);

  if (activeOpenAISessions.has(callId)) {
    sessionLogger.warn(`SessionManager: OpenAI Realtime session for ${callId} already exists. Closing old one.`);
    const oldSession = activeOpenAISessions.get(callId);
    if (oldSession?.ws && oldSession.ws.readyState === WebSocket.OPEN) {
      oldSession.ws.close(1000, "Starting new session");
    }
    activeOpenAISessions.delete(callId);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    sessionLogger.error(`SessionManager: CRITICAL - OPENAI_API_KEY not found. Cannot start Realtime session for ${callId}.`);
    ariClient._onOpenAIError(callId, new Error("OPENAI_API_KEY not configured on server."));
    return;
  }

  const realtimeConfig = config.openAIRealtimeAPI;
  const baseUrl = "wss://api.openai.com/v1/realtime";
  let wsQueryString = realtimeConfig?.model ? `?model=${realtimeConfig.model}` : `?model=gpt-4o-mini-realtime-preview-2024-12-17`; // Default model
  const wsUrl = baseUrl + wsQueryString;
  const headers = { 'Authorization': `Bearer ${apiKey}`, 'OpenAI-Beta': 'realtime=v1' };

  sessionLogger.info(`[${callId}] Connecting to OpenAI Realtime WebSocket: ${wsUrl.split('?')[0]}?model=...`);
  // sessionLogger.debug(`[${callId}] OpenAI Realtime WS Headers:`, headers);

  const ws = new WebSocket(wsUrl, { headers });
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
        ws.send(JSON.stringify(sessionUpdateEvent));
        sessionLogger.info(`[${callId}] OpenAI Realtime: Sent session.update event:`, sessionUpdateEvent.session);
      } catch (e: any) {
        sessionLogger.error(`[${callId}] OpenAI Realtime: Failed to send session.update event: ${e.message}`);
      }
    }
  });

  ws.on('message', (data: RawData) => {
    let messageContent: string = '';
    const session = activeOpenAISessions.get(callId);
    if (!session) return;
    const currentAriClient = session.ariClient;
    const msgSessionLogger = currentAriClient.logger || console;

    if (Buffer.isBuffer(data)) { messageContent = data.toString('utf8'); }
    else if (Array.isArray(data)) { try { messageContent = Buffer.concat(data).toString('utf8'); } catch (e: any) { msgSessionLogger.error(`[${callId}] OpenAI: Error concatenating Buffer array: ${e.message}`); messageContent = ''; }}
    else if (data instanceof ArrayBuffer) { messageContent = Buffer.from(data).toString('utf8'); }
    else { msgSessionLogger.error(`[${callId}] OpenAI: Received unexpected data type.`); if (typeof data === 'string') { messageContent = data; } else if (data && typeof (data as any).toString === 'function') { messageContent = (data as any).toString(); msgSessionLogger.warn(`[${callId}] OpenAI: Used generic .toString() on unexpected data type.`);} else { messageContent = ''; msgSessionLogger.error(`[${callId}] OpenAI: Data has no .toString() method.`);}}

    if (messageContent && messageContent.trim().length > 0) {
      try {
        const serverEvent = JSON.parse(messageContent);
        msgSessionLogger.debug(`[${callId}] OpenAI Parsed Server Event (${serverEvent.type}):`, serverEvent);

        switch (serverEvent.type) {
          case 'session.created':
            msgSessionLogger.info(`[${callId}] OpenAI session.created. Session ID: ${serverEvent.session?.id}`);
            break;
          case 'session.updated':
            msgSessionLogger.info(`[${callId}] OpenAI session.updated. Input: ${serverEvent.session?.input_audio_format}, Output: ${serverEvent.session?.output_audio_format}, Voice: ${serverEvent.session?.voice}`);
            break;
          case 'response.text.delta':
            if (serverEvent.delta && typeof serverEvent.delta.text === 'string') {
              currentAriClient._onOpenAIInterimResult(callId, serverEvent.delta.text);
            }
            break;
          case 'response.done':
            msgSessionLogger.info(`[${callId}] OpenAI response.done. Response ID: ${serverEvent.response?.id}`);
            let finalTranscriptText = "";
             if (serverEvent.response && serverEvent.response.output && serverEvent.response.output.length > 0) {
                const textOutput = serverEvent.response.output.find((item: any) => item.type === 'text_content' || (item.content && item.content.find((c:any) => c.type === 'text')));
                if (textOutput) {
                    if (textOutput.type === 'text_content') finalTranscriptText = textOutput.text;
                    else if (textOutput.content) {
                        const textPart = textOutput.content.find((c:any) => c.type === 'text');
                        if (textPart) finalTranscriptText = textPart.text;
                    }
                } else { // Fallback for older or different structures if text_content is not primary
                    const altTextOutput = serverEvent.response.output.find((item:any) => item.transcript);
                    if (altTextOutput) finalTranscriptText = altTextOutput.transcript;
                }
            }
            if (finalTranscriptText) {
              currentAriClient._onOpenAIFinalResult(callId, finalTranscriptText);
            } else {
                 msgSessionLogger.warn(`[${callId}] OpenAI response.done received, but no final text transcript found in output.`);
            }
            break;
          case 'response.audio.delta':
            if (serverEvent.delta && typeof serverEvent.delta.audio === 'string') {
              currentAriClient._onOpenAIAudioChunk(callId, serverEvent.delta.audio, false);
            }
            break;
          case 'response.audio.done':
            msgSessionLogger.info(`[${callId}] OpenAI response.audio.done. Response ID: ${serverEvent.response_id}, Item ID: ${serverEvent.item_id}. Triggering playback.`);
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
    } else if (messageContent !== '') { // Only warn if it was non-empty before trim
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
    const sessionLogger = session.ariClient.logger || console;
    const base64AudioChunk = audioPayload.toString('base64');
    const audioEvent = { type: 'input_audio_buffer.append', audio: base64AudioChunk };
    try {
      session.ws.send(JSON.stringify(audioEvent));
      sessionLogger.debug(`[${callId}] OpenAI Realtime: Sent input_audio_buffer.append (chunk length: ${base64AudioChunk.length})`);
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
    session.ws.send(JSON.stringify(conversationItemCreateEvent));
    sessionLogger.info(`[${callId}] OpenAI Realtime: Sent conversation.item.create:`, conversationItemCreateEvent.item.content);

    const responseCreateEvent = {
      type: "response.create",
      response: { modalities: config.openAIRealtimeAPI?.responseModalities || ["audio", "text"] }
    };
    session.ws.send(JSON.stringify(responseCreateEvent));
    sessionLogger.info(`[${callId}] OpenAI Realtime: Sent response.create requesting modalities:`, responseCreateEvent.response.modalities);
  } catch (e:any) {
    sessionLogger.error(`[${callId}] Error sending request for OpenAI response: ${e.message}`);
  }
}

export function handleAriCallEnd(callId: string) {
  const openAISession = activeOpenAISessions.get(callId);
  const loggerToUse = openAISession?.ariClient?.logger || console;
  loggerToUse.info(`SessionManager: ARI call ${callId} ended. Cleaning up associated OpenAI Realtime session data.`);
  if (openAISession?.ws && isOpen(openAISession.ws)) {
    loggerToUse.info(`SessionManager: Closing active OpenAI Realtime connection for ended call ${callId}.`);
    openAISession.ws.close(1000, "Call ended");
  }
  activeOpenAISessions.delete(callId); // Ensure it's removed

  // Legacy session cleanup
  const oldSession = activeSessions.get(callId);
  if (oldSession) {
    if (isOpen(oldSession.modelConn)) {
      // loggerToUse.info(`SessionManager (Legacy): Closing any active old model connection for ended call ${callId}.`);
      oldSession.modelConn.close();
    }
    if (oldSession.frontendConn && isOpen(oldSession.frontendConn)) {
         jsonSend(oldSession.frontendConn, {type: "call_ended", callId: callId });
    }
    activeSessions.delete(callId);
    // loggerToUse.info(`SessionManager (Legacy): Old session data for callId ${callId} fully removed.`);
  } else if (!openAISession) { // Only log warn if no session of either type was found
    loggerToUse.warn(`SessionManager: Received ARI call end for callId ${callId}, but no session data was found.`);
  }
}

function parseMessage(data: RawData): any {
  try { return JSON.parse(data.toString()); }
  catch (e) { console.error("SessionManager: Failed to parse incoming JSON message:", data.toString(), e); return null; }
}
function jsonSend(ws: WebSocket | undefined, obj: unknown) {
  if (isOpen(ws)) { ws.send(JSON.stringify(obj)); }
}
function isOpen(ws?: WebSocket): ws is WebSocket { return !!ws && ws.readyState === WebSocket.OPEN; }

export function sendSessionUpdateToOpenAI(callId: string, currentOpenAIConfig: OpenAIRealtimeAPIConfig) {
  const session = activeOpenAISessions.get(callId);
  const loggerToUse = session?.ariClient?.logger || console;

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
  if (Object.keys(sessionUpdatePayload).length === 0) {
    loggerToUse.info(`[${callId}] SessionManager: No relevant config changes to send to OpenAI via session.update.`);
    return;
  }
  const sessionUpdateEvent = { type: "session.update", session: sessionUpdatePayload };
  loggerToUse.info(`[${callId}] SessionManager: Sending session.update to OpenAI with new config:`, sessionUpdatePayload);
  try {
    session.ws.send(JSON.stringify(sessionUpdateEvent));
    loggerToUse.info(`[${callId}] SessionManager: Successfully sent session.update to OpenAI.`);
  } catch (e: any) {
    loggerToUse.error(`[${callId}] SessionManager: Error sending session.update to OpenAI: ${e.message}`);
  }
}
