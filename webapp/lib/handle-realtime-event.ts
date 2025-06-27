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
      timestamp: new Date().toLocaleTimeString(), // Default timestamp, can be overridden
      ...base,
    } as Item; // Cast to Item, ensure all required fields are covered or optional
  }

  // Helper function to update an existing item if found by id, or add a new one if not.
  // This function is not currently used by the new system message logic but kept for original functionality.
  function updateOrAddItem(id: string, updates: Partial<Item>): void {
    setItems((prev) => {
      const idx = prev.findIndex((m) => m.id === id);
      if (idx >= 0) {
        const updated = [...prev];
        updated[idx] = {
            object: updated[idx].object,
            type: updated[idx].type,
            role: updated[idx].role,
            ...updated[idx],
            ...updates,
            timestamp: updates.timestamp || updated[idx].timestamp || new Date().toLocaleTimeString(),
        };
        return updated;
      } else {
        return [...prev, createNewItem({ id, ...updates, timestamp: updates.timestamp || new Date().toLocaleTimeString() })];
      }
    });
  }

  const eventType = ev.type;
  const payload = ev.payload;
  const eventTimestamp = ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString() : new Date().toLocaleTimeString();

  switch (eventType) {
    case "active_calls_list": {
      if (setActiveCallsList && Array.isArray(payload)) {
        setActiveCallsList(payload);
      } else {
        console.warn("Received active_calls_list with invalid payload or missing handler:", payload);
      }
      break;
    }
    case "ari_call_status_update": {
      if (payload) {
        setAriCallInfo(prev => {
          if (prev.callId === payload.callId || !prev.callId || payload.callId === currentSelectedCallId) {
            return {
              status: payload.status,
              callId: payload.callId,
              callerId: payload.callerId,
              errorMessage: payload.errorMessage,
              reason: payload.reason,
            };
          }
          return prev;
        });

        if (setActiveCallsList) {
            setActiveCallsList(prevList =>
                prevList.map(call =>
                    call.callId === payload.callId
                        ? { ...call, status: payload.status, callerId: payload.callerId, errorMessage: payload.errorMessage, reason: payload.reason }
                        : call
                )
            );
        }

        if (payload.status === "ended" || payload.status === "error") {
          if (payload.callId === currentSelectedCallId || (currentSelectedCallId === null && ariCallInfo && payload.callId === ariCallInfo.callId)) {
            setItems((prev) => [
              ...prev,
              createNewItem({
                id: `call_status_${payload.callId}_${Date.now()}`,
                type: "message",
                role: "system",
                content: [{ type: "text", text: `Call ${payload.callId} ${payload.status}. ${payload.reason ? `Reason: ${payload.reason}` : ''} ${payload.errorMessage ? `Error: ${payload.errorMessage}`: ''}`.trim() }],
                status: "completed",
                timestamp: eventTimestamp,
              }),
            ]);
          }
        }
      }
      break;
    }
    // Centralized handler for various system/AI events
    case "system_message":
    case "cleanup_resource_release_event":
    case "openai_requesting_response":
    case "openai_tts_stream_ended":
    case "openai_session_ended":
    case "vad_speech_detected_start":
    case "vad_speech_detected_end":
    case "timer_event":
    case "tts_playback_interrupted":
    case "openai_stream_activated":
    case "openai_stream_activation_failed":
    case "playback_started":
    case "playback_failed_to_start":
    case "playback_all_stopped_action":
    case "dtmf_mode_activated":
    case "dtmf_input_finalized":
    case "call_answered":
    case "call_resources_initialized":
    case "vad_post_prompt_logic_started":
    case "openai_tts_chunk_received_and_queued":
    case "openai_tts_chunk_accumulated":
    {
        if (ev.callId && ev.callId !== currentSelectedCallId) {
            return;
        }

        let messageText = `Event: ${eventType}`;
        if (payload) {
            if (eventType === "openai_requesting_response") messageText = `System: Requesting OpenAI response for input: '${payload.triggeringTranscript?.substring(0, 50)}...'`;
            else if (eventType === "openai_tts_stream_ended") messageText = `System: TTS audio stream finished. Mode: ${payload.playbackMode}. ${payload.savedFilePath ? `Saved to: ${payload.savedFilePath.split('/').pop()}` : (payload.error || '')}`;
            else if (eventType === "openai_session_ended") messageText = `System: OpenAI session ended. Reason: ${payload.reason}`;
            else if (eventType === "vad_speech_detected_start") messageText = `VAD: Speech detected.`;
            else if (eventType === "vad_speech_detected_end") messageText = `VAD: Silence detected. Duration: ${payload.durationMs}ms.`;
            else if (eventType === "timer_event") messageText = `Timer: '${payload.timerName}' ${payload.action}${payload.durationSeconds ? ` for ${payload.durationSeconds}s` : ''}.`;
            else if (eventType === "tts_playback_interrupted") messageText = `System: TTS playback interrupted. Reason: ${payload.reason}.`;
            else if (eventType === "openai_stream_activated") messageText = `System: OpenAI stream activated. Reason: ${payload.reason}.`;
            else if (eventType === "openai_stream_activation_failed") messageText = `System: OpenAI stream activation failed. Reason: ${payload.reason}, Error: ${payload.errorMessage}.`;
            else if (eventType === "playback_started") messageText = `System: Playback started - ID: ${payload.playbackId}, Purpose: ${payload.purpose}.`;
            else if (eventType === "playback_failed_to_start") messageText = `System: Playback failed to start - Purpose: ${payload.purpose}, Error: ${payload.errorMessage}.`;
            else if (eventType === "playback_all_stopped_action") messageText = `System: All playbacks stopped. Reason: ${payload.reason}.`;
            else if (eventType === "dtmf_mode_activated") messageText = `System: DTMF mode activated. Reason: ${payload.reason}.`;
            else if (eventType === "dtmf_input_finalized") messageText = `System: DTMF input finalized: '${payload.finalDigits}'. Reason: ${payload.reason}.`;
            else if (eventType === "call_answered") messageText = `System: Call answered.`;
            else if (eventType === "call_resources_initialized") messageText = `System: Call resources initialized.`;
            else if (eventType === "vad_post_prompt_logic_started") messageText = `VAD: Post-prompt/TTS VAD logic started. Mode: ${payload.vadRecogActivation}.`;
            else if (eventType === "openai_tts_chunk_received_and_queued") messageText = `System: TTS chunk queued. URI: ${payload.chunkUri}, Queue: ${payload.queueSize}.`;
            else if (eventType === "openai_tts_chunk_accumulated") messageText = `System: TTS chunk accumulated. Total: ${payload.accumulatedChunks}.`;
            else if (payload.message) messageText = payload.message;
            else messageText = `Event: ${eventType} - ${JSON.stringify(payload).substring(0,100)}...`;
        }

        setItems((prev) => [
            ...prev,
            createNewItem({
              id: `${eventType}_${ev.callId || 'global'}_${Date.now()}_${Math.random()}`,
              type: "message",
              role: "system",
              content: [{ type: "text", text: messageText }],
              status: "completed",
              timestamp: eventTimestamp,
            }),
        ]);
        break;
    }
    case "session.created": {
      setItems([]);
      setAriCallInfo({ status: "idle", callId: null, callerId: null });
      break;
    }
    case "conversation_history": {
      if (payload && Array.isArray(payload) && ev.callId === currentSelectedCallId) {
        console.log(`Received conversation history for selected call ${ev.callId}:`, payload);
        const historyItems: Item[] = payload.map((turn: any) => {
          let itemType: Item['type'] = "message"; // Default to message
          if (turn.type === "function_call" || turn.type === "function_call_output") {
            itemType = turn.type;
          }
          let itemRole: Item['role'] = turn.actor;
          if (turn.actor === "dtmf" || turn.actor === "system") {
            itemRole = "system";
          }

          return {
            id: `${turn.actor}_${turn.timestamp}_${Math.random().toString(36).substring(7)}`,
            object: "realtime.item",
            type: itemType,
            role: itemRole,
            content: [{ type: "text", text: turn.content }],
            status: "completed",
            timestamp: new Date(turn.timestamp).toLocaleTimeString(),
            name: turn.type === "function_call" ? turn.name : undefined, // Specific to function_call
            output: turn.type === "function_call_output" ? turn.output : undefined, // Specific to function_call_output
            call_id: turn.call_id // for function_call and function_call_output
          };
        });
        setItems(historyItems);
      } else if (ev.callId !== currentSelectedCallId) {
        // console.log(`Received conversation history for non-selected call ${ev.callId}. Ignoring for display.`);
      } else {
        console.warn("Received conversation_history with invalid payload or mismatched callId:", ev);
      }
      break;
    }
    case "config_update_ack": {
        console.log("Config update acknowledged by backend:", ev);
        if (ev.callId && ev.callId !== currentSelectedCallId) {
            return;
        }
        setItems((prev) => [
            ...prev,
            createNewItem({
                id: `config_ack_${ev.callId}_${Date.now()}`,
                type: "message",
                role: "system",
                content: [{ type: "text", text: `Configuration update processed for call ${ev.callId}.` }],
                status: "completed",
                timestamp: eventTimestamp,
            }),
        ]);
        break;
    }
    case "error": {
        console.error("Received error event from backend:", payload?.message || ev.message);
        if (ev.callId && ev.callId !== currentSelectedCallId) {
            return;
        }
        setItems((prev) => [
            ...prev,
            createNewItem({
                id: `backend_error_${ev.callId || 'global'}_${Date.now()}`,
                type: "message",
                role: "system",
                content: [{ type: "text", text: `Backend Error: ${payload?.message || ev.message}` }],
                status: "completed",
                timestamp: eventTimestamp,
            }),
        ]);
        break;
    }

    // Original OpenAI SDK event handlers (might be deprecated if all events are standardized)
    case "input_audio_buffer.speech_started": {
      if (ev.call_id && ev.call_id !== currentSelectedCallId) return;
      const { item_id } = ev; // Assuming ev contains item_id directly for these older events
      updateOrAddItem(item_id, {
        id: item_id, // Ensure id is passed for potential creation by updateOrAddItem
        type: "message",
        role: "user",
        content: [{ type: "text", text: "..." }],
        status: "running",
        timestamp: eventTimestamp
      });
      break;
    }

    case "conversation.item.created": {
      if (ev.item?.call_id && ev.item.call_id !== currentSelectedCallId && currentSelectedCallId) return; // Allow if no call selected yet
      const { item } = ev;
      if (item.type === "message") {
        const updatedContent = item.content && item.content.length > 0 ? item.content : [];
        updateOrAddItem(item.id, {
          ...item,
          content: updatedContent,
          status: "completed",
          timestamp: eventTimestamp
        });
      }
      else if (item.type === "function_call_output") {
        setItems((prev) => {
          const newItems = [
            ...prev,
            createNewItem({
              ...item,
              role: "tool",
              content: [{ type: "text", text: `Function call response: ${item.output}` }],
              status: "completed",
              timestamp: eventTimestamp,
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
      if (ev.call_id && ev.call_id !== currentSelectedCallId) return;
      const { item_id, transcript } = ev;
      setItems((prev) =>
        prev.map((m) =>
          m.id === item_id && m.type === "message" && m.role === "user"
            ? {
                ...m,
                content: [{ type: "text", text: transcript }],
                status: "completed",
                timestamp: eventTimestamp,
              }
            : m
        )
      );
      break;
    }

    case "response.content_part.added": {
      if (ev.call_id && ev.call_id !== currentSelectedCallId) return;
      const { item_id, part, output_index } = ev;
      if (part.type === "text" && output_index === 0) {
         updateOrAddItem(item_id, {
            id: item_id,
            type: "message",
            role: "assistant",
            content: [{ type: part.type, text: part.text }], // Appends in updateOrAddItem logic if item exists
            status: "running",
            timestamp: eventTimestamp
        });
      }
      break;
    }

    case "response.audio_transcript.delta": {
      if (ev.call_id && ev.call_id !== currentSelectedCallId) return;
      const { item_id, delta, output_index } = ev;
      if (output_index === 0 && delta) {
        setItems((prev) => {
            const idx = prev.findIndex((m) => m.id === item_id && m.role === "assistant");
            if (idx >= 0) {
                const updated = [...prev];
                const currentItemContent = updated[idx].content || [];
                const lastTextPart = currentItemContent.length > 0 ? currentItemContent[currentItemContent.length -1] : null;
                if(lastTextPart && lastTextPart.type === 'text') {
                    lastTextPart.text += delta;
                } else {
                    currentItemContent.push({ type: "text", text: delta });
                }
                updated[idx] = { ...updated[idx], content: currentItemContent, status: "running", timestamp: eventTimestamp };
                return updated;
            } else {
                return [...prev, createNewItem({ id: item_id, type: "message", role: "assistant", content: [{ type: "text", text: delta }], status: "running", timestamp: eventTimestamp })];
            }
        });
      }
      break;
    }

    case "response.output_item.done": {
      if (ev.item?.call_id && ev.item.call_id !== currentSelectedCallId && currentSelectedCallId) return;
      const { item } = ev;
      if (item.type === "function_call") {
        console.log("function_call (response.output_item.done)", item);
        setItems((prev) => [
          ...prev,
          createNewItem({
            ...item,
            role: "assistant", // Indicates assistant is making a function call
            content: [ { type: "text", text: `${item.name}(${JSON.stringify( JSON.parse(item.arguments))})` } ],
            status: "running", // Function call is initiated, waiting for output
            timestamp: eventTimestamp,
          }),
        ]);
      }
      break;
    }

    default:
      // console.log("Unhandled event type in handleRealtimeEvent:", eventType);
      break;
  }
}
