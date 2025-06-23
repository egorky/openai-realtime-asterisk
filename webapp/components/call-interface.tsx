"use client";

import React, { useState, useEffect } from "react";
import TopBar from "@/components/top-bar";
import ChecklistAndConfig from "@/components/checklist-and-config";
import SessionConfigurationPanel from "@/components/session-configuration-panel";
import Transcript from "@/components/transcript";
import FunctionCallsPanel from "@/components/function-calls-panel";
import { Item } from "@/components/types";
import handleRealtimeEvent, { AriCallInfo, ActiveCallListItem } from "@/lib/handle-realtime-event"; // Import AriCallInfo and ActiveCallListItem
import ServerStatusIndicator from "@/components/server-status-indicator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";


const CallInterface = () => {
  const [allConfigsReady, setAllConfigsReady] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [logsWsStatus, setLogsWsStatus] = useState("disconnected");
  const [ws, setWs] = useState<WebSocket | null>(null);

  // AriCallInfo might represent the primary/globally focused call or the selected call's detailed info
  const [ariCallInfo, setAriCallInfo] = useState<AriCallInfo>({
    status: "idle",
    callId: null,
    callerId: null,
  });

  const [activeCallsList, setActiveCallsList] = useState<ActiveCallListItem[]>([]);
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);

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
        // Pass selectedCallId to handleRealtimeEvent for context-aware updates (e.g. for history)
        handleRealtimeEvent(data, setItems, setAriCallInfo, setActiveCallsList, selectedCallId);
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
      <TopBar ariCallInfo={ariCallInfo} />
      <div className="flex-grow p-4 h-full overflow-hidden flex flex-col">
        {/* Selector de Llamadas Activas */}
        {activeCallsList.length > 0 && (
          <div className="mb-4 p-2 border rounded-md">
            <label htmlFor="active-call-selector" className="block text-sm font-medium text-gray-700 mb-1">
              Select Active Call:
            </label>
            <Select
              value={selectedCallId || ""}
              onValueChange={(value) => {
                setSelectedCallId(value);
                // Actualizar ariCallInfo para reflejar la llamada seleccionada
                const callDetails = activeCallsList.find(c => c.callId === value);
                if (callDetails) {
                  setAriCallInfo({
                    status: callDetails.status as AriCallInfo['status'],
                    callId: callDetails.callId,
                    callerId: callDetails.callerId || null,
                  });
                  setItems([]); // Limpiar transcripción actual
                  if (ws && ws.readyState === WebSocket.OPEN && value) {
                    console.log(`Requesting conversation history for callId: ${value}`);
                    ws.send(JSON.stringify({ type: "get_conversation_history", callId: value }));
                  }
                } else if (!value) { // Si se deselecciona (ej. placeholder)
                  setAriCallInfo({ status: "idle", callId: null, callerId: null });
                  setItems([]);
                }
              }}
            >
              <SelectTrigger id="active-call-selector" className="w-full">
                <SelectValue placeholder="Select a call..." />
              </SelectTrigger>
              <SelectContent>
                {activeCallsList.map((call) => (
                  <SelectItem key={call.callId} value={call.callId}>
                    {call.callerId || call.callId} (Status: {call.status}, Start: {call.startTime ? new Date(call.startTime).toLocaleTimeString() : 'N/A'})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="grid grid-cols-12 gap-4 h-full">
          {/* Left Column */}
          {/* REMOVED overflow-hidden to allow child ScrollArea to manage its own overflow */}
          <div className="col-span-3 flex flex-col h-full">
            <SessionConfigurationPanel
              callStatus={logsWsStatus}
              selectedCallId={selectedCallId}
              ws={ws} // Pasar la instancia de WebSocket
              onSave={(config) => {
                if (ws && ws.readyState === WebSocket.OPEN && selectedCallId) {
                  const updateEvent = {
                    type: "session.update",
                    callId: selectedCallId, // Enviar el callId para la configuración
                    session: {
                      ...config, // instructions, ttsVoice, tools, y nuevos params de reconocimiento
                    },
                  };
                  console.log("Sending session.update event for call", selectedCallId, updateEvent);
                  ws.send(JSON.stringify(updateEvent));
                } else if (!selectedCallId) {
                  console.warn("Cannot save session config: No call selected.");
                  // TODO: Mostrar un mensaje al usuario
                }
              }}
            />
          </div>

          {/* Middle Column: Transcript */}
          <div className="col-span-6 flex flex-col gap-4 h-full overflow-hidden">
            <ServerStatusIndicator
              isConnectedToLogs={logsWsStatus === "connected"}
              ariCallStatus={ariCallInfo?.status || "idle"}
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
