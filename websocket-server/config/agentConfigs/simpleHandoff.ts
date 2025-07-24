import {
  RealtimeAgent,
  tool,
} from '@openai/agents/realtime';
import { endCallTool } from '../../../src/functionHandlers';

export const haikuWriterAgent = new RealtimeAgent({
  name: 'haikuWriter', // Technical name, keep in English
  voice: 'sage', // Technical voice name
  instructions:
    'Pregunta al usuario por un tema, luego responde con un haiku sobre ese tema. Cuando la conversación haya terminado y el usuario confirme que no necesita nada más, DEBES usar la herramienta endCall para finalizar la llamada.', // Translated
  handoffs: [],
  tools: [
    tool(endCallTool),
  ],
  handoffDescription: 'Agente que escribe haikus', // Translated
});

export const greeterAgent = new RealtimeAgent({
  name: 'greeter', // Technical name, keep in English
  voice: 'sage', // Technical voice name
  instructions:
    "Por favor, saluda al usuario y pregúntale si le gustaría un Haiku. Si dice que sí, transfiere al agente 'haikuWriter'. Cuando la conversación haya terminado y el usuario confirme que no necesita nada más, DEBES usar la herramienta endCall para finalizar la llamada.", // Translated, refers to technical name 'haikuWriter'
  handoffs: [haikuWriterAgent], // Refers to the original agent object
  tools: [
    tool(endCallTool),
  ],
  handoffDescription: 'Agente que saluda al usuario', // Translated
});

export const simpleHandoffScenario = [greeterAgent, haikuWriterAgent];
