import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { IncomingMessage } from "http";
import dotenv from "dotenv";
import http from "http";
import cors from "cors";
import {
  handleCallConnection,
  handleFrontendConnection,
} from "./sessionManager";
import functions from "./functionHandlers";
import { initializeAriClient, ariClientServiceInstance } from "./ari-service"; // Importar desde ari-service
import { ActiveCallInfo } from "./ari-call-resources"; // Importar tipo directamente
import { getConversationHistory } from "./redis-client"; // Importar la nueva función

dotenv.config();

const PORT = parseInt(process.env.PORT || "8081", 10);
const HOST_IP = process.env.WEBSOCKET_SERVER_HOST_IP || '0.0.0.0';
const PUBLIC_URL = process.env.PUBLIC_URL || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

if (!OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY environment variable is required");
  process.exit(1);
}

const app = express();
app.use(cors());
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.urlencoded({ extended: false }));

app.get("/public-url", (req, res) => {
  res.json({ publicUrl: PUBLIC_URL });
});

// New endpoint to list available tools (schemas)
app.get("/tools", (req, res) => {
  res.json(functions.map((f) => f.schema));
});

let currentCall: WebSocket | null = null; // This seems unused now, consider removing if not needed elsewhere.
// let currentLogs: WebSocket | null = null; // Replaced by logClients Set
const logClients = new Set<WebSocket>();


wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
  console.log(`Incoming WebSocket connection attempt from ${req.socket.remoteAddress}, path: ${req.url}`);
  const url = new URL(req.url || "", `http://${req.headers.host}`);
  const parts = url.pathname.split("/").filter(Boolean);

  if (parts.length < 1) {
    ws.close();
    return;
  }

  const type = parts[0];

  // The "call" WebSocket connection type is removed as call establishment is now handled via ARI.
  // The frontend/webapp connects via the "logs" type.
  if (type === "logs") {
    logClients.add(ws);
    console.log("/logs WebSocket client connected. Total clients:", logClients.size);

    // Send the current list of active calls to the newly connected client
    if (ariClientServiceInstance) {
      const currentCalls = ariClientServiceInstance.getFormattedActiveCalls();
      ws.send(JSON.stringify({ type: 'active_calls_list', payload: currentCalls }));
    }

    // Pass this specific ws client to handleFrontendConnection if sessionManager needs to send targeted messages.
    // For now, sessionManager.handleFrontendConnection might not be necessary if all frontend comms are through server.ts
    // handleFrontendConnection(ws);

    ws.on('message', async (message) => {
      try {
        const event = JSON.parse(message.toString());
        console.log("Received event from frontend (/logs):", JSON.stringify(event, null, 2));

        // TODO: Adapt session.update to handle callId from the frontend event
        // For now, it applies to primaryCallId, or a specific callId if provided in event.
        if (event.type === "session.update" && event.session) {
          if (ariClientServiceInstance) {
            // If the frontend sends a callId, use it. Otherwise, fallback to primaryCallId.
            // This prepares for targeted configuration updates.
            const targetCallId = event.callId || ariClientServiceInstance.getCurrentPrimaryCallId();

            if (targetCallId) {
              console.log(`Applying session.update to callId: ${targetCallId}`);

              // Prepare config for updateActiveCallConfig which now accepts more params
              const configToUpdate: any = { ...event.session }; // Adapt as per new updateActiveCallConfig signature
                                                              // e.g. instructions, ttsVoice, tools, and new recognition params

              await ariClientServiceInstance.updateActiveCallConfig(targetCallId, configToUpdate);
              // Enviar confirmación de vuelta al frontend
              ws.send(JSON.stringify({ type: "config_update_ack", status: "processed", callId: targetCallId, appliedConfig: event.session }));
            } else {
              console.warn("No target callId (specific or primary) active to apply session.update.");
              ws.send(JSON.stringify({ type: "error", message: "No active call to apply configuration." }));
            }
          } else {
            console.error("ariClientServiceInstance is not available.");
            ws.send(JSON.stringify({ type: "error", message: "Backend ARI service not available." }));
          }
        } else if (event.type === "get_call_configuration" && event.callId) {
          if (ariClientServiceInstance) {
            const config = ariClientServiceInstance.getSpecificCallConfiguration(event.callId);
            if (config) {
              ws.send(JSON.stringify({ type: "call_configuration", callId: event.callId, payload: config }));
            } else {
              ws.send(JSON.stringify({ type: "error", callId: event.callId, message: "Could not retrieve configuration for the specified callId." }));
            }
          } else {
            ws.send(JSON.stringify({ type: "error", callId: event.callId, message: "Backend ARI service not available." }));
          }
        } else if (event.type === "get_conversation_history" && event.callId) {
          try {
            const history = await getConversationHistory(event.callId);
            // getConversationHistory returns [] if no history, null on error.
            if (history !== null) {
              ws.send(JSON.stringify({ type: "conversation_history", callId: event.callId, payload: history }));
            } else {
              // Error already logged by getConversationHistory if redisClient is available
              ws.send(JSON.stringify({ type: "error", callId: event.callId, message: "Could not retrieve conversation history due to a server error." }));
            }
          } catch (historyError: any) {
            console.error(`Error fetching conversation history for ${event.callId}:`, historyError);
            ws.send(JSON.stringify({ type: "error", callId: event.callId, message: `Failed to get history: ${historyError.message}` }));
          }
        }
        // Handle other event types from frontend if necessary
      } catch (e) {
        console.error("Failed to parse message from frontend or handle event:", e);
        ws.send(JSON.stringify({ type: "error", message: "Failed to process your request." }));
      }
    });

    ws.on('close', () => {
        logClients.delete(ws);
        console.log("/logs WebSocket client disconnected. Total clients:", logClients.size);
    });

    ws.on('error', (error) => {
        console.error("/logs WebSocket error:", error);
        logClients.delete(ws); // Ensure removal on error
        // ws.close(); // The 'close' event should follow 'error' for cleanup
        console.log("/logs WebSocket client removed due to error. Total clients:", logClients.size);
    });

  } else {
    console.log(`Closing WebSocket connection for unknown path: ${req.url}`);
    ws.close();
  }
});


// Function to broadcast active calls list to all connected log clients
function broadcastActiveCallsList(activeCalls: ActiveCallInfo[]) {
  const message = JSON.stringify({ type: 'active_calls_list', payload: activeCalls });
  logClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(message);
      } catch (e) {
        console.error("Error sending active_calls_list to a client:", e);
      }
    }
  });
}


server.listen(PORT, HOST_IP, async () => {
  console.log(`Server running on http://${HOST_IP}:${PORT}`);
  if (HOST_IP === '0.0.0.0') { console.log('Server accessible on all network interfaces.'); }
  try {
    await initializeAriClient();
    if (ariClientServiceInstance) {
        console.log("ARI Client Initialized and instance is available.");
        // Set the callback in AriClientService
        ariClientServiceInstance.setActiveCallsChangedCallback(broadcastActiveCallsList);
        console.log('Callback for active calls changes set in AriClientService.');
    } else {
        console.error("ARI Client initialized but instance is not available. This should not happen.");
    }
  } catch (error) {
    console.error("Failed to initialize ARI Client:", error);
    // process.exit(1);
  }
});

export function sendGenericEventToFrontend(event: any) {
  // If the event is specific to a callId, and we want to target only frontends interested in that callId,
  // this broadcast approach might need refinement. For now, it sends to all /logs clients.
  if (logClients.size > 0) {
    console.log("Broadcasting generic event to frontend clients:", JSON.stringify(event, null, 2));
    const message = JSON.stringify(event);
    logClients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(message);
        } catch (e) {
          console.error("Error sending generic event to a client:", e);
        }
      }
    });
  } else {
    console.warn("Cannot send generic event to frontend, no /logs WebSocket clients connected or open.");
  }
}
