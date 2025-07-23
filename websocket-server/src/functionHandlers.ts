import { FunctionHandler, CallSpecificConfig } from "./types";
import { saveSessionParams } from './redis-client';
import * as sessionManager from './sessionManager';
import { CallResources } from './ari-call-resources';
import { AriClientService } from "./ari-service";

export async function _playTTSThenGetSlots(serviceInstance: AriClientService, callId: string, call: CallResources): Promise<void> {
  call.callLogger.info("Orchestrating tool call for getAvailableSlots");

  // Generate TTS for the waiting message
  const waitingMessage = "Un momento, por favor, estoy consultando los horarios.";
  const configForTTS = { ...call.config, openAIRealtimeAPI: { ...call.config.openAIRealtimeAPI, stream: false } };
  await sessionManager.requestOpenAIResponse(callId, waitingMessage, configForTTS);

  // The audio will be played via the _onOpenAIAudioChunk and _onOpenAIAudioStreamEnd callbacks.
  // We need a way to know that after this TTS is played, we should call the getAvailableSlots tool.
  // We'll use a flag in the call resources.
  call.pendingToolCall = "getAvailableSlots";
}

export async function _extractSlotAndSchedule(callId: string, transcript: string, call: CallResources): Promise<void> {
  const lowerTranscript = transcript.toLowerCase();
  // This is a very simple way to extract the slot. A more robust solution would use a regex or a more advanced NLP technique.
  const slot = transcript; // For now, we'll just use the whole transcript as the slot.
  await saveSessionParams(callId, { slot });
  call.pendingToolCall = "scheduleAppointment";
}

export async function getAvailableSlots(args: { specialty: string; city: string; branch: string }) {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const dayAfterTomorrow = new Date(now);
  dayAfterTomorrow.setDate(now.getDate() + 2);

  const formatDate = (date: Date) => {
    return date.toLocaleDateString('es-ES', { weekday: 'long', month: 'long', day: 'numeric' });
  };

  return {
    slots: [
      `Mañana, ${formatDate(tomorrow)}, a las 9:00 AM`,
      `Mañana, ${formatDate(tomorrow)}, a las 11:30 AM`,
      `El ${formatDate(dayAfterTomorrow)}, a las 2:00 PM`,
    ]
  };
}

const functions: FunctionHandler[] = [];

functions.push({
  schema: {
    name: "get_weather_from_coords",
    type: "function",
    description: "Get the current weather",
    parameters: {
      type: "object",
      properties: {
        latitude: {
          type: "number",
        },
        longitude: {
          type: "number",
        },
      },
      required: ["latitude", "longitude"],
    },
  },
  handler: async (args: { latitude: number; longitude: number }) => {
    const response = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${args.latitude}&longitude=${args.longitude}&current=temperature_2m,wind_speed_10m&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m`
    );
    const data = await response.json();
    const currentTemp = data.current?.temperature_2m;
    return JSON.stringify({ temp: currentTemp });
  },
});

export async function scheduleAppointment(args: { identificationNumber: string; specialty: string; city: string; branch: string; slot: string }) {
  // Aquí iría la lógica para llamar a la API real y agendar la cita.
  // Por ahora, solo devolvemos un éxito simulado.
  return { success: true };
}

functions.push({
  schema: {
    name: "endCall",
    type: "function",
    description: "Ends the phone call. Use this when the conversation is over.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  handler: async () => {
    // The actual logic is handled in toolExecutor.ts by detecting the function name.
    return JSON.stringify({ success: true, message: "Call termination initiated." });
  },
});

export default functions;
