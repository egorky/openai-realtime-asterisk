export const toolTemplates = [
  {
    name: "get_weather",
    type: "function",
    description: "Get the current weather",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string" },
      },
    },
  },
  {
    name: "ping_no_args",
    type: "function",
    description: "A simple ping tool with no arguments",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_user_nested_args",
    type: "function",
    description: "Fetch user profile by nested identifier",
    parameters: {
      type: "object",
      properties: {
        user: {
          type: "object",
          properties: {
            id: { type: "string" },
            metadata: {
              type: "object",
              properties: {
                region: { type: "string" },
                role: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
  {
    name: "calculate_route_more_properties",
    type: "function",
    description: "Calculate travel route with multiple parameters",
    parameters: {
      type: "object",
      properties: {
        start: { type: "string" },
        end: { type: "string" },
        mode: { type: "string", enum: ["car", "bike", "walk"] },
        options: {
          type: "object",
          properties: {
            avoid_highways: { type: "boolean" },
            scenic_route: { type: "boolean" },
          },
        },
      },
    },
  },
];
