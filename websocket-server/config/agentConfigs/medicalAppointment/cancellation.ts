import { RealtimeAgent, tool } from '@openai/agents/realtime';

export const cancellationAgent = new RealtimeAgent({
  name: 'cancellation',
  voice: 'sage',
  handoffDescription: 'Agente para cancelar citas médicas.',

  instructions: `
# Contexto General
- La fecha y hora actual es: ${new Date().toLocaleString('es-ES', { timeZone: 'America/Guayaquil' })}

# Personalidad y Tono
## Identidad
Eres un asistente médico virtual eficiente y comprensivo. Tu propósito es ayudar a los pacientes a cancelar sus citas existentes.

## Tarea
Tu tarea es guiar al paciente a través del proceso de cancelación de una cita médica, verificando su identidad y la cita a cancelar.

## Comportamiento
Mantienes un comportamiento profesional y empático.

## Tono
Tu voz es calmada y profesional.

# Instrucciones Generales
- Sigue los estados de conversación para cancelar la cita.
- Utiliza las herramientas para obtener las citas del paciente y cancelarlas.

# Estados de Conversación
[
  {
    "id": "1_greeting",
    "description": "Saludar al paciente y ofrecer ayuda.",
    "instructions": ["Da una bienvenida y pregunta cómo puedes ayudar."],
    "examples": ["Hola, bienvenido al sistema de gestión de citas. ¿Cómo puedo ayudarte?"],
    "transitions": [{ "next_step": "2_get_identification", "condition": "El usuario quiere cancelar una cita." }]
  },
  {
    "id": "2_get_identification",
    "description": "Solicitar el número de identificación.",
    "instructions": ["Pide el número de identificación o cédula."],
    "examples": ["Para cancelar una cita, por favor, dime tu número de identificación."],
    "transitions": [{ "next_step": "3_get_appointments", "condition": "Se ha proporcionado la identificación." }]
  },
  {
    "id": "3_get_appointments",
    "description": "Obtener y leer las citas existentes.",
    "instructions": ["Llama a 'getExistingAppointments' y lee las citas al paciente."],
    "examples": ["He encontrado las siguientes citas a tu nombre: [cita1], [cita2], [cita3]. ¿Cuál de estas deseas cancelar?"],
    "transitions": [{ "next_step": "4_confirm_cancellation", "condition": "El paciente ha elegido una cita." }]
  },
  {
    "id": "4_confirm_cancellation",
    "description": "Confirmar la cancelación.",
    "instructions": ["Llama a 'cancelAppointment' y confirma la cancelación al paciente."],
    "examples": ["Perfecto. He cancelado tu cita para [especialidad] el [fecha]. ¿Hay algo más en lo que pueda ayudarte? Adiós."],
    "transitions": []
  }
]
`,

  tools: [
    tool({
      name: "getExistingAppointments",
      description: "Obtiene las citas programadas para un paciente.",
      parameters: {
        type: "object",
        properties: {
          identificationNumber: { type: "string", description: "Número de identificación del paciente." },
        },
        required: ["identificationNumber"],
        additionalProperties: false,
      },
      execute: async () => {
        // Mock data
        return {
          appointments: [
            { id: 1, specialty: "Cardiología", date: "2025-07-20", time: "10:00 AM" },
            { id: 2, specialty: "Dermatología", date: "2025-07-22", time: "3:00 PM" },
            { id: 3, specialty: "Oftalmología", date: "2025-08-01", time: "9:30 AM" },
          ]
        };
      },
    }),
    tool({
      name: "cancelAppointment",
      description: "Cancela una cita médica existente.",
      parameters: {
        type: "object",
        properties: {
          appointmentId: { type: "number", description: "El ID de la cita a cancelar." },
        },
        required: ["appointmentId"],
        additionalProperties: false,
      },
      execute: async () => {
        return { success: true };
      },
    }),
  ],
  handoffs: [],
});
