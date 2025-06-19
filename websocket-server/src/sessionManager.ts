import { RawData, WebSocket } from "ws";
import functions from "./functionHandlers";

// Define AriCallInfo as any for now, will be refined later
type AriCallInfo = any;

interface Session {
  ariCallInfo?: AriCallInfo;
  frontendConn?: WebSocket;
  modelConn?: WebSocket;
  saved_config?: any;
  lastAssistantItem?: string;
  responseStartTimestamp?: number;
  latestMediaTimestamp?: number; // This might still be useful for timing VAD or other logic
  openAIApiKey?: string;
}

let session: Session = {};

export function handleCallConnection(channelId: string, openAIApiKey: string, ariClient: any) {
  // If there's an existing ARI call, we might need to clean it up or handle it.
  // For now, let's assume one call at a time.
  if (session.ariCallInfo) {
    console.log("Cleaning up previous ARI call info for channel:", session.ariCallInfo.channelId);
    // Actual cleanup (e.g., hangup) should be managed by ari-client or explicitly called
  }

  session.ariCallInfo = { channelId, client: ariClient };
  session.openAIApiKey = openAIApiKey;
  session.latestMediaTimestamp = 0; // Reset timestamp for the new call

  console.log(`ARI call connection established for channel: ${channelId}`);
  tryConnectModel(); // Attempt to connect to OpenAI model once ARI call is established

  // The 'close' event for an ARI call will be signaled by the ari-client,
  // which should then call a specific function in sessionManager, e.g., handleAriCallEnd(channelId).
  // For now, direct ws.on('close') is removed as the WebSocket is not directly managed here for call state.
}

export function handleAriCallEnd(channelId: string) {
  console.log(`ARI call ended for channel: ${channelId}. Cleaning up session.`);
  if (session.ariCallInfo && session.ariCallInfo.channelId === channelId) {
    // If the ended call is the one sessionManager is aware of, clean up

    // Close the OpenAI model connection
    if (isOpen(session.modelConn)) {
      console.log(`Closing OpenAI model connection for channel ${channelId}.`);
      session.modelConn.close();
    }
    session.modelConn = undefined; // Ensure it's cleared

    // Clear ARI related info
    session.ariCallInfo = undefined;

    // Reset other session state related to an active call
    session.lastAssistantItem = undefined;
    session.responseStartTimestamp = undefined;
    session.latestMediaTimestamp = undefined;
    // session.openAIApiKey = undefined; // Keep API key if it's global, or clear if per-call

    // If no frontend is connected, reset the entire session state.
    // If a frontend is connected, we keep it alive but clear call-specific data.
    if (!session.frontendConn) {
      console.log("No frontend connection, resetting entire session.");
      session = {};
    } else {
      console.log("Frontend connection active, only clearing call-specific session data.");
      // Send a message to frontend if needed, e.g., { type: "call_ended" }
      jsonSend(session.frontendConn, {type: "call_ended", channelId: channelId });
    }
  } else if (session.ariCallInfo) {
    console.warn(`Received call end for channel ${channelId}, but current session is for ${session.ariCallInfo.channelId}. No action taken for this event.`);
  } else {
    console.warn(`Received call end for channel ${channelId}, but no active ARI call info in session. No action taken.`);
  }
}


export function handleFrontendConnection(ws: WebSocket) {
  cleanupConnection(session.frontendConn);
  session.frontendConn = ws;

  ws.on("message", handleFrontendMessage);
  ws.on("close", () => {
    cleanupConnection(session.frontendConn);
    session.frontendConn = undefined;
    if (!session.ariCallInfo && !session.modelConn) session = {};
  });
}

// This function will be called by ari-client.ts with audio from Asterisk
export function handleAriAudioMessage(audioPayload: Buffer) {
  console.log(`handleAriAudioMessage: Received audio payload of length ${audioPayload.length} bytes.`);
  if (isOpen(session.modelConn)) {
    // Assuming audioPayload is raw PCM, convert to base64 for OpenAI
    // The actual format (e.g., G.711 ulaw) will determine if direct base64 is okay
    // or if transcoding/header addition is needed. OpenAI expects specific formats.
    // For now, let's assume it's correctly formatted and just needs base64 encoding.
    const base64Audio = audioPayload.toString('base64');
    jsonSend(session.modelConn, {
      type: "input_audio_buffer.append",
      audio: base64Audio,
    });
    // We might need a timestamp mechanism if `latestMediaTimestamp` is used by other logic (e.g., truncation)
    // For now, this is simplified.
  }
}

async function handleFunctionCall(item: { name: string; arguments: string }) {
  console.log("Handling function call:", item);
  const fnDef = functions.find((f) => f.schema.name === item.name);
  if (!fnDef) {
    throw new Error(`No handler found for function: ${item.name}`);
  }

  let args: unknown;
  try {
    args = JSON.parse(item.arguments);
  } catch {
    return JSON.stringify({
      error: "Invalid JSON arguments for function call.",
    });
  }

  try {
    console.log("Calling function:", fnDef.schema.name, args);
    const result = await fnDef.handler(args as any);
    return result;
  } catch (err: any) {
    console.error("Error running function:", err);
    return JSON.stringify({
      error: `Error running function ${item.name}: ${err.message}`,
    });
  }
}

// handleTwilioMessage is removed as audio will come via handleAriAudioMessage

function handleFrontendMessage(data: RawData) {
  const msg = parseMessage(data);
  if (!msg) return;

  if (isOpen(session.modelConn)) {
    jsonSend(session.modelConn, msg);
  }

  if (msg.type === "session.update") {
    session.saved_config = msg.session;
  }
}

function tryConnectModel() {
  if (!session.ariCallInfo || !session.ariCallInfo.channelId || !session.openAIApiKey)
    return;
  if (isOpen(session.modelConn)) return;

  session.modelConn = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
    {
      headers: {
        Authorization: `Bearer ${session.openAIApiKey}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  session.modelConn.on("open", () => {
    const config = session.saved_config || {};
    const sessionConfigPayload = {
      modalities: ["text", "audio"],
      turn_detection: { type: "server_vad" },
      voice: "ash",
      input_audio_transcription: { model: "whisper-1" },
      input_audio_format: "g711_ulaw", // Log this
      output_audio_format: "g711_ulaw", // Log this
      ...config,
    };
    console.log("tryConnectModel: Sending session.update to OpenAI with config:", JSON.stringify(sessionConfigPayload, null, 2));
    jsonSend(session.modelConn, {
      type: "session.update",
      session: sessionConfigPayload,
    });
  });

  session.modelConn.on("message", handleModelMessage);
  session.modelConn.on("error", closeModel);
  session.modelConn.on("close", closeModel);
}

function handleModelMessage(data: RawData) {
  const event = parseMessage(data);
  if (!event) return;

  jsonSend(session.frontendConn, event);

  switch (event.type) {
    case "input_audio_buffer.speech_started":
      handleTruncation();
      break;

    case "response.audio.delta":
      if (session.ariCallInfo && session.ariCallInfo.client && session.ariCallInfo.channelId) {
        if (session.responseStartTimestamp === undefined) {
          session.responseStartTimestamp = session.latestMediaTimestamp || 0;
        }
        if (event.item_id) session.lastAssistantItem = event.item_id;

        const audioDelta = event.delta; // This is typically base64 encoded audio from OpenAI
        console.log(`handleModelMessage: Received response.audio.delta of length ${audioDelta?.length || 0}. Format from OpenAI is implicitly ${session.saved_config?.output_audio_format || 'g711_ulaw'}.`);

        session.ariCallInfo.client.playbackAudio(session.ariCallInfo.channelId, audioDelta);

        // The "mark" event was Twilio-specific for media stream synchronization.
        // It's unclear if an equivalent is needed or available with ARI external media.
        // For now, it's removed.
      }
      break;

    case "response.output_item.done": {
      const { item } = event;
      if (item.type === "function_call") {
        handleFunctionCall(item)
          .then((output) => {
            if (session.modelConn) {
              jsonSend(session.modelConn, {
                type: "conversation.item.create",
                item: {
                  type: "function_call_output",
                  call_id: item.call_id,
                  output: JSON.stringify(output),
                },
              });
              jsonSend(session.modelConn, { type: "response.create" });
            }
          })
          .catch((err) => {
            console.error("Error handling function call:", err);
          });
      }
      break;
    }
  }
}

function handleTruncation() {
  if (
    !session.lastAssistantItem ||
    session.responseStartTimestamp === undefined
  )
    return;

  const elapsedMs =
    (session.latestMediaTimestamp || 0) - (session.responseStartTimestamp || 0);
  const audio_end_ms = elapsedMs > 0 ? elapsedMs : 0;

  if (isOpen(session.modelConn)) {
    jsonSend(session.modelConn, {
      type: "conversation.item.truncate",
      item_id: session.lastAssistantItem,
      content_index: 0,
      audio_end_ms,
    });
  }

  // The "clear" event was Twilio-specific.
  // We'll need to determine if an equivalent action is needed for Asterisk/OpenAI.
  // For now, the direct sending of "clear" is removed.
  // if (session.ariCallInfo && session.ariCallInfo.channelId) {
  //   console.log("Truncation occurred, consider if any ARI action is needed for channel:", session.ariCallInfo.channelId);
  // }

  session.lastAssistantItem = undefined;
  session.responseStartTimestamp = undefined;
}

function closeModel() {
  cleanupConnection(session.modelConn);
  session.modelConn = undefined;
  if (!session.ariCallInfo && !session.frontendConn) session = {};
}

function closeAllConnections() { // This function is now more of a "reset global session"
  console.log("closeAllConnections called. Resetting global session state.");

  // If there's an active ARI call tracked by the session, request its termination.
  if (session.ariCallInfo && session.ariCallInfo.client && session.ariCallInfo.channelId) {
    console.log(`Requesting ariClient to end call for channel ${session.ariCallInfo.channelId}.`);
    session.ariCallInfo.client.endCall(session.ariCallInfo.channelId);
    // Note: ariClient.endCall will trigger cleanupCallResources, which in turn calls handleAriCallEnd.
    // So, some cleanup might be redundant or needs careful ordering if called directly after.
    // For now, we expect handleAriCallEnd to manage session state clearing.
  }
  session.ariCallInfo = undefined; // Clear it here too for good measure

  if (isOpen(session.modelConn)) {
    console.log("Closing model connection.");
    session.modelConn.close();
  }
  session.modelConn = undefined;

  if (isOpen(session.frontendConn)) {
    console.log("Closing frontend connection.");
    session.frontendConn.close();
  }
  session.frontendConn = undefined;

  // Reset all other session variables
  session.lastAssistantItem = undefined;
  session.responseStartTimestamp = undefined;
  session.latestMediaTimestamp = undefined;
  session.saved_config = undefined;
  session.openAIApiKey = undefined; // Clear API key on full reset

  // Fully reset session object
  session = {};
}

function cleanupConnection(ws?: WebSocket) {
  if (isOpen(ws)) ws.close();
}

function parseMessage(data: RawData): any {
  try {
    return JSON.parse(data.toString());
  } catch {
    return null;
  }
}

function jsonSend(ws: WebSocket | undefined, obj: unknown) {
  if (!isOpen(ws)) return;
  ws.send(JSON.stringify(obj));
}

function isOpen(ws?: WebSocket): ws is WebSocket {
  return !!ws && ws.readyState === WebSocket.OPEN;
}
