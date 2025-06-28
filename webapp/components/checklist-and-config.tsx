"use client";

import React, { useEffect, useState, useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Circle, CheckCircle, Loader2 } from "lucide-react";
// Removed PhoneNumber type and Select imports as they are no longer used.

export default function ChecklistAndConfig({
  ready,
  setReady,
}: {
  ready: boolean;
  setReady: (val: boolean) => void;
  // Removed selectedPhoneNumber and setSelectedPhoneNumber props
}) {
  const [websocketServerReachable, setWebsocketServerReachable] =
    useState(false);
  const [checkingServer, setCheckingServer] = useState(false);
  const [allChecksPassed, setAllChecksPassed] = useState(false);

  const websocketServerBaseUrl =
    process.env.NEXT_PUBLIC_WEBSOCKET_SERVER_BASE_URL;

  const checkWebsocketServer = async () => {
    if (!websocketServerBaseUrl) {
      console.error(
        "NEXT_PUBLIC_WEBSOCKET_SERVER_BASE_URL is not defined in .env"
      );
      setWebsocketServerReachable(false);
      return;
    }
    setCheckingServer(true);
    try {
      // Attempt to fetch tools or any simple health check endpoint
      const response = await fetch(`${websocketServerBaseUrl}/tools`);
      if (response.ok) {
        setWebsocketServerReachable(true);
      } else {
        setWebsocketServerReachable(false);
      }
    } catch (error) {
      console.error("Failed to reach websocket server:", error);
      setWebsocketServerReachable(false);
    } finally {
      setCheckingServer(false);
    }
  };

  useEffect(() => {
    // Automatically check server status when the dialog is shown (i.e., !ready)
    if (!ready) {
      checkWebsocketServer();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]); // Only re-run if ready changes (e.g. dialog opens)

  const checklist = useMemo(() => {
    return [
      {
        label: "Connect to WebSocket Server",
        done: websocketServerReachable,
        description: `Ensures the backend server at ${websocketServerBaseUrl} is running and accessible.`,
        field: (
          <Button
            variant="outline"
            onClick={checkWebsocketServer}
            disabled={checkingServer || !websocketServerBaseUrl}
            className="w-full"
          >
            {checkingServer ? (
              <Loader2 className="mr-2 h-4 animate-spin" />
            ) : (
              "Check Server Connection"
            )}
          </Button>
        ),
      },
      {
        label: "Asterisk Configuration",
        done: true, // This is a placeholder, webapp can't verify Asterisk directly
        description:
          "Ensure your Asterisk server is properly configured and connected to the WebSocket server's ARI interface.",
        field: null, // No direct action from webapp
      },
    ];
  }, [websocketServerReachable, checkingServer, websocketServerBaseUrl]);

  useEffect(() => {
    setAllChecksPassed(checklist.every((item) => item.done));
  }, [checklist]);

  // If all checks pass, automatically set ready to true
  // This simplifies the user flow as they don't need to click "Let's go!" if everything is fine.
  useEffect(() => {
    if (allChecksPassed) {
      setReady(true);
    }
  }, [allChecksPassed, setReady]);


  const handleDone = () => {
    if (allChecksPassed) {
      setReady(true);
    } else {
      // Optionally, re-check or prompt user
      checkWebsocketServer();
    }
  };

  // If already ready, don't render the dialog
  if (ready) {
    return null;
  }

  return (
    <Dialog open={!ready}>
      <DialogContent className="w-full max-w-[800px]">
        <DialogHeader>
          <DialogTitle>Setup Checklist</DialogTitle>
          <DialogDescription>
            Please ensure the following steps are completed to use the
            application.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-4 space-y-0">
          {checklist.map((item, i) => (
            <div
              key={i}
              className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 py-2"
            >
              <div className="flex flex-col">
                <div className="flex items-center gap-2 mb-1">
                  {item.done ? (
                    <CheckCircle className="text-green-500" />
                  ) : (
                    <Circle className="text-gray-400" />
                  )}
                  <span className="font-medium">{item.label}</span>
                </div>
                {item.description && (
                  <p className="text-sm text-gray-500 ml-8">
                    {item.description}
                  </p>
                )}
              </div>
              <div className="flex items-center mt-2 sm:mt-0">{item.field}</div>
            </div>
          ))}
        </div>

        <div className="mt-6 flex flex-col sm:flex-row sm:justify-end">
          <Button
            variant="outline"
            onClick={handleDone}
            disabled={!allChecksPassed && !checkingServer}
          >
            {allChecksPassed ? "Continue" : "Refresh Checks"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
