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
import { initializeAriClient } from "./ari-client";

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
    if (currentLogs) currentLogs.close();
    currentLogs = ws;
    handleFrontendConnection(currentLogs);
  } else {
    ws.close();
  }
});

server.listen(PORT, HOST_IP, async () => {
  console.log(`Server running on http://${HOST_IP}:${PORT}`);
  if (HOST_IP === '0.0.0.0') { console.log('Server accessible on all network interfaces.'); }
  try {
    await initializeAriClient();
    console.log("ARI Client Initialized");
  } catch (error) {
    console.error("Failed to initialize ARI Client:", error);
    // Optionally, exit the process if ARI connection is critical
    // process.exit(1);
  }
});
