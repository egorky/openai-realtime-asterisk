import { RawData, WebSocket } from "ws";
import functions from "./functionHandlers";
import { CallSpecificConfig, OpenAIRealtimeAPIConfig } from "./types";
import { AriClientService } from "./ari-client";

interface CallSessionData {
  callId: string;
  ariClient: AriClientService;
  frontendConn?: WebSocket;
  modelConn?: WebSocket;
  // openAIApiKey: string; // Removed - will come from config
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

export async function startOpenAISession(callId: string, ariClient: AriClientService, config: CallSpecificConfig) {
  console.log(`SessionManager: Attempting to start OpenAI session for callId ${callId}.`);
  let session = activeSessions.get(callId);

  const apiKeyToUse = config.openAIRealtimeAPI.apiKey;

  if (!apiKeyToUse) {
    console.error(`SessionManager: Cannot start OpenAI session for ${callId}. API key is missing in the provided configuration.`);
    throw new Error(`Missing OpenAI API key in config for callId ${callId}.`);
  }

  if (!session) {
    console.warn(`SessionManager: No prior session data found for ${callId} during startOpenAISession. Initializing with API key from config.`);
    // Initialize with ariClient, API key will be part of the config stored below.
    const newSessionData: Partial<CallSessionData> = { callId, ariClient };
    activeSessions.set(callId, newSessionData as CallSessionData);
    session = activeSessions.get(callId)!;
  } else {
    session.ariClient = ariClient;
  }

  if (isOpen(session.modelConn)) {
    console.warn(`SessionManager: OpenAI model connection for ${callId} is already open. No action taken.`);
    return;
  }

  session.config = config; // Store/update the full, resolved configuration for this session

  try {
    const oaiConfig = config.openAIRealtimeAPI;
    const modelToUse = oaiConfig.model || "gpt-4o-realtime-preview-2024-12-17";
    console.info(`[${callId}] Starting new OpenAI session. Model: ${modelToUse}, Language: ${oaiConfig.language || 'Not specified'}, Input Format: ${oaiConfig.inputAudioFormat || 'g711_ulaw'}@${oaiConfig.inputAudioSampleRate || 8000}, Output Format: ${oaiConfig.outputAudioFormat || 'g711_ulaw'}@${oaiConfig.outputAudioSampleRate || 8000}`);

    console.log(`SessionManager: Connecting to OpenAI model '${modelToUse}' for callId ${callId}.`);
    session.modelConn = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${modelToUse}`,
      {
        headers: { Authorization: `Bearer ${apiKeyToUse}`, "OpenAI-Beta": "realtime=v1" }, // Use apiKeyFromConfig
      }
    );

    session.modelConn.on("open", () => {
      console.log(`SessionManager: OpenAI WebSocket connection opened successfully for callId ${callId}.`);
      const sessionConfigPayload = {
        modalities: ["text", "audio"],
        turn_detection: { type: "server_vad" },
        voice: "ash",
        input_audio_transcription: { model: "whisper-1" },
        input_audio_format: oaiConfig.inputAudioFormat || "g711_ulaw",
        input_audio_sample_rate: oaiConfig.inputAudioSampleRate || 8000,
        output_audio_format: oaiConfig.outputAudioFormat || "g711_ulaw",
        output_audio_sample_rate: oaiConfig.outputAudioSampleRate || 8000,
        language: oaiConfig.language,
        ...(oaiConfig.saved_config || {}),
      };
      if (!sessionConfigPayload.language) {
        delete sessionConfigPayload.language;
      }
      console.log(`SessionManager: Sending session.update to OpenAI for callId ${callId}:`, JSON.stringify(sessionConfigPayload, null, 2));
      jsonSend(session.modelConn, { type: "session.update", session: sessionConfigPayload });
    });

    session.modelConn.on("message", (data) => handleModelMessage(callId, data));
    session.modelConn.on("error", (error) => {
      console.error(`SessionManager: OpenAI WebSocket error for callId ${callId}:`, error);
      session.ariClient?._onOpenAIError(callId, error);
      closeModelConnection(callId);
    });
    session.modelConn.on("close", (code, reason) => {
      const reasonStr = reason.toString() || "Unknown reason";
      console.log(`SessionManager: OpenAI WebSocket closed for callId ${callId}. Code: ${code}, Reason: ${reasonStr}`);
      session.ariClient?._onOpenAISessionEnded(callId, reasonStr);
      closeModelConnection(callId);
    });

  } catch (error) {
    console.error(`SessionManager: Exception during OpenAI WebSocket setup for callId ${callId}:`, error);
    session.ariClient?._onOpenAIError(callId, error);
    throw error;
  }
}

export function stopOpenAISession(callId: string, reason: string) {
  console.log(`SessionManager: Request to stop OpenAI session for callId ${callId}. Reason: ${reason}`);
  const session = activeSessions.get(callId);
  if (session && isOpen(session.modelConn)) {
    session.modelConn.close();
    console.log(`SessionManager: OpenAI WebSocket close() called for ${callId}.`);
  } else if (session) {
    console.log(`SessionManager: OpenAI WebSocket for ${callId} was already closed or not set when stop was requested.`);
  } else {
    console.warn(`SessionManager: stopOpenAISession called for ${callId}, but no active session data found.`);
  }
}

export function sendAudioToOpenAI(callId: string, audioPayload: Buffer) {
  const session = activeSessions.get(callId);
  if (session && isOpen(session.modelConn)) {
    console.debug(`[${callId}] Sending audio chunk to OpenAI, length: ${audioPayload.length}`);
    jsonSend(session.modelConn, { type: "input_audio_buffer.append", audio: audioPayload.toString('base64') });
  }
}

export function handleAriCallEnd(callId: string) {
  console.log(`SessionManager: ARI call ${callId} ended. Cleaning up associated session data.`);
  const session = activeSessions.get(callId);
  if (session) {
    if (isOpen(session.modelConn)) {
      console.log(`SessionManager: Closing any active OpenAI model connection for ended call ${callId}.`);
      session.modelConn.close();
    }
    if (session.frontendConn && isOpen(session.frontendConn)) {
         jsonSend(session.frontendConn, {type: "call_ended", callId: callId });
    }
    activeSessions.delete(callId);
    console.log(`SessionManager: Session data for callId ${callId} fully removed.`);
  } else {
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
    console.error(`SessionManager: Failed to parse JSON message from OpenAI for call ${callId}:`, data.toString());
    return;
  }
  console.debug(`[${callId}] Received message from OpenAI model: type '${event?.type}'`);
  jsonSend(globalFrontendConn || session.frontendConn, event);

  switch (event.type) {
    case "transcript":
      console.info(`[${callId}] OpenAI transcript (is_final: ${event.is_final}): ${event.text}`);
      session.ariClient._onOpenAISpeechStarted(callId);
      if (event.is_final === true && typeof event.text === 'string') {
        session.ariClient._onOpenAIFinalResult(callId, event.text);
      } else if (typeof event.text === 'string') {
        session.ariClient._onOpenAIInterimResult(callId, event.text);
      }
      break;
    case "speech.started":
      session.ariClient._onOpenAISpeechStarted(callId);
      break;
    case "response.audio.delta":
      console.debug(`[${callId}] OpenAI audio chunk received, length: ${event.delta?.length || 0}`);
      if (session.ariClient && event.delta && typeof event.delta === 'string') {
        session.ariClient.playbackAudio(callId, event.delta);
      }
      break;
    case "response.output_item.done":
      const { item } = event;
      if (item?.type === "function_call") {
        console.info(`[${callId}] OpenAI function call request: ${item.name}`);
        handleFunctionCall(callId, item)
          .then((output) => {
            if(isOpen(session.modelConn)) {
              jsonSend(session.modelConn, {type: "conversation.item.create", item: {type: "function_call_output", call_id: item.call_id, output: JSON.stringify(output)}});
              jsonSend(session.modelConn, {type: "response.create"});
            }
          })
          .catch((err) => console.error(`SessionManager: Error processing function call result for ${callId}:`, err));
      }
      break;
    case "error":
        console.error(`[${callId}] OpenAI model error: ${event.message}`);
        // The original detailed log is kept below as it includes the full event object.
        console.error(`SessionManager: Received error event from OpenAI for callId ${callId}:`, event.message || event);
        session.ariClient._onOpenAIError(callId, event.message || event);
        break;
  }
}

async function handleFunctionCall(callId: string, item: { name: string; arguments: string, call_id?: string }) {
  console.log(`SessionManager: Handling function call '${item.name}' for callId ${callId}. Args: ${item.arguments}`);
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
