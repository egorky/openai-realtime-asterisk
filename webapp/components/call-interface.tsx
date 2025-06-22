"use client";

import React, { useState, useEffect } from "react";
import TopBar from "@/components/top-bar";
import ChecklistAndConfig from "@/components/checklist-and-config";
import SessionConfigurationPanel from "@/components/session-configuration-panel";
import Transcript from "@/components/transcript";
import FunctionCallsPanel from "@/components/function-calls-panel";
import { Item } from "@/components/types";
import handleRealtimeEvent, { AriCallInfo } from "@/lib/handle-realtime-event"; // Import AriCallInfo
import ServerStatusIndicator from "@/components/server-status-indicator";

const CallInterface = () => {
  const [allConfigsReady, setAllConfigsReady] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [logsWsStatus, setLogsWsStatus] = useState("disconnected"); // "connected" or "disconnected" to /logs WS
  const [ws, setWs] = useState<WebSocket | null>(null);
  const [ariCallInfo, setAriCallInfo] = useState<AriCallInfo>({ // New state for ARI call info
    status: "idle",
    callId: null,
    callerId: null,
  });

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
        setLogsWsStatus("connected");
      };

      newWs.onerror = (error) => {
        console.error("Logs websocket error:", error);
        setLogsWsStatus("error");
      };

      newWs.onmessage = (event) => {
        const data = JSON.parse(event.data);
        // console.log("Received logs event from backend:", data);
        handleRealtimeEvent(data, setItems, setAriCallInfo); // Pass setAriCallInfo
      };

      newWs.onclose = () => {
        console.log("Logs websocket disconnected from", wsUrl);
        setWs(null);
        setLogsWsStatus("disconnected");
        // Reset ARI info on WS disconnect as well, as we lose connection to the source of this info
        setAriCallInfo({ status: "idle", callId: null, callerId: null, errorMessage: "WebSocket disconnected" });
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
      />
      <TopBar ariCallInfo={ariCallInfo} /> {/* Pass ariCallInfo to TopBar */}
      <div className="flex-grow p-4 h-full overflow-hidden flex flex-col">
        <div className="grid grid-cols-12 gap-4 h-full">
          {/* Left Column */}
          <div className="col-span-3 flex flex-col h-full overflow-hidden">
            <SessionConfigurationPanel
              callStatus={logsWsStatus} // This reflects /logs WS connection
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
            <ServerStatusIndicator
              isConnectedToLogs={logsWsStatus === "connected"}
              ariCallStatus={ariCallInfo?.status || "idle"} // Pass ARI call status
              ariCallId={ariCallInfo?.callId}
              ariCallerId={ariCallInfo?.callerId}
              ariErrorMessage={ariCallInfo?.errorMessage}
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
