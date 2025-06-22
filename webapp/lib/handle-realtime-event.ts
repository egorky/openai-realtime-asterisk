import { Item } from "@/components/types";

// Definir el tipo para la información de la llamada ARI
export interface AriCallInfo {
  status: "idle" | "active" | "ended" | "error"; // Added 'error' status
  callId: string | null;
  callerId: string | null;
  errorMessage?: string; // Optional error message
  reason?: string; // Optional reason for ending
}

export default function handleRealtimeEvent(
  ev: any,
  setItems: React.Dispatch<React.SetStateAction<Item[]>>,
  setAriCallInfo: React.Dispatch<React.SetStateAction<AriCallInfo>> // Nuevo setter
) {
  // Helper function to create a new item with default fields
  function createNewItem(base: Partial<Item>): Item {
    return {
      object: "realtime.item", // Default object type, can be overridden by base
      timestamp: new Date().toLocaleTimeString(),
      ...base,
    } as Item; // Cast to Item, ensure all required fields are covered or optional
  }

  // Helper function to update an existing item if found by id, or add a new one if not.
  function updateOrAddItem(id: string, updates: Partial<Item>): void {
    setItems((prev) => {
      const idx = prev.findIndex((m) => m.id === id);
      if (idx >= 0) {
        const updated = [...prev];
        // Ensure crucial fields like 'role' and 'type' are preserved if not in updates
        updated[idx] = {
            object: updated[idx].object, // Preserve original object type
            type: updated[idx].type,     // Preserve original item type
            role: updated[idx].role,     // Preserve original role
            ...updated[idx],
            ...updates,
            timestamp: updated[idx].timestamp || new Date().toLocaleTimeString(), // Preserve or set timestamp
        };
        return updated;
      } else {
        // For new items, ensure 'id' is part of the base for createNewItem
        return [...prev, createNewItem({ id, ...updates })];
      }
    });
  }


  // Try to determine event structure (new with payload vs. old direct structure)
  const eventType = ev.type;
  const payload = ev.payload;

  // Log all events for easier debugging
  // console.log("Handling Realtime Event:", ev);


  switch (eventType) {
    case "ari_call_status_update": {
      if (payload) {
        console.log("ARI Call Status Update:", payload);
        setAriCallInfo({
          status: payload.status,
          callId: payload.callId,
          callerId: payload.callerId,
          errorMessage: payload.errorMessage,
          reason: payload.reason,
        });
        // If call ended or errored, maybe clear transcription items or add a system message
        if (payload.status === "ended" || payload.status === "error") {
          setItems((prev) => [
            ...prev,
            createNewItem({
              id: `call_status_${Date.now()}`,
              type: "system_message", // Custom type for system messages
              role: "system",
              content: [{ type: "text", text: `Call ${payload.status}. ${payload.reason ? `Reason: ${payload.reason}` : ''} ${payload.errorMessage ? `Error: ${payload.errorMessage}`: ''}`.trim() }],
              status: "completed",
            }),
          ]);
        }
      }
      break;
    }
    case "session.created": {
      setItems([]);
      // Reset ARI call info as well, as a new OpenAI session implies a new context
      setAriCallInfo({ status: "idle", callId: null, callerId: null });
      break;
    }
    case "config_update_ack": {
        console.log("Config update acknowledged by backend:", ev);
        // Optionally, add a system message to the transcript
        setItems((prev) => [
            ...prev,
            createNewItem({
                id: `config_ack_${Date.now()}`,
                type: "system_message",
                role: "system",
                content: [{ type: "text", text: `Configuration update processed for call ${ev.callId}.` }],
                status: "completed",
            }),
        ]);
        break;
    }
    case "error": { // Generic error from backend
        console.error("Received error event from backend:", ev.message);
        setItems((prev) => [
            ...prev,
            createNewItem({
                id: `backend_error_${Date.now()}`,
                type: "system_message",
                role: "system",
                content: [{ type: "text", text: `Backend Error: ${ev.message}` }],
                status: "completed",
            }),
        ]);
        // Potentially update ARI status if it's a critical error
        // setAriCallInfo(prev => ({ ...prev, status: "error", errorMessage: ev.message }));
        break;
    }

    // Cases from the original switch, assuming they don't use a nested 'payload'
    // and their 'type' is directly ev.type
    case "input_audio_buffer.speech_started": {
      // Create a user message item with running status and placeholder content
      const { item_id } = ev;
      setItems((prev) => [
        ...prev,
        createNewItem({
          id: item_id,
          type: "message",
          role: "user",
          content: [{ type: "text", text: "..." }],
          status: "running",
        }),
      ]);
      break;
    }

    case "conversation.item.created": {
      const { item } = ev;
      if (item.type === "message") {
        // A completed message from user or assistant
        const updatedContent =
          item.content && item.content.length > 0 ? item.content : [];
        setItems((prev) => {
          const idx = prev.findIndex((m) => m.id === item.id);
          if (idx >= 0) {
            const updated = [...prev];
            updated[idx] = {
              ...updated[idx],
              ...item,
              content: updatedContent,
              status: "completed",
              timestamp:
                updated[idx].timestamp || new Date().toLocaleTimeString(),
            };
            return updated;
          } else {
            return [
              ...prev,
              createNewItem({
                ...item,
                content: updatedContent,
                status: "completed",
              }),
            ];
          }
        });
      }
      // NOTE: We no longer handle function_call items here.
      // The handling of function_call items has been moved to the "response.output_item.done" event.
      else if (item.type === "function_call_output") {
        // Function call output item created
        // Add the output item and mark the corresponding function_call as completed
        // Also display in transcript as tool message with the response
        setItems((prev) => {
          const newItems = [
            ...prev,
            createNewItem({
              ...item,
              role: "tool",
              content: [
                {
                  type: "text",
                  text: `Function call response: ${item.output}`,
                },
              ],
              status: "completed",
            }),
          ];

          return newItems.map((m) =>
            m.call_id === item.call_id && m.type === "function_call"
              ? { ...m, status: "completed" }
              : m
          );
        });
      }
      break;
    }

    case "conversation.item.input_audio_transcription.completed": {
      // Update the user message with the final transcript
      const { item_id, transcript } = ev;
      setItems((prev) =>
        prev.map((m) =>
          m.id === item_id && m.type === "message" && m.role === "user"
            ? {
                ...m,
                content: [{ type: "text", text: transcript }],
                status: "completed",
              }
            : m
        )
      );
      break;
    }

    case "response.content_part.added": {
      const { item_id, part, output_index } = ev;
      // Append new content to the assistant message if output_index == 0
      if (part.type === "text" && output_index === 0) {
        setItems((prev) => {
          const idx = prev.findIndex((m) => m.id === item_id);
          if (idx >= 0) {
            const updated = [...prev];
            const existingContent = updated[idx].content || [];
            updated[idx] = {
              ...updated[idx],
              content: [
                ...existingContent,
                { type: part.type, text: part.text },
              ],
            };
            return updated;
          } else {
            // If the item doesn't exist yet, create it as a running assistant message
            return [
              ...prev,
              createNewItem({
                id: item_id,
                type: "message",
                role: "assistant",
                content: [{ type: part.type, text: part.text }],
                status: "running",
              }),
            ];
          }
        });
      }
      break;
    }

    case "response.audio_transcript.delta": {
      // Streaming transcript text (assistant)
      const { item_id, delta, output_index } = ev;
      if (output_index === 0 && delta) {
        setItems((prev) => {
          const idx = prev.findIndex((m) => m.id === item_id);
          if (idx >= 0) {
            const updated = [...prev];
            const existingContent = updated[idx].content || [];
            updated[idx] = {
              ...updated[idx],
              content: [...existingContent, { type: "text", text: delta }],
            };
            return updated;
          } else {
            return [
              ...prev,
              createNewItem({
                id: item_id,
                type: "message",
                role: "assistant",
                content: [{ type: "text", text: delta }],
                status: "running",
              }),
            ];
          }
        });
      }
      break;
    }

    case "response.output_item.done": {
      const { item } = ev;
      if (item.type === "function_call") {
        // A new function call item
        // Display it in the transcript as an assistant message indicating a function is being requested
        console.log("function_call", item);
        setItems((prev) => [
          ...prev,
          createNewItem({
            ...item,
            role: "assistant",
            content: [
              {
                type: "text",
                text: `${item.name}(${JSON.stringify(
                  JSON.parse(item.arguments)
                )})`,
              },
            ],
            status: "running",
          }),
        ]);
      }
      break;
    }

    default:
      break;
  }
}
