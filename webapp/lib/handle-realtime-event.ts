import { Item } from "@/components/types";

// Define the structure of the ARI call information (might be for a single primary/selected call)
export interface AriCallInfo {
  status: "idle" | "active" | "ringing" | "ended" | "error";
  callId: string | null;
  callerId: string | null;
  errorMessage?: string;
  reason?: string;
}

// Define the structure for items in the active calls list from the backend
export interface ActiveCallListItem {
  callId: string;
  callerId: string | undefined;
  startTime: string | undefined;
  status: string; // From backend: 'active', 'ringing', 'ended', etc.
}


export default function handleRealtimeEvent(
  ev: any,
  setItems: React.Dispatch<React.SetStateAction<Item[]>>,
  setAriCallInfo: React.Dispatch<React.SetStateAction<AriCallInfo>>,
  setActiveCallsList?: React.Dispatch<React.SetStateAction<ActiveCallListItem[]>>,
  currentSelectedCallId?: string | null // Nuevo parámetro
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
    case "active_calls_list": {
      if (setActiveCallsList && Array.isArray(payload)) {
        console.log("Active Calls List Update:", payload);
        setActiveCallsList(payload);
      } else if (!setActiveCallsList) {
          console.warn("Received active_calls_list but setActiveCallsList is not provided to handleRealtimeEvent.");
      } else {
        console.warn("Received active_calls_list with invalid payload:", payload);
      }
      break;
    }
    case "ari_call_status_update": { // This event might update a specific call in the list or the main selected call.
      if (payload) {
        console.log("ARI Call Status Update (individual):", payload);
        // Option 1: Update the global/primary AriCallInfo if it matches.
        // This might be relevant if the UI always shows one "main" call's status prominently.
        setAriCallInfo(prev => {
          if (prev.callId === payload.callId || !prev.callId) { // Update if it's the current primary or no primary yet
            return {
              status: payload.status,
              callId: payload.callId,
              callerId: payload.callerId,
              errorMessage: payload.errorMessage,
              reason: payload.reason,
            };
          }
          return prev; // Otherwise, keep the existing primary call info
        });

        // Option 2: Update the specific call in the activeCallsList.
        // This is more robust for a multi-call display.
        if (setActiveCallsList) {
            setActiveCallsList(prevList =>
                prevList.map(call =>
                    call.callId === payload.callId
                        ? { ...call, status: payload.status, callerId: payload.callerId, errorMessage: payload.errorMessage, reason: payload.reason }
                        : call
                )
            );
        }

        // If call ended or errored, maybe clear transcription items or add a system message *if this is the selected call*.
        // This logic needs to be tied to a selectedCallId state in CallInterface.
        // For now, let's keep the original system message logic but it should be conditional.
        if (payload.status === "ended" || payload.status === "error") {
          setItems((prev) => [
            ...prev,
            createNewItem({
              id: `call_status_${payload.callId}_${Date.now()}`, // Include callId in message id
              type: "system_message",
              role: "system",
              content: [{ type: "text", text: `Call ${payload.callId} ${payload.status}. ${payload.reason ? `Reason: ${payload.reason}` : ''} ${payload.errorMessage ? `Error: ${payload.errorMessage}`: ''}`.trim() }],
              status: "completed",
            }),
          ]);
        }
      }
      break;
    }
    case "session.created": { // This typically implies a new OpenAI session, often tied to a new call context.
      setItems([]);
      // Reset global/primary ARI call info. The specific call will get its status via active_calls_list or ari_call_status_update.
      setAriCallInfo({ status: "idle", callId: null, callerId: null });
      // It might also be prudent to clear the active calls list here if a "session.created" means a full backend reset,
      // but that depends on backend logic. For now, assume it's per-call or global.
      // if (setActiveCallsList) setActiveCallsList([]);
      break;
    }
    case "conversation_history": {
      if (payload && Array.isArray(payload) && ev.callId === currentSelectedCallId) {
        console.log(`Received conversation history for selected call ${ev.callId}:`, payload);
        // Convert backend ConversationTurn[] to frontend Item[]
        // This mapping might need to be more sophisticated depending on type differences
        const historyItems: Item[] = payload.map((turn: any) => ({ // 'any' for backend turn type flexibility
          id: `${turn.actor}_${turn.timestamp}_${Math.random().toString(36).substring(7)}`, // Create a unique enough ID
          object: "realtime.item", // Or map from turn if available
          type: turn.type === "tts_prompt" ? "message" : (turn.type === "transcript" ? "message" : turn.type), // Map backend types to frontend types
          role: turn.actor === "dtmf" ? "system" : turn.actor, // Map 'dtmf' actor to 'system' role for display
          content: [{ type: "text", text: turn.content }],
          status: "completed",
          timestamp: new Date(turn.timestamp).toLocaleTimeString(),
          // Potentially map other fields if Item has them (e.g. call_id for function calls)
        }));
        setItems(historyItems);
      } else if (ev.callId !== currentSelectedCallId) {
        console.log(`Received conversation history for non-selected call ${ev.callId}. Ignoring.`);
      } else {
        console.warn("Received conversation_history with invalid payload or mismatched callId:", ev);
      }
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
