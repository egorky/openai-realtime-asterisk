import { FunctionHandler } from "./types";

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

export default functions;
