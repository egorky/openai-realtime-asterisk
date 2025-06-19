"use client";

import React, { useState, useEffect } from "react";
import TopBar from "@/components/top-bar";
import ChecklistAndConfig from "@/components/checklist-and-config";
import SessionConfigurationPanel from "@/components/session-configuration-panel";
import Transcript from "@/components/transcript";
import FunctionCallsPanel from "@/components/function-calls-panel";
import { Item } from "@/components/types";
import handleRealtimeEvent from "@/lib/handle-realtime-event";
import ServerStatusIndicator from "@/components/server-status-indicator"; // Updated import

const CallInterface = () => {
  // Removed selectedPhoneNumber state
  const [allConfigsReady, setAllConfigsReady] = useState(false); // This is now set by ChecklistAndConfig
  const [items, setItems] = useState<Item[]>([]);
  const [callStatus, setCallStatus] = useState("disconnected"); // "connected" or "disconnected" to /logs WS
  const [ws, setWs] = useState<WebSocket | null>(null);

  const websocketServerBaseUrl = process.env.NEXT_PUBLIC_WEBSOCKET_SERVER_BASE_URL;

  useEffect(() => {
    if (allConfigsReady && !ws && websocketServerBaseUrl) {
      // Construct WebSocket URL for /logs
      let wsUrl = websocketServerBaseUrl.replace(/^http/, 'ws');
      if (!wsUrl.startsWith('ws://') && !wsUrl.startsWith('wss://')) {
        // Default to ws if no protocol, or handle error
        console.warn("WebSocket URL defaulting to ws:// scheme as none was provided in base URL");
        wsUrl = 'ws://' + wsUrl.split('://').pop();
      }
      wsUrl = `${wsUrl}/logs`;

      console.log("Attempting to connect to WebSocket at:", wsUrl);
      const newWs = new WebSocket(wsUrl);

      newWs.onopen = () => {
        console.log("Connected to logs websocket at", wsUrl);
        setCallStatus("connected");
      };

      newWs.onerror = (error) => {
        console.error("Logs websocket error:", error);
        // setCallStatus("error"); // Or handle error state appropriately
      };

      newWs.onmessage = (event) => {
        const data = JSON.parse(event.data);
        // console.log("Received logs event:", data); // Potentially too verbose
        handleRealtimeEvent(data, setItems);
      };

      newWs.onclose = () => {
        console.log("Logs websocket disconnected from", wsUrl);
        setWs(null);
        setCallStatus("disconnected");
        // Optionally, you might want to set allConfigsReady to false to re-trigger checklist
        // if the connection is critical and was previously established.
        // setAllConfigsReady(false);
      };

      setWs(newWs);
    } else if (!websocketServerBaseUrl && allConfigsReady && !ws) {
      console.error("NEXT_PUBLIC_WEBSOCKET_SERVER_BASE_URL is not set. Cannot connect to WebSocket.");
    }
  }, [allConfigsReady, ws, websocketServerBaseUrl]);

  return (
    <div className="h-screen bg-white flex flex-col">
      {/* ChecklistAndConfig is a modal dialog, it will show itself if !allConfigsReady */}
      <ChecklistAndConfig
        ready={allConfigsReady}
        setReady={setAllConfigsReady}
        // selectedPhoneNumber and setSelectedPhoneNumber props removed
      />
      <TopBar />
      <div className="flex-grow p-4 h-full overflow-hidden flex flex-col">
        <div className="grid grid-cols-12 gap-4 h-full">
          {/* Left Column */}
          <div className="col-span-3 flex flex-col h-full overflow-hidden">
            <SessionConfigurationPanel
              callStatus={callStatus} // This reflects /logs WS connection
              onSave={(config) => {
                if (ws && ws.readyState === WebSocket.OPEN) {
                  const updateEvent = {
                    type: "session.update",
                    session: {
                      ...config,
                    },
                  };
                  console.log("Sending session.update event:", updateEvent);
                  ws.send(JSON.stringify(updateEvent));
                }
              }}
            />
          </div>

          {/* Middle Column: Transcript */}
          <div className="col-span-6 flex flex-col gap-4 h-full overflow-hidden">
            {/* Use ServerStatusIndicator and pass the actual /logs WS connection status */}
            <ServerStatusIndicator
              isConnectedToLogs={callStatus === "connected"}
            />
            <Transcript items={items} />
          </div>

          {/* Right Column: Function Calls */}
          <div className="col-span-3 flex flex-col h-full overflow-hidden">
            <FunctionCallsPanel items={items} ws={ws} />
          </div>
        </div>
      </div>
    </div>
  );
};

export default CallInterface;
