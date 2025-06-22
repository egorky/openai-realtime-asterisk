// ServerStatusIndicator.tsx
"use client";

import React from "react";
import { Card } from "@/components/ui/card";
import { Wifi, WifiOff, Phone, PhoneOff, AlertTriangle, Info } from "lucide-react";

type ServerStatusIndicatorProps = {
  isConnectedToLogs: boolean; // Reflects connection to /logs WebSocket
  ariCallStatus: "idle" | "active" | "ended" | "error";
  ariCallId?: string | null;
  ariCallerId?: string | null;
  ariErrorMessage?: string | null;
};

const ServerStatusIndicator: React.FC<ServerStatusIndicatorProps> = ({
  isConnectedToLogs,
  ariCallStatus,
  ariCallId,
  ariCallerId,
  ariErrorMessage,
}) => {
  let callStatusText = "Idle";
  let callStatusColor = "text-gray-700";
  let CallIcon = PhoneOff;

  if (ariCallStatus === "active") {
    callStatusText = `Active Call: ${ariCallerId || "Unknown"} (ID: ${ariCallId || "N/A"})`;
    callStatusColor = "text-green-700";
    CallIcon = Phone;
  } else if (ariCallStatus === "ended") {
    callStatusText = `Call Ended (ID: ${ariCallId || "N/A"})`;
    callStatusColor = "text-orange-700";
    CallIcon = PhoneOff;
  } else if (ariCallStatus === "error") {
    callStatusText = `Call Error (ID: ${ariCallId || "N/A"}) ${ariErrorMessage ? `- ${ariErrorMessage}` : ""}`;
    callStatusColor = "text-red-700";
    CallIcon = AlertTriangle;
  } else { // idle
    callStatusText = "No Active Call";
    callStatusColor = "text-gray-500";
    CallIcon = PhoneOff;
  }


  return (
    <Card className="p-3">
      <div className="flex items-center justify-between">
        <div className="flex flex-col">
          <span className="text-xs text-gray-500 mb-0.5">Server Connection</span>
          <div className="flex items-center">
            {isConnectedToLogs ? (
              <Wifi className="text-green-500 w-4 h-4 mr-1" />
            ) : (
              <WifiOff className="text-red-500 w-4 h-4 mr-1" />
            )}
            <span className={`text-sm font-medium ${isConnectedToLogs ? "text-green-700" : "text-red-700"}`}>
              {isConnectedToLogs ? "Live" : "Offline"}
            </span>
          </div>
        </div>

        <div className="h-8 border-l border-gray-300 mx-3"></div>

        <div className="flex flex-col flex-grow">
          <span className="text-xs text-gray-500 mb-0.5">Call Status</span>
          <div className="flex items-center">
            <CallIcon className={`${callStatusColor} w-4 h-4 mr-1`} />
            <span className={`text-sm font-medium ${callStatusColor} truncate` } title={callStatusText}>
              {callStatusText}
            </span>
          </div>
        </div>
      </div>
    </Card>
  );
};

export default ServerStatusIndicator;
