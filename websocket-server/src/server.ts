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
import { initializeAriClient, ariClientServiceInstance } from "./ari-client"; // Importar ariClientServiceInstance

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

let currentCall: WebSocket | null = null;
let currentLogs: WebSocket | null = null;

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
    if (currentLogs && currentLogs !== ws) { // Asegurarse de no cerrar la misma conexión
        console.log("Closing previous /logs WebSocket connection.");
        currentLogs.close();
    }
    currentLogs = ws;
    console.log("/logs WebSocket client connected.");
    // Pasamos currentLogs a handleFrontendConnection para que sessionManager pueda usarlo si es necesario,
    // pero el manejo principal de session.update se hará aquí en server.ts para simplificar.
    handleFrontendConnection(currentLogs); // sessionManager lo usa para enviar eventos *al* frontend.

    currentLogs.on('message', async (message) => {
      try {
        const event = JSON.parse(message.toString());
        console.log("Received event from frontend (/logs):", JSON.stringify(event, null, 2));

        if (event.type === "session.update" && event.session) {
          if (ariClientServiceInstance) { // Importado de ari-client
            const primaryCallId = ariClientServiceInstance.getCurrentPrimaryCallId();
            if (primaryCallId) {
              console.log(`Applying session.update to primary callId: ${primaryCallId}`);

              const configToUpdate: { instructions?: string; ttsVoice?: string; tools?: any[] } = {};
              if (event.session.instructions) configToUpdate.instructions = event.session.instructions;
              // La webapp envía 'ttsVoice' directamente ahora después de su corrección.
              if (event.session.ttsVoice) configToUpdate.ttsVoice = event.session.ttsVoice;
              if (event.session.tools) configToUpdate.tools = event.session.tools;

              await ariClientServiceInstance.updateActiveCallConfig(primaryCallId, configToUpdate);
              // Enviar confirmación de vuelta al frontend
              if (currentLogs && currentLogs.readyState === WebSocket.OPEN) {
                currentLogs.send(JSON.stringify({ type: "config_update_ack", status: "processed", callId: primaryCallId, appliedConfig: event.session }));
              }

            } else {
              console.warn("No primary callId active to apply session.update.");
              if (currentLogs && currentLogs.readyState === WebSocket.OPEN) {
                currentLogs.send(JSON.stringify({ type: "error", message: "No active call to apply configuration." }));
              }
            }
          } else {
            console.error("ariClientServiceInstance is not available.");
             if (currentLogs && currentLogs.readyState === WebSocket.OPEN) {
                currentLogs.send(JSON.stringify({ type: "error", message: "Backend ARI service not available." }));
              }
          }
        }
      } catch (e) {
        console.error("Failed to parse message from frontend or handle event:", e);
        if (currentLogs && currentLogs.readyState === WebSocket.OPEN) {
            currentLogs.send(JSON.stringify({ type: "error", message: "Failed to process your request." }));
        }
      }
    });

    currentLogs.on('close', () => {
        console.log("/logs WebSocket client disconnected.");
        if (currentLogs === ws) { // Solo limpiar si es la conexión actual la que se cierra
            currentLogs = null;
        }
    });

    currentLogs.on('error', (error) => {
        console.error("/logs WebSocket error:", error);
        if (currentLogs === ws) { // Solo limpiar si es la conexión actual la que tiene error y se cierra
            currentLogs.close(); // Asegurar que se cierre
            currentLogs = null;
        }
    });

  } else {
    console.log(`Closing WebSocket connection for unknown path: ${req.url}`);
    ws.close();
  }
});

server.listen(PORT, HOST_IP, async () => {
  console.log(`Server running on http://${HOST_IP}:${PORT}`);
  if (HOST_IP === '0.0.0.0') { console.log('Server accessible on all network interfaces.'); }
  try {
    // initializeAriClient ya asigna a ariClientServiceInstance
    await initializeAriClient();
    if (ariClientServiceInstance) {
        console.log("ARI Client Initialized and instance is available.");
    } else {
        console.error("ARI Client initialized but instance is not available. This should not happen.");
    }
  } catch (error) {
    console.error("Failed to initialize ARI Client:", error);
    // Optionally, exit the process if ARI connection is critical
    // process.exit(1);
  }
});
