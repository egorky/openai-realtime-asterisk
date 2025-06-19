// ServerStatusIndicator.tsx
"use client";

import React from "react";
import { Card } from "@/components/ui/card";
import { CheckCircle, Circle, Wifi, WifiOff } from "lucide-react";

type ServerStatusIndicatorProps = {
  isConnectedToLogs: boolean; // Reflects connection to /logs WebSocket
  // Removed allConfigsReady and setAllConfigsReady as the checklist dialog is now separate
};

const ServerStatusIndicator: React.FC<ServerStatusIndicatorProps> = ({
  isConnectedToLogs,
}) => {
  return (
    <Card className="flex items-center justify-between p-4">
      <div className="flex flex-col">
        <span className="text-sm text-gray-500">Backend Status</span>
        <div className="flex items-center">
          <span className="font-medium">
            {isConnectedToLogs ? "Connected to Server" : "Disconnected"}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-2">
        {isConnectedToLogs ? (
          <Wifi className="text-green-500 w-5 h-5" />
        ) : (
          <WifiOff className="text-red-500 w-5 h-5" />
        )}
        <span className={`text-sm ${isConnectedToLogs ? "text-green-700" : "text-red-700"}`}>
          {isConnectedToLogs ? "Live" : "Offline"}
        </span>
      </div>
    </Card>
  );
};

export default ServerStatusIndicator;
