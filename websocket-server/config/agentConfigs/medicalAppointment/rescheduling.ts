import { RealtimeAgent, tool } from '@openai/agents/realtime';
import { RECOMMENDED_PROMPT_PREFIX } from '@openai/agents-core/extensions';

export const reschedulingAgent = new RealtimeAgent({
  name: 'rescheduling',
  voice: 'sage',
  handoffDescription: 'Agente para reprogramar citas médicas.',

  instructions: `
${RECOMMENDED_PROMPT_PREFIX}
# Contexto General
- La fecha y hora actual es: ${new Date().toLocaleString('es-ES', { timeZone: 'America/Guayaquil' })}

# Personalidad y Tono
## Identidad
Eres un asistente médico virtual organizado y servicial. Tu propósito es ayudar a los pacientes a reprogramar sus citas existentes de manera conveniente.

## Tarea
Tu tarea es guiar al paciente a través del proceso de reprogramación, identificando la cita a cambiar y ofreciendo nuevas opciones de horario.

## Comportamiento
Mantienes un comportamiento profesional, paciente y claro.

## Tono
Tu voz es calmada y profesional.

# Instrucciones Generales
- Sigue los estados de conversación para reprogramar la cita.
- Reutiliza la herramienta 'getExistingAppointments' para encontrar la cita del paciente.
- Ofrece nuevos horarios y confirma la reprogramación.

# Estados de Conversación
[
  {
    "id": "1_greeting",
    "description": "Saludar y ofrecer ayuda.",
    "instructions": ["Da la bienvenida y pregunta cómo puedes ayudar."],
    "examples": ["Hola, bienvenido al sistema de gestión de citas. ¿En qué puedo ayudarte hoy?"],
    "transitions": [{ "next_step": "2_get_identification", "condition": "El usuario quiere reprogramar una cita." }]
  },
  {
    "id": "2_get_identification",
    "description": "Solicitar el número de identificación.",
    "instructions": ["Pide el número de identificación o cédula."],
    "examples": ["Para reprogramar una cita, por favor, indícame tu número de identificación."],
    "transitions": [{ "next_step": "3_get_appointments", "condition": "Se ha proporcionado la identificación." }]
  },
  {
    "id": "3_get_appointments",
    "description": "Obtener y leer las citas existentes.",
    "instructions": ["Llama a 'getExistingAppointments' y lee las citas al paciente."],
    "examples": ["Claro, he encontrado estas citas a tu nombre: [cita1], [cita2], [cita3]. ¿Cuál de ellas te gustaría reprogramar?"],
    "transitions": [{ "next_step": "4_offer_new_slots", "condition": "El paciente ha elegido una cita para reprogramar." }]
  },
  {
    "id": "4_offer_new_slots",
    "description": "Ofrecer nuevos horarios.",
    "instructions": ["Llama a 'getNewAvailableSlots' y presenta las nuevas opciones al paciente."],
    "examples": ["Entendido. Aquí tienes algunos horarios alternativos: [slot1], [slot2], [slot3]. ¿Alguno de estos te viene bien?"],
    "transitions": [{ "next_step": "5_confirm_reschedule", "condition": "El paciente ha elegido un nuevo horario." }]
  },
  {
    "id": "5_confirm_reschedule",
    "description": "Confirmar la reprogramación.",
    "instructions": ["Llama a 'rescheduleAppointment' y confirma la nueva cita al paciente."],
    "examples": ["¡Perfecto! Tu cita ha sido reprogramada para el [nueva fecha] a las [nueva hora]. Gracias por usar nuestro servicio. ¡Adiós!"],
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
        // Mock data, same as cancellation
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
      name: "getNewAvailableSlots",
      description: "Obtiene nuevos horarios disponibles para reprogramar una cita.",
      parameters: {
        type: "object",
        properties: {
          appointmentId: { type: "number", description: "El ID de la cita a reprogramar." },
        },
        required: ["appointmentId"],
        additionalProperties: false,
      },
      execute: async () => {
        // Mock data
        return {
          slots: [
            "El próximo Lunes a las 10:00 AM",
            "El próximo Miércoles a las 4:00 PM",
            "El próximo Viernes a las 8:00 AM"
          ]
        };
      },
    }),
    tool({
      name: "rescheduleAppointment",
      description: "Reprograma una cita médica a un nuevo horario.",
      parameters: {
        type: "object",
        properties: {
          appointmentId: { type: "number", description: "El ID de la cita a reprogramar." },
          newSlot: { type: "string", description: "El nuevo horario elegido." },
        },
        required: ["appointmentId", "newSlot"],
        additionalProperties: false,
      },
      execute: async () => {
        return { success: true };
      },
    }),
  ],
  handoffs: [],
});
