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
  console.log(`SessionManager: Attempting to start OpenAI STT session for callId ${callId}.`);

  if (activeOpenAISessions.has(callId)) {
    console.warn(`SessionManager: OpenAI STT session for ${callId} already exists. Closing old one.`);
    const oldSession = activeOpenAISessions.get(callId);
    if (oldSession?.ws && oldSession.ws.readyState === WebSocket.OPEN) {
      oldSession.ws.close(1000, "Starting new session");
    }
    activeOpenAISessions.delete(callId);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error(`SessionManager: CRITICAL - OPENAI_API_KEY not found in environment variables. Cannot start STT session for ${callId}.`);
    ariClient._onOpenAIError(callId, new Error("OPENAI_API_KEY not configured on server."));
    return;
  }

  const sttConfig = config.openAIRealtimeAPI;
  const localLogger = console; // Simplified logger for subtask context

  const baseUrl = "wss://api.openai.com/v1/realtime";
  let wsQueryString = "";

  if (sttConfig?.sttModel && sttConfig.sttModel.trim() !== "") {
    wsQueryString = `?model=${sttConfig.sttModel}`;
    // Example of adding language if it were a query param (OpenAI Realtime might take it in-band)
    // if (sttConfig.language) wsQueryString += `&language=${sttConfig.language}`;
  } else if (sttConfig?.transcriptionIntentOnly === true) {
    wsQueryString = `?intent=transcription`;
  } else {
    localLogger.error('OpenAI STT: sttModel or transcriptionIntentOnly not clearly configured. Defaulting to example model.');
    wsQueryString = `?model=gpt-4o-realtime-preview-2024-12-17`; // Default if not specified
  }
  const wsUrl = baseUrl + wsQueryString;

  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'OpenAI-Beta': 'realtime=v1'
  };

  console.info(`[${callId}] Connecting to OpenAI STT WebSocket: ${wsUrl.replace(apiKey, "****")}`);
  const ws = new WebSocket(wsUrl, { headers });

  const newSession: OpenAISession = { ws, ariClient, callId, config };
  activeOpenAISessions.set(callId, newSession);

  ws.on('open', () => {
    console.log(`SessionManager: OpenAI Realtime WebSocket connection established for callId ${callId}.`);
    // Do not call _onOpenAISpeechStarted here; wait for session.created or actual speech events.

    const sttConfig = config.openAIRealtimeAPI;
    const sessionLoggerForOpen = newSession.ariClient.logger || console;

    // IMPORTANT: The exact structure of this session.update message, especially audio_attributes,
    // must be verified with the official OpenAI Realtime API documentation.
    const sessionUpdateEvent = {
      type: "session.update",
      session: {
        input_audio_format: {
           encoding: sttConfig?.inputAudioFormat || 'pcm_s16le',
           sample_rate: sttConfig?.inputAudioSampleRate || 16000,
           channels: 1,
        },
        output_audio_format: {
           encoding: sttConfig?.outputAudioFormat || 'pcm_s16le',
           sample_rate: sttConfig?.outputAudioSampleRate || 24000,
           channels: 1,
        },
        voice: sttConfig?.ttsVoice || 'alloy',
        language: sttConfig?.language || "en",
        // instructions: "Your default system prompt here if any", // Example
      }
    };

    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(sessionUpdateEvent));
        sessionLoggerForOpen.info(`OpenAI Realtime: Sent session.update event for callId ${callId}: ${JSON.stringify(sessionUpdateEvent)}`);
      } catch (e: any) {
        sessionLoggerForOpen.error(`OpenAI Realtime: Failed to send session.update event for callId ${callId}: ${e.message}`);
      }
    }
  });

  ws.on('message', (data: RawData) => {
    let messageContent: string = '';
    const session = activeOpenAISessions.get(callId);
    if (!session) return;

    const ariClient = session.ariClient;
    const sessionLogger = ariClient.logger || console;

    if (Buffer.isBuffer(data)) {
      messageContent = data.toString('utf8');
    } else if (Array.isArray(data)) {
      try {
        messageContent = Buffer.concat(data).toString('utf8');
      } catch (e: any) {
        sessionLogger.error(`OpenAI Realtime WebSocket: Error concatenating Buffer array for callId ${callId}: ${e.message}`);
        messageContent = '';
      }
    } else if (data instanceof ArrayBuffer) {
      messageContent = Buffer.from(data).toString('utf8');
    } else {
      sessionLogger.error(`OpenAI Realtime WebSocket: Received unexpected data type for callId ${callId}.`);
      if (typeof data === 'string') {
         messageContent = data;
      } else if (data && typeof (data as any).toString === 'function') {
         messageContent = (data as any).toString();
         sessionLogger.warn(`OpenAI Realtime WebSocket: Used generic .toString() on unexpected data type for callId ${callId}.`);
      } else {
         messageContent = '';
         sessionLogger.error(`OpenAI Realtime WebSocket: Data for callId ${callId} has no .toString() method and is of unknown type.`);
      }
    }

    if (messageContent && messageContent.trim().length > 0) {
      try {
        const serverEvent = JSON.parse(messageContent);
        sessionLogger.debug(`[${callId}] OpenAI Server Event:`, serverEvent);

        switch (serverEvent.type) {
          case 'session.created':
            sessionLogger.info(`OpenAI session.created for ${callId}: ${JSON.stringify(serverEvent.session)}`);
            // if (!session.isReady) {
            //    ariClient._onOpenAISpeechStarted(callId);
            //    session.isReady = true;
            // }
            break;
          case 'response.text.delta':
            if (serverEvent.delta && typeof serverEvent.delta.text === 'string') {
              ariClient._onOpenAIInterimResult(callId, serverEvent.delta.text);
            }
            break;
          case 'response.done':
            sessionLogger.info(`OpenAI response.done for ${callId}.`);
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
                    const altTextOutput = serverEvent.response.output.find((item:any) => item.transcript); // Check for direct transcript field as fallback
                    if (altTextOutput) finalTranscriptText = altTextOutput.transcript;
                }
            }
            if (finalTranscriptText) {
              ariClient._onOpenAIFinalResult(callId, finalTranscriptText);
            }
            break;
          case 'response.audio.delta':
            if (serverEvent.delta && typeof serverEvent.delta.audio === 'string') {
              if (typeof ariClient._onOpenAIAudioChunk === 'function') {
                   ariClient._onOpenAIAudioChunk(callId, serverEvent.delta.audio, false); // isLast is false here
              } else {
                   sessionLogger.warn("ariClient._onOpenAIAudioChunk is not implemented yet.");
              }
            }
            break;
          case 'response.audio.done':
            sessionLogger.info(`OpenAI response.audio.done for ${callId}.`);
            // If _onOpenAIAudioChunk is used, this might be where you send the last chunk or signal completion.
            // For now, we assume response.done might be the primary end signal for a full turn.
            break;
          case 'input_audio_buffer.speech_started':
               sessionLogger.info(`OpenAI detected speech started for ${callId}`);
               ariClient._onOpenAISpeechStarted(callId); // Explicitly call on speech_started from OpenAI
               break;
          case 'input_audio_buffer.speech_stopped':
               sessionLogger.info(`OpenAI detected speech stopped for ${callId}`);
               // Potentially trigger requestOpenAIResponse here if auto-responding after user speech.
               break;
          case 'error':
            sessionLogger.error(`OpenAI Server Error for ${callId}:`, serverEvent.error || serverEvent);
            ariClient._onOpenAIError(callId, serverEvent.error || serverEvent);
            break;
          default:
            sessionLogger.debug(`OpenAI: Unhandled event type '${serverEvent.type}' for ${callId}.`);
        }
      } catch (e: any) {
        sessionLogger.error(`OpenAI Realtime WebSocket: Error parsing JSON message for callId ${callId}: ${e.message}. Raw content: "${messageContent}"`);
        ariClient._onOpenAIError(callId, new Error(`Failed to process STT message: ${e.message}`));
      }
    } else {
      if (messageContent !== '') {
          sessionLogger.warn(`OpenAI Realtime WebSocket: Message content was empty after conversion/trimming for callId ${callId}.`);
      }
    }
  });

  ws.on('error', (error: Error) => {
    console.error(`SessionManager: OpenAI STT WebSocket error for callId ${callId}:`, error);
    ariClient._onOpenAIError(callId, error);
    if (activeOpenAISessions.has(callId)) {
        activeOpenAISessions.delete(callId);
        // ws.close() is implicitly handled or will be attempted by the 'error' event itself.
    }
  });

  ws.on('close', (code: number, reason: Buffer) => {
    const reasonStr = reason.toString() || "Unknown reason";
    console.log(`SessionManager: OpenAI STT WebSocket closed for callId ${callId}. Code: ${code}, Reason: ${reasonStr}`);
    // ariClient._onOpenAISessionEnded should be called to inform ari-client,
    // but only if it wasn't already closed due to an error that also triggered cleanup.
    if (activeOpenAISessions.has(callId)) { // Check if not already cleaned up by 'error'
        ariClient._onOpenAISessionEnded(callId, reasonStr);
        activeOpenAISessions.delete(callId);
    }
  });
}

export function stopOpenAISession(callId: string, reason: string): void {
  console.log(`SessionManager: Request to stop OpenAI STT session for callId ${callId}. Reason: ${reason}`);
  const session = activeOpenAISessions.get(callId);
  if (session) {
    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
      console.log(`SessionManager: Closing OpenAI STT WebSocket for ${callId}.`);
      session.ws.close(1000, reason); // Normal closure
    } else {
      console.log(`SessionManager: OpenAI STT WebSocket for ${callId} was already closed or not in OPEN state.`);
    }
    // The 'close' event handler will call _onOpenAISessionEnded and delete from map.
    // However, to ensure immediate feedback if ws was not open, call it here if not already cleaned.
    if (activeOpenAISessions.has(callId)) {
        session.ariClient._onOpenAISessionEnded(callId, `Stopped by system: ${reason}`);
        activeOpenAISessions.delete(callId);
    }
  } else {
    console.warn(`SessionManager: stopOpenAISession called for ${callId}, but no active STT session data found.`);
  }
}

export function sendAudioToOpenAI(callId: string, audioPayload: Buffer): void {
  const session = activeOpenAISessions.get(callId);
  if (session && session.ws && session.ws.readyState === WebSocket.OPEN) {
    const base64AudioChunk = audioPayload.toString('base64');
    const audioEvent = { type: 'input_audio_buffer.append', audio: base64AudioChunk };
    try {
      session.ws.send(JSON.stringify(audioEvent));
    } catch (e:any) {
      const sessionLogger = session.ariClient.logger || console;
      sessionLogger.error(`[${callId}] Error sending audio event to OpenAI: ${e.message}`);
    }
  } else {
    // const sessionLogger = session?.ariClient?.logger || console;
    // sessionLogger.warn(`[${callId}] Cannot send audio to OpenAI: session not found or WebSocket not open. State: ${session?.ws?.readyState}`);
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
    session.ws.send(JSON.stringify(conversationItemCreateEvent));
    sessionLogger.info(`[${callId}] Sent conversation.item.create with user transcript.`);

    const responseCreateEvent = {
      type: "response.create",
      response: {
        modalities: ["audio", "text"] // Request both audio and text
        // voice: config.openAIRealtimeAPI?.ttsVoice || 'alloy', // Voice can also be set here or in session.update
        // output_audio_format: { ... } // Can also be set here or in session.update
      }
    };
    session.ws.send(JSON.stringify(responseCreateEvent));
    sessionLogger.info(`[${callId}] Sent response.create requesting audio and text.`);

  } catch (e:any) {
    sessionLogger.error(`[${callId}] Error sending request for OpenAI response: ${e.message}`);
  }
}

// This function might need to be split or adapted if the old activeSessions map is still in use for other things.
// For now, it will primarily clean up the new activeOpenAISessions.
export function handleAriCallEnd(callId: string) {
  console.log(`SessionManager: ARI call ${callId} ended. Cleaning up associated OpenAI STT session data.`);
  const openAISession = activeOpenAISessions.get(callId);
  if (openAISession) {
    if (openAISession.ws && openAISession.ws.readyState === WebSocket.OPEN) {
      console.log(`SessionManager: Closing active OpenAI STT connection for ended call ${callId}.`);
      openAISession.ws.close(1000, "Call ended");
    }
    activeOpenAISessions.delete(callId);
    console.log(`SessionManager: OpenAI STT session data for callId ${callId} removed.`);
  }

  // Preserve cleanup for the old session type if it's still relevant
  const oldSession = activeSessions.get(callId);
  if (oldSession) {
    if (isOpen(oldSession.modelConn)) {
      console.log(`SessionManager (Legacy): Closing any active old model connection for ended call ${callId}.`);
      oldSession.modelConn.close();
    }
    if (oldSession.frontendConn && isOpen(oldSession.frontendConn)) {
         jsonSend(oldSession.frontendConn, {type: "call_ended", callId: callId });
    }
    activeSessions.delete(callId);
    console.log(`SessionManager (Legacy): Old session data for callId ${callId} fully removed.`);
  } else if (!openAISession) { // Only log warning if neither new nor old session was found
    console.warn(`SessionManager: Received ARI call end for callId ${callId}, but no session data was found (already cleaned up or never existed).`);
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

// This function might need to be aware of whether it's interacting with an old session or a new OpenAISession
function handleFrontendMessage(callId: string | null, data: RawData) {
  const msg = parseMessage(data);
  if (!msg) return;
  const targetCallId = msg.callId || callId;

  if (targetCallId) {
    const session = getSession(targetCallId, "handleFrontendMessageTargeted"); // getSession currently returns CallSessionData
    // TODO: Adapt this if it needs to interact with the new activeOpenAISessions or if getSession is updated
    if (session && isOpen(session.modelConn) && msg.type !== "session.update") {
      jsonSend(session.modelConn, msg);
    } else if (session && msg.type === "session.update") {
      console.log(`SessionManager: (TODO) Received session.update from frontend for call ${targetCallId}:`, msg.session);
    }
  } else if (msg.type === "session.update") {
      console.log("SessionManager: (TODO) Received global session.update from frontend:", msg.session);
  }
}

// This function is specifically for the old model connection.
// A new handler for messages from OpenAI STT WebSocket is part of startOpenAISession.
function handleModelMessage(callId: string, data: RawData) {
  const session = getSession(callId, "handleModelMessage"); // This refers to the old CallSessionData
  if (!session) return;

  const event = parseMessage(data);
  if (!event) {
    console.error(`SessionManager: Failed to parse JSON message from old OpenAI model for call ${callId}:`, data.toString());
    return;
  }
  console.debug(`[${callId}] Received message from old OpenAI model: type '${event?.type}'`);
  jsonSend(globalFrontendConn || session.frontendConn, event);

  // This switch is for the old model's message types.
  // The new STT WebSocket messages are handled in its 'message' handler within startOpenAISession.
  switch (event.type) {
    case "transcript": // This case might be reused if the new STT also sends "transcript"
      console.info(`[${callId}] Old OpenAI transcript (is_final: ${event.is_final}): ${event.text}`);
      // session.ariClient._onOpenAISpeechStarted(callId); // This call might be different for new STT
      // if (event.is_final === true && typeof event.text === 'string') {
      //   session.ariClient._onOpenAIFinalResult(callId, event.text);
      // } else if (typeof event.text === 'string') {
      //   session.ariClient._onOpenAIInterimResult(callId, event.text);
      // }
      break;
    // ... other cases for the old model ...
    case "error":
        console.error(`[${callId}] Old OpenAI model error: ${event.message}`);
        console.error(`SessionManager: Received error event from old OpenAI model for callId ${callId}:`, event.message || event);
        // session.ariClient._onOpenAIError(callId, event.message || event); // This call might be different for new STT
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

// Removing the axios-based synthesizeSpeechOpenAI as TTS audio is expected via WebSocket events
// import axios from 'axios'; // Ensure this is removed if not used elsewhere, already done at top.

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
