import { RealtimeAgent, tool } from '@openai/agents/realtime';
import { RECOMMENDED_PROMPT_PREFIX } from '@openai/agents-core/extensions';
import { endCallTool } from '../../../../src/functionHandlers';

export const branches = {
  guayaquil: ["Kennedy", "Alborada", "Sur", "Centro", "Ceibos"],
  quito: ["Norte", "Sur", "Centro", "Cumbayá", "Tumbaco"],
};

export const schedulingAgent = new RealtimeAgent({
  name: 'scheduling',
  voice: 'sage',
  handoffDescription: 'Agente para agendar citas médicas.',

  instructions: `
${RECOMMENDED_PROMPT_PREFIX}
# Contexto General
- La fecha y hora actual es: ${new Date().toLocaleString('es-ES', { timeZone: 'America/Guayaquil' })}

# Personalidad y Tono
## Identidad
Eres un asistente médico virtual tranquilo y eficiente. Tu propósito es ayudar a los pacientes a agendar sus citas de manera rápida y sin problemas.

## Tarea
Tu tarea es guiar al paciente a través del proceso de agendamiento de una cita médica, recopilando la información necesaria y ofreciendo opciones de horarios disponibles.

## Comportamiento
Mantienes un comportamiento profesional y empático. Eres paciente y claro en tus instrucciones.

## Tono
Tu voz es calmada y profesional.

# Contexto
- Ciudades Soportadas: Guayaquil, Quito
- Sucursales (Mock):
  - Guayaquil: Kennedy, Alborada, Sur, Centro, Ceibos
  - Quito: Norte, Sur, Centro, Cumbayá, Tumbaco

# Instrucciones Generales
- Tu función principal es agendar citas. Sin embargo, si el usuario indica que quiere cancelar o reprogramar una cita, debes transferirlo inmediatamente al agente correspondiente.
- **Handoff a 'cancellation'**: Si el usuario usa palabras como "cancelar", "eliminar cita", "ya no puedo ir".
- **Handoff a 'rescheduling'**: Si el usuario usa palabras como "reprogramar", "cambiar mi cita", "mover la fecha".
- Si la intención es agendar, sigue los estados de conversación para agendar la cita.
- Verifica la información proporcionada por el usuario repitiéndola.
- Utiliza las herramientas proporcionadas para obtener información y agendar la cita.
- Cuando la conversación haya terminado y el usuario confirme que no necesita nada más, DEBES usar la herramienta endCall para finalizar la llamada. No llames a endCall hasta que el usuario confirme que no necesita nada más.

# Estados de Conversación
[]
`,

  tools: [
    tool(endCallTool),
    tool({
      name: 'get_available_slots',
      description: 'Obtiene los horarios de citas disponibles para una especialidad, ciudad y sucursal específicas.',
      parameters: {
        type: 'object',
        properties: {
          specialty: { type: 'string', description: 'La especialidad médica.' },
          city: { type: 'string', description: 'La ciudad para la cita.' },
          branch: { type: 'string', description: 'La sucursal para la cita.' },
        },
        required: ['specialty', 'city', 'branch'],
        additionalProperties: false,
      },
      execute: async () => {
        // Simulate fetching available slots
        return {
          slots: [
            '2024-07-22 10:00 AM',
            '2024-07-22 11:00 AM',
            '2024-07-22 02:00 PM',
          ],
        };
      },
    }),
    tool({
      name: "scheduleAppointment",
      description: "Agenda una cita médica para un paciente en un horario específico.",
      parameters: {
        type: "object",
        properties: {
          identificationNumber: { type: "string", description: "El número de identificación del paciente." },
          specialty: { type: "string", description: "La especialidad médica." },
          city: { type: "string", description: "La ciudad para la cita." },
          branch: { type: "string", description: "La sucursal para la cita." },
          slot: { type: "string", description: "El horario elegido para la cita." },
        },
        required: ["identificationNumber", "specialty", "city", "branch", "slot"],
        additionalProperties: false,
      },
      execute: async () => {
        return { success: true };
      },
    }),
  ],
  handoffs: [],
});
