import { FunctionHandler } from "./types";

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

functions.push({
  schema: {
    name: "getAvailableSlots",
    type: "function",
    description: "Get available appointment slots",
    parameters: {
      type: "object",
      properties: {
        specialty: {
          type: "string",
        },
        city: {
          type: "string",
        },
        branch: {
          type: "string",
        },
      },
      required: ["specialty", "city", "branch"],
    },
  },
  handler: async (args: { specialty: string; city: string; branch: string }) => {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    const dayAfterTomorrow = new Date(now);
    dayAfterTomorrow.setDate(now.getDate() + 2);

    const formatDate = (date: Date) => {
      return date.toLocaleDateString('es-ES', { weekday: 'long', month: 'long', day: 'numeric' });
    };

    return JSON.stringify({
      slots: [
        `Mañana, ${formatDate(tomorrow)}, a las 9:00 AM`,
        `Mañana, ${formatDate(tomorrow)}, a las 11:30 AM`,
        `El ${formatDate(dayAfterTomorrow)}, a las 2:00 PM`,
      ]
    });
  },
});

functions.push({
  schema: {
    name: "scheduleAppointment",
    type: "function",
    description: "Schedule an appointment",
    parameters: {
      type: "object",
      properties: {
        identificationNumber: {
          type: "string",
        },
        specialty: {
          type: "string",
        },
        city: {
          type: "string",
        },
        branch: {
          type: "string",
        },
        slot: {
          type: "string",
        },
      },
      required: ["identificationNumber", "specialty", "city", "branch", "slot"],
    },
  },
  handler: async (args: { identificationNumber: string; specialty: string; city: string; branch: string; slot: string }) => {
    // The actual logic for calling the real API and scheduling the appointment would go here.
    // For now, we'll just return a simulated success.
    return JSON.stringify({ success: true });
  },
});

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
