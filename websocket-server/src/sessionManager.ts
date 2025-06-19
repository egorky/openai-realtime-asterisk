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

// Placeholder for when ari-client signals call termination
export function handleAriCallEnd(channelId: string) {
  if (session.ariCallInfo && session.ariCallInfo.channelId === channelId) {
    console.log(`ARI call ended for channel: ${channelId}`);
    cleanupConnection(session.modelConn);
    session.modelConn = undefined;
    session.ariCallInfo = undefined;
    session.lastAssistantItem = undefined;
    session.responseStartTimestamp = undefined;
    session.latestMediaTimestamp = undefined; // Reset timestamp
    if (!session.frontendConn) session = {}; // Reset session if no frontend connected
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
  // console.log(`Received audio payload of length: ${audioPayload.length}`);
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
    jsonSend(session.modelConn, {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        turn_detection: { type: "server_vad" },
        voice: "ash",
        input_audio_transcription: { model: "whisper-1" },
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        ...config,
      },
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
          session.responseStartTimestamp = session.latestMediaTimestamp || 0; // Consider how latestMediaTimestamp is updated
        }
        if (event.item_id) session.lastAssistantItem = event.item_id;

        // console.log("Would send audio to ARI for playback:", event.delta);
        // This assumes ariCallInfo.client has a method like playbackAudio
        // The actual method might differ based on ari-client.ts implementation
        // For now, this is a placeholder for sending audio to Asterisk.
        // The event.delta is likely base64 encoded audio from OpenAI.
        // The ari-client will need to decode it if Asterisk expects raw audio.
        session.ariCallInfo.client.playbackAudio(session.ariCallInfo.channelId, event.delta);

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

function closeAllConnections() {
  // Close ARI connection (this might involve telling ari-client to hang up)
  if (session.ariCallInfo && session.ariCallInfo.client) {
    console.log("Closing all connections: Requesting hangup for channel", session.ariCallInfo.channelId);
    // session.ariCallInfo.client.hangupChannel(session.ariCallInfo.channelId); // Example method
    // Actual hangup should be managed by ari-client or a more specific function.
    // For now, just clearing the info.
    session.ariCallInfo = undefined;
  }

  if (session.modelConn) {
    session.modelConn.close();
    session.modelConn = undefined;
  }
  if (session.frontendConn) {
    session.frontendConn.close();
    session.frontendConn = undefined;
  }
  // session.streamSid is removed
  session.lastAssistantItem = undefined;
  session.responseStartTimestamp = undefined;
  session.latestMediaTimestamp = undefined;
  session.saved_config = undefined;
  // Ensure the entire session object is cleared if no frontend is connected,
  // or handled based on whether frontend expects to persist across calls.
  if (!session.frontendConn) {
    session = {};
  }
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
