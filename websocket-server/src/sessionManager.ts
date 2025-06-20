import { RawData, WebSocket } from "ws";
import axios from 'axios'; // Added axios import
import functions from "./functionHandlers";
import { CallSpecificConfig, OpenAIRealtimeAPIConfig, AriClientInterface } from "./types"; // Added AriClientInterface
import { AriClientService } from "./ari-client"; // AriClientService might be more specific than AriClientInterface

// Define a type/interface for storing session information
interface OpenAISession {
  ws: WebSocket;
  ariClient: AriClientInterface; // Using the interface as requested
  callId: string;
  config: CallSpecificConfig; // Store config for potential use during the session
  // any other state for the session
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
    console.log(`SessionManager: OpenAI STT WebSocket connection established for callId ${callId}.`);
    ariClient._onOpenAISpeechStarted(callId); // Indicate stream is ready

    // Send initial configuration message to OpenAI STT WebSocket.
    // IMPORTANT: The exact structure of this message and whether it's needed
    // must be verified with the official OpenAI Realtime API documentation for WebSocket STT.
    // The following is a placeholder based on common patterns.
    const sttConfig = config.openAIRealtimeAPI;
    const initialSttConfigMessage = {
      // type: 'configure_stream', // Hypothetical type field, if required by OpenAI
      audio_attributes: { // Fictional structure, replace with actual
        content_type: sttConfig?.inputAudioFormat || 'audio/pcm;rate=16000', // Example mapping
        sample_rate: sttConfig?.inputAudioSampleRate || 16000,
        channels: 1, // Typically 1 for telephony
        encoding: sttConfig?.inputAudioFormat === 'pcm_s16le' ? 'pcm_s16le' : 'mulaw', // Or map to OpenAI specific terms
      },
      language: sttConfig?.language || 'en',
      interim_results: true, // Or make this configurable
      vad_enabled: true,     // Or make this configurable, if OpenAI supports server-side VAD tuning here
      // Any other parameters like 'end_of_speech_timeout_ms', etc.
    };

    if (ws.readyState === WebSocket.OPEN) {
      try {
        // ws.send(JSON.stringify(initialSttConfigMessage));
        // For subtask, log what would be sent:
        const loggerForOpen = newSession.ariClient.logger || console; // Get logger from session or fallback
        loggerForOpen.info(`OpenAI STT: Would send initial configuration message for callId ${callId}: ${JSON.stringify(initialSttConfigMessage)} (Actual send is commented out pending API spec)`);
      } catch (e: any) {
        const loggerForOpenError = newSession.ariClient.logger || console;
        loggerForOpenError.error(`OpenAI STT: Failed to send initial configuration message for callId ${callId}: ${e.message}`);
      }
    }
  });

  ws.on('message', (data: WebSocket.Data) => {
    try {
      const messageString = data.toString();
      // Assuming OpenAI STT sends JSON messages. This needs verification.
      // The exact structure of OpenAI's realtime STT messages needs to be handled here.
      // For now, let's assume a hypothetical structure and log it.
      console.debug(`[${callId}] Raw message from OpenAI STT: ${messageString}`);
      const response = JSON.parse(messageString); // This is a guess

      // Hypothetical: Adapt OpenAI response to the structure ari-client expects
      // This will need to be adjusted based on actual OpenAI STT API
      let transcript = "";
      let isFinal = false;
      let speechEventType: "SPEECH_ACTIVITY_BEGIN" | "SPEECH_ACTIVITY_END" | null = null;

      // Example adaptation (NEEDS ACTUAL API DOCS)
      if (response.transcript) { // Fictional field
          transcript = response.transcript;
      }
      if (response.is_final !== undefined) { // Fictional field
          isFinal = response.is_final;
      }
      if(response.event === "speech_start") speechEventType = "SPEECH_ACTIVITY_BEGIN";
      if(response.event === "speech_end") speechEventType = "SPEECH_ACTIVITY_END";


      // Log the processed/adapted message
      console.log(`[${callId}] Processed OpenAI STT message: Transcript='${transcript}', IsFinal=${isFinal}, Event=${speechEventType || 'none'}`);


      if (isFinal) {
        ariClient._onOpenAIFinalResult(callId, transcript);
      } else if (transcript) { // Only send interim if there's text
        ariClient._onOpenAIInterimResult(callId, transcript);
      }
      // If OpenAI sends explicit speech start/end events and they are mapped to speechEventType
      if (speechEventType === "SPEECH_ACTIVITY_BEGIN") {
         ariClient._onOpenAISpeechStarted(callId); // May be redundant if already called on 'open'
      }
      // TODO: Handle speech_end if OpenAI provides it and if ariClient needs it.
      // ariClient._onOpenAISpeechEnded(callId);

    } catch (e: any) {
      console.error(`SessionManager: Error processing message from OpenAI STT for callId ${callId}: ${e.message}. Data: ${data.toString()}`);
      ariClient._onOpenAIError(callId, new Error(`Failed to process STT message: ${e.message}`));
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
    // console.debug(`[${callId}] Sending audio chunk to OpenAI STT, length: ${audioPayload.length}`);
    session.ws.send(audioPayload); // Send raw buffer as per subtask example
  } else {
    // console.warn(`[${callId}] Cannot send audio to OpenAI STT: session not found or WebSocket not open. State: ${session?.ws?.readyState}`);
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

export async function synthesizeSpeechOpenAI(config: CallSpecificConfig, textToSpeak: string, callLogger: any /* or your specific logger type */): Promise<Buffer | null> {
  callLogger.info(`Attempting to synthesize speech for text: "${textToSpeak}"`);

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    callLogger.error('OpenAI API key is not set in environment variables.');
    return null;
  }

  const ttsConfig = config.openAIRealtimeAPI;
  if (!ttsConfig) {
      callLogger.error('OpenAI TTS configuration is missing.');
      return null;
  }

  const ttsUrl = `https://api.openai.com/v1/audio/speech`; // Standard URL, or use one from config if made configurable
  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  // Determine a suitable response_format. 'pcm' is preferred for raw audio if available.
  // OpenAI supports: mp3, opus, aac, flac, wav, pcm.
  // 'pcm' with s16le (signed 16-bit little-endian) is often good for Asterisk.
  // If 'pcm' is chosen, ensure sample rate matches what Asterisk expects for base64 playback.
  const responseFormat = ttsConfig.outputAudioFormat || 'mp3'; // Default to mp3 if not specified

  const body: any = { // Use 'any' for body to dynamically add sample_rate
    model: ttsConfig.ttsModel || 'tts-1', // Default model
    input: textToSpeak,
    voice: ttsConfig.ttsVoice || 'alloy',   // Default voice
    response_format: responseFormat,
    // speed: 1.0, // Optional: control speed
  };

  // OpenAI's API for PCM requires sample_rate if format is pcm or flac.
  // Let's refine the body for this.
  if (responseFormat === 'pcm' || responseFormat === 'flac') {
      if (ttsConfig.outputAudioSampleRate) {
          body.sample_rate = ttsConfig.outputAudioSampleRate;
      } else {
          // Default sample rate for PCM if not specified, e.g., 16000 or 24000
          // OpenAI's default for PCM is 24kHz.
          body.sample_rate = 24000;
           callLogger.warn(`No outputAudioSampleRate specified for PCM/FLAC, defaulting to 24000 Hz for OpenAI TTS.`);
      }
  }

  callLogger.debug(`OpenAI TTS Request: URL=${ttsUrl}, Model=${body.model}, Voice=${body.voice}, Format=${body.response_format}, SampleRate=${body.sample_rate || 'N/A'}`);

  try {
    const response = await axios.post(ttsUrl, body, { headers, responseType: 'arraybuffer' });
    callLogger.info(`OpenAI TTS request successful. Received audio buffer of length: ${response.data.byteLength}`);
    return Buffer.from(response.data);
  } catch (error: any) {
    if (axios.isAxiosError(error) && error.response) {
      callLogger.error(`OpenAI TTS API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
    } else {
      callLogger.error(`OpenAI TTS request error: ${error.message}`);
    }
    return null;
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
