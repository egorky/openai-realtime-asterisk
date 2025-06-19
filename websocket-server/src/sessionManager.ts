import { RawData, WebSocket } from "ws";
import functions from "./functionHandlers";
import { CallSpecificConfig, OpenAIRealtimeAPIConfig } from "./types";
import { AriClientService } from "./ari-client";

interface CallSessionData {
  callId: string;
  ariClient: AriClientService;
  frontendConn?: WebSocket;
  modelConn?: WebSocket;
  openAIApiKey: string;
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

export function handleCallConnection(callId: string, openAIApiKey: string, ariClient: AriClientService) {
  if (activeSessions.has(callId)) {
    console.warn(`SessionManager: Call connection for ${callId} already exists. Cleaning up old OpenAI model if any.`);
    const oldSession = activeSessions.get(callId);
    if (oldSession?.modelConn && isOpen(oldSession.modelConn)) {
      oldSession.modelConn.close();
    }
  }

  console.log(`SessionManager: Handling call connection for channel: ${callId}`);
  const newSession: Partial<CallSessionData> = {
    callId,
    ariClient,
    openAIApiKey
  };
  activeSessions.set(callId, newSession as CallSessionData);
}

export async function startOpenAISession(callId: string, ariClient: AriClientService, config: CallSpecificConfig) {
  console.log(`SessionManager: Starting OpenAI session for callId ${callId}`);
  let session = activeSessions.get(callId);

  if (!session) {
    console.log(`SessionManager: No prior session data for ${callId}, creating new entry during startOpenAISession.`);
    // API key is part of ariClient instance now, assuming it's accessible if needed here
    // For this structure, ariClient itself has the api key, not passing separately.
    handleCallConnection(callId, ariClient['openaiApiKey' as any], ariClient);
    session = activeSessions.get(callId)!;
  } else {
    session.ariClient = ariClient; // Ensure ariClient is up-to-date
  }

  if (!session.openAIApiKey) { // Should be set by handleCallConnection
    console.error(`SessionManager: Cannot start OpenAI session for ${callId}. Missing OpenAI API key.`);
    throw new Error(`Missing OpenAI API key for callId ${callId}`);
  }
  if (isOpen(session.modelConn)) {
    console.warn(`SessionManager: OpenAI model connection for ${callId} already open.`);
    return;
  }

  session.config = config; // Store the full config

  try {
    const oaiConfig = config.openAIRealtimeAPI;
    const modelToUse = oaiConfig.model || "gpt-4o-realtime-preview-2024-12-17";

    console.log(`SessionManager: Connecting to OpenAI model: ${modelToUse} for callId ${callId}`);
    session.modelConn = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${modelToUse}`,
      {
        headers: { Authorization: `Bearer ${session.openAIApiKey}`, "OpenAI-Beta": "realtime=v1" },
      }
    );

    session.modelConn.on("open", () => {
      console.log(`SessionManager: OpenAI WebSocket opened for callId ${callId}.`);
      const sessionConfigPayload = {
        modalities: ["text", "audio"],
        turn_detection: { type: "server_vad" },
        voice: "ash", // TODO: make configurable from oaiConfig.voice if added
        input_audio_transcription: { model: "whisper-1" }, // TODO: make configurable
        input_audio_format: oaiConfig.inputAudioFormat || "g711_ulaw",
        input_audio_sample_rate: oaiConfig.inputAudioSampleRate || 8000,
        output_audio_format: oaiConfig.outputAudioFormat || "g711_ulaw",
        output_audio_sample_rate: oaiConfig.outputAudioSampleRate || 8000,
        language: oaiConfig.language, // Optional, will be undefined if not set
        ...(oaiConfig.saved_config || {}),
      };
      // Remove language if it's undefined, as OpenAI API might not like null/undefined for optional fields
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
      console.log(`SessionManager: OpenAI WebSocket closed for callId ${callId}. Code: ${code}, Reason: ${reason.toString()}`);
      // Check if ariClient initiated this close (e.g. openAIStreamingActive is false and no error)
      // This is tricky. For now, always notify. ari-client's _onOpenAISessionEnded can be idempotent.
      session.ariClient?._onOpenAISessionEnded(callId, reason.toString() || "Unknown reason");
      closeModelConnection(callId);
    });

  } catch (error) {
    console.error(`SessionManager: Error establishing OpenAI WebSocket for callId ${callId}:`, error);
    session.ariClient?._onOpenAIError(callId, error);
    throw error; // Re-throw so _activateOpenAIStreaming knows it failed
  }
}

export function stopOpenAISession(callId: string, reason: string) {
  console.log(`SessionManager: Stopping OpenAI session for callId ${callId}. Reason: ${reason}`);
  const session = activeSessions.get(callId);
  if (session && isOpen(session.modelConn)) {
    session.modelConn.close();
    console.log(`SessionManager: OpenAI WebSocket explicitly closed for ${callId}.`);
  }
  // Let the 'close' event handler manage clearing session.modelConn and notifying ariClient._onOpenAISessionEnded
}

export function sendAudioToOpenAI(callId: string, audioPayload: Buffer) {
  const session = activeSessions.get(callId);
  if (session && isOpen(session.modelConn)) {
    jsonSend(session.modelConn, { type: "input_audio_buffer.append", audio: audioPayload.toString('base64') });
  }
}

export function handleAriCallEnd(callId: string) {
  console.log(`SessionManager: ARI call ended for callId ${callId}. Cleaning up session.`);
  const session = activeSessions.get(callId);
  if (session) {
    if (isOpen(session.modelConn)) {
      console.log(`SessionManager: Closing OpenAI model connection (handleAriCallEnd) for callId ${callId}.`);
      session.modelConn.close();
    }
    if (session.frontendConn && isOpen(session.frontendConn)) {
         jsonSend(session.frontendConn, {type: "call_ended", callId: callId });
    }
    activeSessions.delete(callId);
  } else {
    console.warn(`SessionManager: Received ARI call end for unknown or already cleaned callId ${callId}.`);
  }
}

let globalFrontendConn: WebSocket | undefined;
export function handleFrontendConnection(ws: WebSocket) { /* ... */ }
function handleFrontendMessage(callId: string | null, data: RawData) { /* ... */ }

function handleModelMessage(callId: string, data: RawData) {
  const session = getSession(callId, "handleModelMessage");
  if (!session) return;

  const event = parseMessage(data);
  if (!event) return;

  jsonSend(globalFrontendConn || session.frontendConn, event);

  // OpenAI Realtime API v1 event handling
  // Ref: Based on typical structures, verify with actual API docs.
  switch (event.type) {
    case "transcript": // Assuming a 'transcript' event type
      // Check for speech_started based on ari-client's state via callback.
      // ari-client's _onOpenAISpeechStarted is idempotent.
      session.ariClient?._onOpenAISpeechStarted(callId);

      if (event.is_final === true && typeof event.text === 'string') {
        session.ariClient?._onOpenAIFinalResult(callId, event.text);
      } else if (typeof event.text === 'string') {
        session.ariClient?._onOpenAIInterimResult(callId, event.text);
      }
      break;

    // Example if OpenAI sends a more explicit speech started event
    case "input_audio_buffer.speech_started":
    case "speech.started": // Hypothetical more direct event
      session.ariClient?._onOpenAISpeechStarted(callId);
      break;

    case "response.audio.delta":
      if (session.ariClient && event.delta) {
        session.ariClient.playbackAudio(callId, event.delta);
      }
      break;

    case "response.output_item.done":
      const { item } = event;
      if (item?.type === "function_call") {
        handleFunctionCall(callId, item)
          .then((output) => {
            if(isOpen(session.modelConn)) {
              jsonSend(session.modelConn, {type: "conversation.item.create", item: {type: "function_call_output", call_id: item.call_id, output: JSON.stringify(output)}});
              jsonSend(session.modelConn, {type: "response.create"});
            }
          })
          .catch((err) => console.error(`SessionManager: Error handling function call for ${callId}:`, err));
      }
      break;

    case "error":
        console.error(`SessionManager: Received error event from OpenAI for callId ${callId}:`, event.message || event);
        session.ariClient?._onOpenAIError(callId, event.message || event);
        break;
  }
}

async function handleFunctionCall(callId: string, item: { name: string; arguments: string, call_id?: string }) { /* ... */ }

function closeModelConnection(callId: string) {
  const session = activeSessions.get(callId);
  if (session) { // Check if session exists before trying to clear modelConn
    session.modelConn = undefined; // Let the 'close' event on the WebSocket handle ariClient notification
  }
}

function parseMessage(data: RawData): any { try { return JSON.parse(data.toString()); } catch { console.error("SessionManager: Failed to parse JSON message:", data.toString()); return null; } }
function jsonSend(ws: WebSocket | undefined, obj: unknown) { if (isOpen(ws)) ws.send(JSON.stringify(obj)); }
function isOpen(ws?: WebSocket): ws is WebSocket { return !!ws && ws.readyState === WebSocket.OPEN; }
export function handleFrontendDisconnection() { /* ... */ }
