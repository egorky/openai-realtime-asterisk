// Basic interface for the ARI client, to be expanded as needed
export interface AriClient {
  playbackAudio: (channelId: string, audioPayload: string) => void;
  endCall: (channelId: string) => void;
  // Add other methods like startExternalMedia, answerCall etc. as they are implemented
}

// Information related to an active Asterisk call
export interface AriCallInfo {
  channelId: string;
  ariClient: AriClient; // Using the AriClient interface
}

export interface FunctionCallItem {
  name: string;
  arguments: string;
  call_id?: string;
}

export interface FunctionSchema {
  name: string;
  type: "function";
  description?: string;
  parameters: {
    type: string;
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

export interface FunctionHandler {
  schema: FunctionSchema;
  handler: (args: any) => Promise<string>;
}
