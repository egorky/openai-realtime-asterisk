import { RawData, WebSocket } from "ws";
import functions from "./functionHandlers";
import { CallSpecificConfig, OpenAIRealtimeAPIConfig, AriClientInterface } from "./types";
import { AriClientService } from "./ari-client";

// Define a type/interface for storing session information
interface OpenAISession {
  ws: WebSocket;
  ariClient: AriClientInterface;
  callId: string;
  config: CallSpecificConfig;
  // isReady?: boolean; // Optional: if specific ready state needed after session.created
}

// Declare a map to store active sessions
const activeOpenAISessions = new Map<string, OpenAISession>();

// Keep existing activeSessions for now if it's used by other functionalities not being refactored.
// If this refactoring aims to replace the old session management entirely for OpenAI,
// then the old activeSessions might be removed or merged. For now, introducing activeOpenAISessions.
interface CallSessionData {
  callId: string;
  ariClient: AriClientService; // This is likely the concrete implementation
  frontendConn?: WebSocket;
  modelConn?: WebSocket; // This is the old OpenAI WebSocket connection
  config: CallSpecificConfig;
  lastAssistantItemId?: string;
  responseStartTimestamp?: number;
}

const activeSessions = new Map<string, CallSessionData>();

function getSession(callId: string, operation: string): CallSessionData | undefined {
  const session = activeSessions.get(callId);
  if (!session) {
    console.error(`SessionManager: ${operation} failed. No active session found for callId ${callId}.`);
  }
  return session;
}

// Modified: openAIApiKey parameter removed
export function handleCallConnection(callId: string, ariClient: AriClientService) {
  if (activeSessions.has(callId)) {
    console.warn(`SessionManager: Call connection for ${callId} already exists. Will clean up old OpenAI model connection if any and re-initialize session data.`);
    const oldSession = activeSessions.get(callId);
    if (oldSession?.modelConn && isOpen(oldSession.modelConn)) {
      oldSession.modelConn.close();
    }
  }

  console.log(`SessionManager: Initializing session data placeholder for call: ${callId}`);
  // API key will be sourced from config when startOpenAISession is called.
  const newSessionData: Partial<CallSessionData> = {
    callId,
    ariClient,
    // config will be added by startOpenAISession
  };
  activeSessions.set(callId, newSessionData as CallSessionData);
}

export function startOpenAISession(callId: string, ariClient: AriClientInterface, config: CallSpecificConfig): void {
  const sessionLogger = ariClient.logger || console; // Define sessionLogger early for use
  sessionLogger.info(`SessionManager: Attempting to start OpenAI STT session for callId ${callId}.`);

  if (activeOpenAISessions.has(callId)) {
    sessionLogger.warn(`SessionManager: OpenAI STT session for ${callId} already exists. Closing old one.`);
    const oldSession = activeOpenAISessions.get(callId);
    if (oldSession?.ws && oldSession.ws.readyState === WebSocket.OPEN) {
      oldSession.ws.close(1000, "Starting new session");
    }
    activeOpenAISessions.delete(callId);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    sessionLogger.error(`SessionManager: CRITICAL - OPENAI_API_KEY not found in environment variables. Cannot start STT session for ${callId}.`);
    ariClient._onOpenAIError(callId, new Error("OPENAI_API_KEY not configured on server."));
    return;
  }

  const sttConfig = config.openAIRealtimeAPI;

  const baseUrl = "wss://api.openai.com/v1/realtime";
  let wsQueryString = "";

  if (sttConfig?.model && sttConfig.model.trim() !== "") {
    wsQueryString = `?model=${sttConfig.model}`;
  } else if (sttConfig?.transcriptionIntentOnly === true) {
    wsQueryString = `?intent=transcription`;
  } else {
    sessionLogger.error('OpenAI STT: model or transcriptionIntentOnly not clearly configured. Defaulting to example model.');
    wsQueryString = `?model=gpt-4o-mini-realtime-preview-2024-12-17`;
  }
  const wsUrl = baseUrl + wsQueryString;

  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'OpenAI-Beta': 'realtime=v1'
  };

  sessionLogger.debug(`[${callId}] Connecting to OpenAI STT WebSocket: ${wsUrl.replace(apiKey, "****")} with headers:`, headers);
  const ws = new WebSocket(wsUrl, { headers });

  const newSession: OpenAISession = { ws, ariClient, callId, config };
  activeOpenAISessions.set(callId, newSession);

  ws.on('open', () => {
    sessionLogger.info(`SessionManager: OpenAI Realtime WebSocket connection established for callId ${callId}.`);
    const currentSTTConfig = newSession.config.openAIRealtimeAPI;

    const sessionUpdateEvent = {
      type: "session.update",
      session: {
        input_audio_format: currentSTTConfig?.inputAudioFormat || "g711_ulaw",
        output_audio_format: currentSTTConfig?.outputAudioFormat || "g711_ulaw",
        voice: currentSTTConfig?.ttsVoice || 'alloy',
        instructions: currentSTTConfig?.instructions, // This will carry the Spanish default from config if not overridden
      }
    };

    sessionLogger.debug(`[${callId}] OpenAI Realtime: Sending session.update event:`, sessionUpdateEvent);
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(sessionUpdateEvent));
        sessionLogger.info(`OpenAI Realtime: Sent session.update event for callId ${callId}: ${JSON.stringify(sessionUpdateEvent)}`);
      } catch (e: any) {
        sessionLogger.error(`OpenAI Realtime: Failed to send session.update event for callId ${callId}: ${e.message}`);
      }
    }
  });

  ws.on('message', (data: RawData) => {
    let messageContent: string = '';
    const session = activeOpenAISessions.get(callId);
    if (!session) return;

    const currentAriClient = session.ariClient;
    const msgSessionLogger = currentAriClient.logger || console;

    if (Buffer.isBuffer(data)) {
      messageContent = data.toString('utf8');
    } else if (Array.isArray(data)) {
      try {
        messageContent = Buffer.concat(data).toString('utf8');
      } catch (e: any) {
        msgSessionLogger.error(`OpenAI Realtime WebSocket: Error concatenating Buffer array for callId ${callId}: ${e.message}`);
        messageContent = '';
      }
    } else if (data instanceof ArrayBuffer) {
      messageContent = Buffer.from(data).toString('utf8');
    } else {
      msgSessionLogger.error(`OpenAI Realtime WebSocket: Received unexpected data type for callId ${callId}.`);
      if (typeof data === 'string') {
         messageContent = data;
      } else if (data && typeof (data as any).toString === 'function') {
         messageContent = (data as any).toString();
         msgSessionLogger.warn(`OpenAI Realtime WebSocket: Used generic .toString() on unexpected data type for callId ${callId}.`);
      } else {
         messageContent = '';
         msgSessionLogger.error(`OpenAI Realtime WebSocket: Data for callId ${callId} has no .toString() method and is of unknown type.`);
      }
    }

    msgSessionLogger.debug(`[${callId}] OpenAI Raw Server Message: ${messageContent}`);
    if (messageContent && messageContent.trim().length > 0) {
      try {
        const serverEvent = JSON.parse(messageContent);
        msgSessionLogger.debug(`[${callId}] OpenAI Parsed Server Event:`, serverEvent);

        switch (serverEvent.type) {
          case 'session.created':
            msgSessionLogger.info(`OpenAI session.created for ${callId}: ${JSON.stringify(serverEvent.session)}`);
            break;
          case 'session.updated':
            msgSessionLogger.info(`OpenAI session.updated for ${callId}: ${JSON.stringify(serverEvent.session)}`);
            break;
          case 'response.text.delta':
            if (serverEvent.delta && typeof serverEvent.delta.text === 'string') {
              currentAriClient._onOpenAIInterimResult(callId, serverEvent.delta.text);
            }
            break;
          case 'response.done':
            msgSessionLogger.info(`OpenAI response.done for ${callId}.`);
            let finalTranscriptText = "";
            if (serverEvent.response && serverEvent.response.output && serverEvent.response.output.length > 0) {
                const textOutput = serverEvent.response.output.find((item: any) => item.type === 'text_content' || (item.content && item.content.find((c:any) => c.type === 'text')));
                if (textOutput) {
                    if (textOutput.type === 'text_content') finalTranscriptText = textOutput.text;
                    else if (textOutput.content) {
                        const textPart = textOutput.content.find((c:any) => c.type === 'text');
                        if (textPart) finalTranscriptText = textPart.text;
                    }
                } else {
                    const altTextOutput = serverEvent.response.output.find((item:any) => item.transcript);
                    if (altTextOutput) finalTranscriptText = altTextOutput.transcript;
                }
            }
            if (finalTranscriptText) {
              currentAriClient._onOpenAIFinalResult(callId, finalTranscriptText);
            }
            break;
          case 'response.audio.delta':
            if (serverEvent.delta && typeof serverEvent.delta.audio === 'string') {
              if (typeof currentAriClient._onOpenAIAudioChunk === 'function') {
                   currentAriClient._onOpenAIAudioChunk(callId, serverEvent.delta.audio, false);
              } else {
                   msgSessionLogger.warn("ariClient._onOpenAIAudioChunk is not implemented yet.");
              }
            }
            break;
          case 'response.audio.done':
            msgSessionLogger.info(`OpenAI response.audio.done for ${callId}. Triggering playback of accumulated audio.`);
            if (typeof currentAriClient._onOpenAIAudioStreamEnd === 'function') {
              currentAriClient._onOpenAIAudioStreamEnd(callId);
            } else {
              msgSessionLogger.warn("ariClient._onOpenAIAudioStreamEnd is not implemented yet."); // Should not happen
            }
            break;
          case 'input_audio_buffer.speech_started':
               msgSessionLogger.info(`OpenAI detected speech started for ${callId}`);
               currentAriClient._onOpenAISpeechStarted(callId);
               break;
          case 'input_audio_buffer.speech_stopped':
               msgSessionLogger.info(`OpenAI detected speech stopped for ${callId}`);
               break;
          case 'input_audio_buffer.committed':
            msgSessionLogger.info(`OpenAI input_audio_buffer.committed for ${callId}: item_id=${serverEvent.item_id}`);
            // This event confirms a segment of user audio has been fully processed for STT.
            // It might be useful for turn-taking logic or if specific actions are needed
            // after the user finishes speaking a phrase and before the assistant responds.
            break;
          case 'conversation.item.created':
            msgSessionLogger.info(`OpenAI conversation.item.created for ${callId}: item_id=${serverEvent.item?.id}, role=${serverEvent.item?.role}`);
            // This event signals a new item (user message, assistant response, tool call)
            // has been added to the conversation history.
            break;
          case 'response.created':
            msgSessionLogger.info(`OpenAI response.created for ${callId}: response_id=${serverEvent.response?.id}, status=${serverEvent.response?.status}`);
            // This indicates the start of an assistant's response generation.
            break;
          case 'response.output_item.added':
            msgSessionLogger.info(`OpenAI response.output_item.added for ${callId}: response_id=${serverEvent.response_id}, item_id=${serverEvent.item?.id}`);
            // This event indicates a new item (e.g. a message with audio/text content parts)
            // has been added to the current assistant response.
            break;
          case 'response.audio_transcript.delta':
            msgSessionLogger.debug(`OpenAI response.audio_transcript.delta for ${callId}: "${serverEvent.delta}"`);
            // This is the text version of what OpenAI is currently speaking (TTS).
            // Could be used to display real-time captions if a UI were present.
            break;
          case 'response.audio_transcript.done':
            msgSessionLogger.info(`OpenAI response.audio_transcript.done for ${callId}: transcript="${serverEvent.transcript}"`);
            // Full transcript of what OpenAI just spoke.
            break;
          case 'response.content_part.added':
            msgSessionLogger.debug(`OpenAI response.content_part.added for ${callId}: item_id=${serverEvent.item_id}, content_type=${serverEvent.part?.type}`);
            // Signals a new content part (like audio or text) is being added to an output item.
            break;
          case 'response.content_part.done':
            msgSessionLogger.debug(`OpenAI response.content_part.done for ${callId}: item_id=${serverEvent.item_id}, content_type=${serverEvent.part?.type}`);
            // Signals a content part has finished. For audio, transcript might be here.
            if (serverEvent.part?.type === 'audio' && serverEvent.part?.transcript) {
              msgSessionLogger.info(`OpenAI TTS transcript (from content_part.done) for ${callId}: "${serverEvent.part.transcript}"`);
            }
            break;
          case 'response.output_item.done':
            msgSessionLogger.info(`OpenAI response.output_item.done for ${callId}: item_id=${serverEvent.item?.id}, role=${serverEvent.item?.role}`);
            // Signals a complete item in the assistant's response (e.g., a full message with all its content parts) is done.
            break;
          case 'rate_limits.updated':
            msgSessionLogger.info(`OpenAI rate_limits.updated for ${callId}: ${JSON.stringify(serverEvent.rate_limits)}`);
            // Provides information about current API rate limit status.
            break;
          case 'error':
            msgSessionLogger.error(`OpenAI Server Error for ${callId}:`, serverEvent.error || serverEvent);
            currentAriClient._onOpenAIError(callId, serverEvent.error || serverEvent);
            break;
          default:
            msgSessionLogger.warn(`OpenAI: Unhandled event type '${serverEvent.type}' for ${callId}. Full event: ${JSON.stringify(serverEvent)}`);
        }
      } catch (e: any) {
        msgSessionLogger.error(`OpenAI Realtime WebSocket: Error parsing JSON message for callId ${callId}: ${e.message}. Raw content: "${messageContent}"`);
        currentAriClient._onOpenAIError(callId, new Error(`Failed to process STT message: ${e.message}`));
      }
    } else {
      if (messageContent !== '') {
          msgSessionLogger.warn(`OpenAI Realtime WebSocket: Message content was empty after conversion/trimming for callId ${callId}.`);
      }
    }
  });

  ws.on('error', (error: Error) => {
    sessionLogger.error(`SessionManager: OpenAI STT WebSocket error for callId ${callId}:`, error);
    ariClient._onOpenAIError(callId, error);
    if (activeOpenAISessions.has(callId)) {
        activeOpenAISessions.delete(callId);
    }
  });

  ws.on('close', (code: number, reason: Buffer) => {
    const reasonStr = reason.toString() || "Unknown reason";
    sessionLogger.info(`SessionManager: OpenAI STT WebSocket closed for callId ${callId}. Code: ${code}, Reason: ${reasonStr}`);
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
  loggerToUse.info(`SessionManager: Request to stop OpenAI STT session for callId ${callId}. Reason: ${reason}`);
  if (session) {
    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
      loggerToUse.info(`SessionManager: Closing OpenAI STT WebSocket for ${callId}.`);
      session.ws.close(1000, reason);
    } else {
      loggerToUse.info(`SessionManager: OpenAI STT WebSocket for ${callId} was already closed or not in OPEN state.`);
    }
  } else {
    loggerToUse.warn(`SessionManager: stopOpenAISession called for ${callId}, but no active STT session data found.`);
  }
}

export function sendAudioToOpenAI(callId: string, audioPayload: Buffer): void {
  const session = activeOpenAISessions.get(callId);
  if (session && session.ws && session.ws.readyState === WebSocket.OPEN) {
    const sessionLogger = session.ariClient.logger || console;
    const base64AudioChunk = audioPayload.toString('base64');
    const audioEvent = { type: 'input_audio_buffer.append', audio: base64AudioChunk };
    sessionLogger.debug(`[${callId}] OpenAI Realtime: Sending input_audio_buffer.append event with audio chunk length: ${base64AudioChunk.length}`);
    try {
      session.ws.send(JSON.stringify(audioEvent));
    } catch (e:any) {
      sessionLogger.error(`[${callId}] Error sending audio event to OpenAI: ${e.message}`);
    }
  }
}

export function requestOpenAIResponse(callId: string, transcript: string, config: CallSpecificConfig): void {
  const session = activeOpenAISessions.get(callId);
  const sessionLogger = session?.ariClient?.logger || console;

  if (!session || !session.ws || session.ws.readyState !== WebSocket.OPEN) {
    sessionLogger.error(`[${callId}] Cannot request OpenAI response: session not found or WebSocket not open.`);
    return;
  }

  try {
    const conversationItemCreateEvent = {
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: transcript }]
      }
    };
    sessionLogger.debug(`[${callId}] OpenAI Realtime: Sending conversation.item.create event:`, conversationItemCreateEvent);
    session.ws.send(JSON.stringify(conversationItemCreateEvent));
    sessionLogger.info(`[${callId}] Sent conversation.item.create with user transcript.`);

    const responseCreateEvent = {
      type: "response.create",
      response: {
        modalities: config.openAIRealtimeAPI?.responseModalities || ["audio", "text"],
      }
    };
    sessionLogger.debug(`[${callId}] OpenAI Realtime: Sending response.create event:`, responseCreateEvent);
    session.ws.send(JSON.stringify(responseCreateEvent));
    sessionLogger.info(`[${callId}] Sent response.create requesting modalities: ${JSON.stringify(responseCreateEvent.response.modalities)}`);

  } catch (e:any) {
    sessionLogger.error(`[${callId}] Error sending request for OpenAI response: ${e.message}`);
  }
}

export function handleAriCallEnd(callId: string) {
  const session = activeOpenAISessions.get(callId);
  const loggerToUse = session?.ariClient?.logger || console;
  loggerToUse.info(`SessionManager: ARI call ${callId} ended. Cleaning up associated OpenAI STT session data.`);

  if (session) {
    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
      loggerToUse.info(`SessionManager: Closing active OpenAI STT connection for ended call ${callId}.`);
      session.ws.close(1000, "Call ended");
    }
  }

  const oldSession = activeSessions.get(callId);
  if (oldSession) {
    if (isOpen(oldSession.modelConn)) {
      loggerToUse.info(`SessionManager (Legacy): Closing any active old model connection for ended call ${callId}.`);
      oldSession.modelConn.close();
    }
    if (oldSession.frontendConn && isOpen(oldSession.frontendConn)) {
         jsonSend(oldSession.frontendConn, {type: "call_ended", callId: callId });
    }
    activeSessions.delete(callId);
    loggerToUse.info(`SessionManager (Legacy): Old session data for callId ${callId} fully removed.`);
  } else if (!session) {
    loggerToUse.warn(`SessionManager: Received ARI call end for callId ${callId}, but no session data was found (already cleaned up or never existed).`);
  }
}

let globalFrontendConn: WebSocket | undefined;
export function handleFrontendConnection(ws: WebSocket) {
  if (isOpen(globalFrontendConn)) globalFrontendConn.close();
  globalFrontendConn = ws;
  console.log("SessionManager: Global frontend WebSocket client connected.");
  ws.on("message", (data) => handleFrontendMessage(null, data));
  ws.on("close", () => {
    globalFrontendConn = undefined;
    console.log("SessionManager: Global frontend WebSocket client disconnected.");
  });
}

function handleFrontendMessage(callId: string | null, data: RawData) {
  const msg = parseMessage(data);
  if (!msg) return;
  const targetCallId = msg.callId || callId;

  if (targetCallId) {
    const session = getSession(targetCallId, "handleFrontendMessageTargeted");
    if (session && isOpen(session.modelConn) && msg.type !== "session.update") {
      jsonSend(session.modelConn, msg);
    } else if (session && msg.type === "session.update") {
      console.log(`SessionManager: (TODO) Received session.update from frontend for call ${targetCallId}:`, msg.session);
    }
  } else if (msg.type === "session.update") {
      console.log("SessionManager: (TODO) Received global session.update from frontend:", msg.session);
  }
}

function handleModelMessage(callId: string, data: RawData) {
  const session = getSession(callId, "handleModelMessage");
  if (!session) return;

  const event = parseMessage(data);
  if (!event) {
    console.error(`SessionManager: Failed to parse JSON message from old OpenAI model for call ${callId}:`, data.toString());
    return;
  }
  console.debug(`[${callId}] Received message from old OpenAI model: type '${event?.type}'`);
  jsonSend(globalFrontendConn || session.frontendConn, event);

  switch (event.type) {
    case "transcript":
      console.info(`[${callId}] Old OpenAI transcript (is_final: ${event.is_final}): ${event.text}`);
      break;
    case "error":
        console.error(`[${callId}] Old OpenAI model error: ${event.message}`);
        console.error(`SessionManager: Received error event from old OpenAI model for callId ${callId}:`, event.message || event);
        break;
  }
}

async function handleFunctionCall(callId: string, item: { name: string; arguments: string, call_id?: string }) {
  console.log(`SessionManager: Handling function call '${item.name}' for callId ${callId} (potentially old model). Args: ${item.arguments}`);
  const fnDef = functions.find((f) => f.schema.name === item.name);
  if (!fnDef) {
    const errorMsg = `No handler found for function '${item.name}' (callId: ${callId}).`;
    console.error(`SessionManager: ${errorMsg}`);
    throw new Error(errorMsg);
  }
  try {
    const args = JSON.parse(item.arguments);
    return await fnDef.handler(args);
  } catch (err: any) {
    console.error(`SessionManager: Error parsing arguments or executing function '${item.name}' for ${callId}:`, err);
    return JSON.stringify({ error: `Error in function ${item.name}: ${err.message}` });
  }
}

function closeModelConnection(callId: string) {
  const session = activeSessions.get(callId);
  if (session) {
    session.modelConn = undefined;
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

export function handleFrontendDisconnection() {
    if(isOpen(globalFrontendConn)) {
        globalFrontendConn.close();
    }
    globalFrontendConn = undefined;
    console.log("SessionManager: Global frontend WebSocket connection has been reset/cleared.");
}
