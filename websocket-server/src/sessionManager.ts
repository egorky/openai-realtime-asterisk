import { RawData, WebSocket } from "ws";
import functions from "./functionHandlers";
import { CallSpecificConfig, OpenAIRealtimeAPIConfig } from "./types";
import { AriClientService } from "./ari-client"; // Import concrete class for type safety

/**
 * Defines the structure for storing data related to an active call session managed by SessionManager.
 * This includes its connection to OpenAI, its associated AriClientService instance, and configuration.
 */
interface CallSessionData {
  callId: string;                      // The unique ID for the call (usually Asterisk channel ID)
  ariClient: AriClientService;         // Instance of AriClientService handling this call's ARI interactions
  frontendConn?: WebSocket;             // Optional: WebSocket connection to a specific frontend instance for this call
  modelConn?: WebSocket;                // WebSocket connection to OpenAI Realtime API for this call
  openAIApiKey: string;                // OpenAI API key for this session
  config: CallSpecificConfig;          // The resolved configuration for this call
  lastAssistantItemId?: string;         // ID of the last item from the assistant, for truncation
  responseStartTimestamp?: number;      // Timestamp when OpenAI started sending response audio, for truncation
}

/**
 * Manages active call sessions, mapping call IDs to their session data.
 * This allows handling multiple concurrent calls, each with its own OpenAI connection.
 */
const activeSessions = new Map<string, CallSessionData>();

/**
 * Retrieves the session data for a given call ID.
 * @param callId - The ID of the call.
 * @param operation - Description of the operation requesting the session, for logging.
 * @returns The CallSessionData if found, otherwise undefined.
 */
function getSession(callId: string, operation: string): CallSessionData | undefined {
  const session = activeSessions.get(callId);
  if (!session) {
    // Using console.error directly as this module doesn't have its own logger instance passed around easily
    console.error(`SessionManager: ${operation} failed. No active session found for callId ${callId}.`);
  }
  return session;
}

/**
 * Initializes basic session information when a new call is established on the ARI side.
 * This function is called by AriClientService when a call starts.
 * @param callId - The unique ID of the new call.
 * @param openAIApiKey - The OpenAI API key to be used for this call.
 * @param ariClient - The instance of AriClientService managing this call.
 */
export function handleCallConnection(callId: string, openAIApiKey: string, ariClient: AriClientService) {
  if (activeSessions.has(callId)) {
    console.warn(`SessionManager: Call connection for ${callId} already exists. Will clean up old OpenAI model if any and re-initialize.`);
    const oldSession = activeSessions.get(callId);
    if (oldSession?.modelConn && isOpen(oldSession.modelConn)) {
      oldSession.modelConn.close(); // Close any lingering OpenAI connection for this callId
    }
  }

  console.log(`SessionManager: Initializing session data for call: ${callId}`);
  // Store essential info. Full config and modelConn will be set by startOpenAISession.
  const newSessionData: Partial<CallSessionData> = {
    callId,
    ariClient,
    openAIApiKey
  };
  activeSessions.set(callId, newSessionData as CallSessionData); // Cast, config will be added
}

/**
 * Establishes the WebSocket connection to OpenAI Realtime API for a specific call and sends initial configuration.
 * This is called by AriClientService when it determines the OpenAI stream should be activated.
 * @param callId - The ID of the call.
 * @param ariClient - The AriClientService instance (re-passed to ensure it's current, though already stored in handleCallConnection).
 * @param config - The call-specific configuration to be used for the OpenAI session.
 * @throws Error if session setup fails critically (e.g., missing API key).
 */
export async function startOpenAISession(callId: string, ariClient: AriClientService, config: CallSpecificConfig) {
  console.log(`SessionManager: Attempting to start OpenAI session for callId ${callId}.`);
  let session = activeSessions.get(callId);

  if (!session) {
    // This case might occur if handleCallConnection wasn't called or session was prematurely deleted.
    console.warn(`SessionManager: No prior session data for ${callId} during startOpenAISession. Re-initializing.`);
    // Attempt to get API key from the passed ariClient instance if possible (ugly access, ideally API key is passed explicitly if this path is common)
    const apiKey = (ariClient as any).openaiApiKey || ''; // Accessing private member, not ideal
    handleCallConnection(callId, apiKey, ariClient);
    session = activeSessions.get(callId)!; // Should exist now
    if (!apiKey) console.error(`SessionManager: Re-initialized session for ${callId} but API key might be missing.`);
  } else {
    session.ariClient = ariClient; // Ensure the ariClient instance is current
  }

  if (!session.openAIApiKey) {
    console.error(`SessionManager: Cannot start OpenAI session for ${callId}. Missing OpenAI API key.`);
    throw new Error(`Missing OpenAI API key for callId ${callId}. Cannot connect to OpenAI.`);
  }
  if (isOpen(session.modelConn)) {
    console.warn(`SessionManager: OpenAI model connection for ${callId} is already open. No action taken.`);
    return; // Avoid re-opening an existing connection
  }

  session.config = config; // Store the full, resolved configuration for this session

  try {
    const oaiConfig = config.openAIRealtimeAPI;
    const modelToUse = oaiConfig.model || "gpt-4o-realtime-preview-2024-12-17"; // Default model

    console.log(`SessionManager: Connecting to OpenAI model '${modelToUse}' for callId ${callId}.`);
    session.modelConn = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${modelToUse}`,
      {
        headers: { Authorization: `Bearer ${session.openAIApiKey}`, "OpenAI-Beta": "realtime=v1" },
      }
    );

    // --- WebSocket Event Handlers for OpenAI Connection ---
    session.modelConn.on("open", () => {
      console.log(`SessionManager: OpenAI WebSocket connection opened successfully for callId ${callId}.`);
      const sessionConfigPayload = {
        modalities: ["text", "audio"], // TODO: Make configurable via session.config if needed
        turn_detection: { type: "server_vad" }, // TODO: Make configurable
        voice: "ash", // TODO: Make configurable (e.g., session.config.openAIRealtimeAPI.voice)
        input_audio_transcription: { model: "whisper-1" }, // TODO: Make configurable
        input_audio_format: oaiConfig.inputAudioFormat || "g711_ulaw", // Ensure these are from resolved config
        input_audio_sample_rate: oaiConfig.inputAudioSampleRate || 8000,
        output_audio_format: oaiConfig.outputAudioFormat || "g711_ulaw",
        output_audio_sample_rate: oaiConfig.outputAudioSampleRate || 8000,
        language: oaiConfig.language,
        ...(oaiConfig.saved_config || {}), // Include any other custom parameters
      };
      // OpenAI API might be particular about null/undefined optional fields.
      if (!sessionConfigPayload.language) {
        delete sessionConfigPayload.language; // Remove if not set, rather than sending undefined
      }
      console.log(`SessionManager: Sending session.update to OpenAI for callId ${callId}:`, JSON.stringify(sessionConfigPayload, null, 2));
      jsonSend(session.modelConn, { type: "session.update", session: sessionConfigPayload });
    });

    session.modelConn.on("message", (data) => handleModelMessage(callId, data)); // Process incoming messages

    session.modelConn.on("error", (error) => {
      console.error(`SessionManager: OpenAI WebSocket error for callId ${callId}:`, error);
      session.ariClient?._onOpenAIError(callId, error); // Notify ari-client
      closeModelConnection(callId); // Cleans up local modelConn reference
    });

    session.modelConn.on("close", (code, reason) => {
      const reasonStr = reason.toString() || "Unknown reason";
      console.log(`SessionManager: OpenAI WebSocket closed for callId ${callId}. Code: ${code}, Reason: ${reasonStr}`);
      // Notify ari-client about the closure. AriClientService's _onOpenAISessionEnded should be idempotent.
      session.ariClient?._onOpenAISessionEnded(callId, reasonStr);
      closeModelConnection(callId); // Cleans up local modelConn reference
    });

  } catch (error) { // Catch errors during WebSocket object creation itself
    console.error(`SessionManager: Exception during OpenAI WebSocket setup for callId ${callId}:`, error);
    session.ariClient?._onOpenAIError(callId, error); // Notify ari-client of the failure
    throw error; // Re-throw so _activateOpenAIStreaming in ari-client knows connection failed
  }
}

/**
 * Closes the OpenAI WebSocket connection for a specific call, if open.
 * Called by AriClientService when it needs to explicitly stop the stream (e.g., DTMF interrupt, timeout).
 * @param callId - The ID of the call whose OpenAI session should be stopped.
 * @param reason - A descriptive reason for stopping the session.
 */
export function stopOpenAISession(callId: string, reason: string) {
  console.log(`SessionManager: Request to stop OpenAI session for callId ${callId}. Reason: ${reason}`);
  const session = activeSessions.get(callId);
  if (session && isOpen(session.modelConn)) {
    session.modelConn.close(); // This will trigger the 'close' event handler defined in startOpenAISession
    console.log(`SessionManager: OpenAI WebSocket close() called for ${callId}.`);
  } else if (session) {
    console.log(`SessionManager: OpenAI WebSocket for ${callId} already closed or not set.`);
    // If already closed, modelConn would be undefined by its 'close' handler.
    // We still might want to inform ariClient if it doesn't know yet.
    // session.ariClient?._onOpenAISessionEnded(callId, reason || "Already closed when stop requested");
  } else {
    console.warn(`SessionManager: stopOpenAISession called for ${callId}, but no active session data found.`);
  }
}

/**
 * Sends an audio payload (assumed to be raw PCM from Asterisk) to the active OpenAI session for a call.
 * @param callId - The ID of the call.
 * @param audioPayload - The raw audio data as a Buffer.
 */
export function sendAudioToOpenAI(callId: string, audioPayload: Buffer) {
  const session = activeSessions.get(callId);
  if (session && isOpen(session.modelConn)) {
    // Audio is base64 encoded for JSON transport over WebSocket.
    jsonSend(session.modelConn, { type: "input_audio_buffer.append", audio: audioPayload.toString('base64') });
  }
  // No warning if not open/active, as ari-client controls when to send based on its state.
}

/**
 * Cleans up session data when an ARI call ends.
 * This is called by AriClientService from its _fullCleanup method.
 * @param callId - The ID of the call that has ended.
 */
export function handleAriCallEnd(callId: string) {
  console.log(`SessionManager: ARI call ${callId} ended. Cleaning up associated session data.`);
  const session = activeSessions.get(callId);
  if (session) {
    if (isOpen(session.modelConn)) {
      console.log(`SessionManager: Closing active OpenAI model connection for ended call ${callId}.`);
      session.modelConn.close(); // Triggers 'close' handler which notifies ariClient and clears modelConn
    }
    // Notify frontend if this specific call had a dedicated frontend connection (not current model)
    if (session.frontendConn && isOpen(session.frontendConn)) {
         jsonSend(session.frontendConn, {type: "call_ended", callId: callId });
    }
    activeSessions.delete(callId); // Remove the session from the map
    console.log(`SessionManager: Session data for callId ${callId} fully removed.`);
  } else {
    console.warn(`SessionManager: Received ARI call end for callId ${callId}, but no session data was found (already cleaned or never existed).`);
  }
}

// --- Global Frontend Connection Management (Simplified for now) ---
// TODO: Refactor for per-call frontend connections if needed. Current model is one global frontend.
let globalFrontendConn: WebSocket | undefined;

export function handleFrontendConnection(ws: WebSocket) {
  if (isOpen(globalFrontendConn)) globalFrontendConn.close(); // Close any existing global connection
  globalFrontendConn = ws;
  console.log("SessionManager: Global frontend WebSocket connected.");
  ws.on("message", (data) => handleFrontendMessage(null, data)); // Null callId for global messages
  ws.on("close", () => {
    globalFrontendConn = undefined;
    console.log("SessionManager: Global frontend WebSocket disconnected.");
  });
}

function handleFrontendMessage(callId: string | null, data: RawData) {
  const msg = parseMessage(data);
  if (!msg) return;

  // This logic needs refinement if messages from frontend are call-specific vs global.
  // For now, assuming most messages from frontend might target a specific call if callId was part of message,
  // or are global session updates.
  const targetCallId = msg.callId || callId; // If message contains callId, use it.

  if (targetCallId) {
    const session = getSession(targetCallId, "handleFrontendMessageTargeted");
    if (session && isOpen(session.modelConn) && msg.type !== "session.update") { // Forward non-config messages
      jsonSend(session.modelConn, msg);
    } else if (session && msg.type === "session.update") {
      // TODO: Handle per-call session config updates if needed.
      // session.config.openAIRealtimeAPI.saved_config = msg.session;
      console.log(`SessionManager: (TODO) session.update from frontend for call ${targetCallId}:`, msg.session);
    }
  } else if (msg.type === "session.update") { // Global config update
      // TODO: Store this globally for future calls if that's the design.
      console.log("SessionManager: (TODO) Global session.update from frontend:", msg.session);
  }
}

/**
 * Processes messages received from the OpenAI WebSocket for a specific call.
 * @param callId - The ID of the call this message pertains to.
 * @param data - The raw message data from OpenAI.
 */
function handleModelMessage(callId: string, data: RawData) {
  const session = getSession(callId, "handleModelMessage");
  if (!session) return; // Session might have been cleaned up

  const event = parseMessage(data);
  if (!event) {
    console.error(`SessionManager: Failed to parse message from OpenAI for call ${callId}:`, data.toString());
    return;
  }

  // Forward all events to the frontend (global or call-specific if frontendConn is per-call)
  jsonSend(globalFrontendConn || session.frontendConn, event);

  // Invoke callbacks on AriClientService based on OpenAI event type
  // Note: Specific event types and structures depend on OpenAI's Realtime API version.
  // These are examples based on common patterns.
  switch (event.type) {
    case "transcript": // Example: { type: "transcript", text: "...", is_final: boolean }
      session.ariClient._onOpenAISpeechStarted(callId); // Notify speech has (likely) started
      if (event.is_final === true && typeof event.text === 'string') {
        session.ariClient._onOpenAIFinalResult(callId, event.text);
      } else if (typeof event.text === 'string') {
        session.ariClient._onOpenAIInterimResult(callId, event.text);
      }
      break;

    case "speech.started": // Example: If OpenAI sends an explicit speech_started event
      session.ariClient._onOpenAISpeechStarted(callId);
      break;

    case "response.audio.delta": // Example: Audio chunk from OpenAI
      if (session.ariClient && event.delta) { // Assuming delta contains base64 audio
        session.ariClient.playbackAudio(callId, event.delta);
      }
      break;

    case "response.output_item.done": // Example: Function call result or other output item
      const { item } = event;
      if (item?.type === "function_call") {
        handleFunctionCall(callId, item)
          .then((output) => {
            if(isOpen(session.modelConn)) { // Check if connection still open
              jsonSend(session.modelConn, {type: "conversation.item.create", item: {type: "function_call_output", call_id: item.call_id, output: JSON.stringify(output)}});
              jsonSend(session.modelConn, {type: "response.create"}); // Request next response from OpenAI
            }
          })
          .catch((err) => console.error(`SessionManager: Error during function call execution for ${callId}:`, err));
      }
      break;

    case "error": // Example: Explicit error event from OpenAI
        console.error(`SessionManager: Received error event from OpenAI for callId ${callId}:`, event.message || event);
        session.ariClient._onOpenAIError(callId, event.message || event); // Notify ari-client
        break;

    // Add cases for other relevant OpenAI event types
  }
}

/** Handles execution of function calls defined in functionHandlers.ts */
async function handleFunctionCall(callId: string, item: { name: string; arguments: string, call_id?: string }) {
  console.log(`SessionManager: Handling function call '${item.name}' for callId ${callId} with args: ${item.arguments}`);
  const fnDef = functions.find((f) => f.schema.name === item.name);
  if (!fnDef) {
    console.error(`SessionManager: No handler found for function '${item.name}' (callId: ${callId}).`);
    throw new Error(`No handler for function: ${item.name}`);
  }
  try {
    const args = JSON.parse(item.arguments);
    return await fnDef.handler(args); // Execute the function
  } catch (err: any) {
    console.error(`SessionManager: Error parsing arguments or executing function '${item.name}' for ${callId}:`, err);
    return JSON.stringify({ error: `Error in function ${item.name}: ${err.message}` }); // Return error as stringified JSON
  }
}

/** Helper to clean up local reference to modelConn, typically called from WS 'close' or 'error' handlers. */
function closeModelConnection(callId: string) {
  const session = activeSessions.get(callId);
  if (session) {
    session.modelConn = undefined; // Mark as undefined, actual close is handled by WS event
  }
}

// --- Utility Functions ---
function parseMessage(data: RawData): any { try { return JSON.parse(data.toString()); } catch { console.error("SessionManager: Failed to parse JSON message:", data.toString()); return null; } }
function jsonSend(ws: WebSocket | undefined, obj: unknown) { if (isOpen(ws)) ws.send(JSON.stringify(obj)); }
function isOpen(ws?: WebSocket): ws is WebSocket { return !!ws && ws.readyState === WebSocket.OPEN; }

/** Handles disconnection of the global frontend client. */
export function handleFrontendDisconnection() {
    if(isOpen(globalFrontendConn)) {
        globalFrontendConn.close();
    }
    globalFrontendConn = undefined;
    console.log("SessionManager: Global frontend WebSocket connection reset by client disconnect.");
}
[end of websocket-server/src/sessionManager.ts]
