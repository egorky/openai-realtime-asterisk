import { RealtimeItem, tool } from '@openai/agents/realtime';


import {
  exampleAccountInfo,
  examplePolicyDocs,
  exampleStoreLocations,
} from './sampleData';

export const supervisorAgentInstructions = `Eres un agente supervisor experto de servicio al cliente, encargado de proporcionar orientación en tiempo real a un agente junior que está chateando directamente con el cliente. Se te darán instrucciones detalladas de respuesta, herramientas y el historial completo de la conversación hasta el momento, y debes crear un mensaje correcto que el agente junior pueda leer directamente.

# Instrucciones
- Puedes proporcionar una respuesta directamente, o llamar a una herramienta primero y luego responder la pregunta.
- Si necesitas llamar a una herramienta, pero no tienes la información correcta, puedes decirle al agente junior que pida esa información en tu mensaje.
- Tu mensaje será leído textualmente por el agente junior, así que siéntete libre de usarlo como si hablaras directamente con el usuario.
  
==== Instrucciones Específicas del Dominio del Agente ====
Eres un útil agente de servicio al cliente que trabaja para NewTelco, ayudando a un usuario a cumplir eficientemente su solicitud mientras te adhieres estrictamente a las directrices proporcionadas.

# Instrucciones
- Siempre saluda al usuario al inicio de la conversación con "Hola, te comunicaste con NewTelco, ¿en qué puedo ayudarte?"
- Siempre llama a una herramienta antes de responder preguntas factuales sobre la empresa, sus ofertas o productos, o la cuenta de un usuario. Solo usa el contexto recuperado y nunca confíes en tu propio conocimiento para ninguna de estas preguntas.
- Escala a un humano si el usuario lo solicita.
- No discutas temas prohibidos (política, religión, eventos actuales controvertidos, asesoramiento médico, legal o financiero, conversaciones personales, operaciones internas de la empresa o críticas a personas o empresas).
- Apóyate en frases de muestra siempre que sea apropiado, pero nunca repitas una frase de muestra en la misma conversación. Siéntete libre de variar las frases de muestra para evitar sonar repetitivo y hacerla más apropiada para el usuario.
- Siempre sigue el formato de salida proporcionado para nuevos mensajes, incluyendo citas para cualquier declaración factual de documentos de política recuperados.

# Instrucciones de Respuesta
- Mantén un tono profesional y conciso en todas las respuestas.
- Responde apropiadamente dadas las directrices anteriores.
- El mensaje es para una conversación de voz, así que sé muy conciso, usa prosa y nunca crees listas con viñetas. Prioriza la brevedad y la claridad sobre la exhaustividad.
    - Incluso si tienes acceso a más información, solo menciona un par de los elementos más importantes y resume el resto a un alto nivel.
- No especules ni hagas suposiciones sobre capacidades o información. Si una solicitud no puede cumplirse con las herramientas o información disponibles, niégala cortésmente y ofrece escalar a un representante humano.
- Si no tienes toda la información requerida para llamar a una herramienta, DEBES pedir al usuario la información faltante en tu mensaje. NUNCA intentes llamar a una herramienta con valores faltantes, vacíos, de marcador de posición o predeterminados (como "", "REQUERIDO", "nulo" o similar). Solo llama a una herramienta cuando tengas todos los parámetros requeridos proporcionados por el usuario.
- No ofrezcas ni intentes cumplir solicitudes de capacidades o servicios no admitidos explícitamente por tus herramientas o la información proporcionada.
- Solo ofrece proporcionar más información si sabes que hay más información disponible para proporcionar, según las herramientas y el contexto que tengas.
- Cuando sea posible, proporciona números específicos o montos en dólares para fundamentar tu respuesta.

# Frases de Muestra
## Desviar un Tema Prohibido
- "Lo siento, pero no puedo hablar sobre ese tema. ¿Hay algo más en lo que pueda ayudarte?"
- "Eso no es algo sobre lo que pueda proporcionar información, pero estaré encantado de ayudarte con cualquier otra pregunta que puedas tener."

## Si no tienes una herramienta o información para cumplir una solicitud
- "Lo siento, en realidad no puedo hacer eso. ¿Te gustaría que te transfiera con alguien que pueda ayudar, o ayudarte a encontrar tu tienda NewTelco más cercana?"
- "No puedo ayudarte con esa solicitud. ¿Te gustaría hablar con un representante humano, o te gustaría ayuda para encontrar tu tienda NewTelco más cercana?"

## Antes de llamar a una herramienta
- "Para ayudarte con eso, solo necesitaré verificar tu información."
- "Déjame verificar eso por ti, un momento, por favor."
- "Recuperaré los detalles más recientes para ti ahora."

## Si falta información requerida para una llamada a herramienta
- "Para ayudarte con eso, ¿podrías proporcionar tu [información requerida, p. ej., código postal/número de teléfono]?"
- "Necesitaré tu [información requerida] para continuar. ¿Podrías compartirla conmigo?"

# Formato del Mensaje del Usuario
- Siempre incluye tu respuesta final al usuario.
- Al proporcionar información factual de un contexto recuperado, siempre incluye citas inmediatamente después de la(s) declaración(es) relevante(s). Usa el siguiente formato de cita:
    - Para una única fuente: [NOMBRE](ID)
    - Para múltiples fuentes: [NOMBRE](ID), [NOMBRE](ID)
- Solo proporciona información sobre esta empresa, sus políticas, sus productos o la cuenta del cliente, y solo si se basa en información proporcionada en el contexto. No respondas preguntas fuera de este alcance.

# Ejemplo (llamada a herramienta)
- Usuario: ¿Puedes contarme sobre tus opciones de plan familiar?
- Asistente Supervisor: lookup_policy_document(topic="opciones de plan familiar")
- lookup_policy_document(): [
  {
    id: "ID-010",
    name: "Política del Plan Familiar",
    topic: "opciones de plan familiar",
    content:
      "El plan familiar permite hasta 5 líneas por cuenta. Todas las líneas comparten un único grupo de datos. Cada línea adicional después de la primera recibe un descuento del 10%. Todas las líneas deben estar en la misma cuenta.",
  },
  {
    id: "ID-011",
    name: "Política de Datos Ilimitados",
    topic: "datos ilimitados",
    content:
      "Los planes de datos ilimitados proporcionan datos de alta velocidad hasta 50GB por mes. Después de 50GB, las velocidades pueden reducirse durante la congestión de la red. Todas las líneas en un plan familiar comparten el mismo grupo de datos. Los planes ilimitados están disponibles tanto para cuentas individuales como familiares.",
  },
];
- Asistente Supervisor:
# Message
Sí, tenemos: hasta cinco líneas pueden compartir datos y obtienes un descuento del 10% por cada nueva línea [Política del Plan Familiar](ID-010).

# Ejemplo (Rechazo por Solicitud no Soportada)
- Usuario: ¿Puedo hacer un pago por teléfono ahora mismo?
- Asistente Supervisor:
# Message
Lo siento, pero no puedo procesar pagos por teléfono. ¿Te gustaría que te conecte con un representante humano o te ayude a encontrar tu tienda NewTelco más cercana para obtener más ayuda?
`;

export const supervisorAgentTools = [
  {
    type: "function",
    name: "lookupPolicyDocument",
    description:
      "Herramienta para buscar documentos y políticas internas por tema o palabra clave.",
    parameters: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description:
            "El tema o palabra clave para buscar en las políticas o documentos de la empresa.",
        },
      },
      required: ["topic"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "getUserAccountInfo",
    description:
      "Herramienta para obtener información de la cuenta del usuario. Esto solo lee la información de las cuentas de los usuarios y no proporciona la capacidad de modificar o eliminar ningún valor.",
    parameters: {
      type: "object",
      properties: {
        phone_number: {
          type: "string",
          description:
            "Formateado como '(xxx) xxx-xxxx'. DEBE ser proporcionado por el usuario, nunca una cadena nula o vacía.",
        },
      },
      required: ["phone_number"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "findNearestStore",
    description:
      "Herramienta para encontrar la ubicación de la tienda más cercana a un cliente, dado su código postal.",
    parameters: {
      type: "object",
      properties: {
        zip_code: {
          type: "string",
          description: "El código postal de 5 dígitos del cliente.",
        },
      },
      required: ["zip_code"],
      additionalProperties: false,
    },
  },
];

async function fetchResponsesMessage(body: any) {
  const response = await fetch('/api/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    // Preserve the previous behaviour of forcing sequential tool calls.
    body: JSON.stringify({ ...body, parallel_tool_calls: false }),
  });

  if (!response.ok) {
    console.warn('El servidor devolvió un error:', response); // Traducido
    return { error: 'Algo salió mal.' }; // Traducido
  }

  const completion = await response.json();
  return completion;
}

function getToolResponse(fName: string) {
  switch (fName) {
    case "getUserAccountInfo":
      return exampleAccountInfo;
    case "lookupPolicyDocument":
      return examplePolicyDocs;
    case "findNearestStore":
      return exampleStoreLocations;
    default:
      return { result: true };
  }
}

/**
 * Iteratively handles function calls returned by the Responses API until the
 * supervisor produces a final textual answer. Returns that answer as a string.
 */
/**
 * Maneja iterativamente las llamadas a funciones devueltas por la API de Respuestas hasta que el
 * supervisor produce una respuesta textual final. Devuelve esa respuesta como una cadena.
 */
async function handleToolCalls(
  body: any,
  response: any,
  addBreadcrumb?: (title: string, data?: any) => void,
) {
  let currentResponse = response;

  while (true) {
    if (currentResponse?.error) {
      return { error: 'Algo salió mal.' } as any; // Traducido
    }

    const outputItems: any[] = currentResponse.output ?? [];

    // Gather all function calls in the output.
    // Recopilar todas las llamadas a funciones en la salida.
    const functionCalls = outputItems.filter((item) => item.type === 'function_call');

    if (functionCalls.length === 0) {
      // No more function calls – build and return the assistant's final message.
      // No más llamadas a funciones – construir y devolver el mensaje final del asistente.
      const assistantMessages = outputItems.filter((item) => item.type === 'message');

      const finalText = assistantMessages
        .map((msg: any) => {
          const contentArr = msg.content ?? [];
          return contentArr
            .filter((c: any) => c.type === 'output_text')
            .map((c: any) => c.text)
            .join('');
        })
        .join('\n');

      return finalText;
    }

    // For each function call returned by the supervisor model, execute it locally and append its
    // output to the request body as a `function_call_output` item.
    // Para cada llamada a función devuelta por el modelo supervisor, ejecútala localmente y añade su
    // salida al cuerpo de la solicitud como un elemento `function_call_output`.
    for (const toolCall of functionCalls) {
      const fName = toolCall.name;
      const args = JSON.parse(toolCall.arguments || '{}');
      const toolRes = getToolResponse(fName);

      // Since we're using a local function, we don't need to add our own breadcrumbs
      // Como estamos usando una función local, no necesitamos añadir nuestros propios breadcrumbs
      if (addBreadcrumb) {
        addBreadcrumb(`[supervisorAgent] llamada a función: ${fName}`, args);
      }
      if (addBreadcrumb) {
        addBreadcrumb(`[supervisorAgent] resultado de llamada a función: ${fName}`, toolRes);
      }

      // Add function call and result to the request body to send back to realtime
      // Añadir llamada a función y resultado al cuerpo de la solicitud para enviar de vuelta a realtime
      body.input.push(
        {
          type: 'function_call',
          call_id: toolCall.call_id,
          name: toolCall.name,
          arguments: toolCall.arguments,
        },
        {
          type: 'function_call_output',
          call_id: toolCall.call_id,
          output: JSON.stringify(toolRes),
        },
      );
    }

    // Make the follow-up request including the tool outputs.
    // Realizar la solicitud de seguimiento incluyendo las salidas de las herramientas.
    currentResponse = await fetchResponsesMessage(body);
  }
}

export const getNextResponseFromSupervisor = tool({
  name: 'getNextResponseFromSupervisor',
  description:
    'Determina la siguiente respuesta siempre que el agente se enfrente a una decisión no trivial, producida por un agente supervisor altamente inteligente. Devuelve un mensaje describiendo qué hacer a continuación.',
  parameters: {
    type: 'object',
    properties: {
      relevantContextFromLastUserMessage: {
        type: 'string',
        description:
          'Información clave del usuario descrita en su mensaje más reciente. Es crítico proporcionar esto ya que el agente supervisor con contexto completo podría no tener disponible el último mensaje. Se puede omitir si el mensaje del usuario no añadió nueva información.',
      },
    },
    required: ['relevantContextFromLastUserMessage'],
    additionalProperties: false,
  },
  execute: async (input, details) => {
    const { relevantContextFromLastUserMessage } = input as {
      relevantContextFromLastUserMessage: string;
    };

    const addBreadcrumb = (details?.context as any)?.addTranscriptBreadcrumb as
      | ((title: string, data?: any) => void)
      | undefined;

    const history: RealtimeItem[] = (details?.context as any)?.history ?? [];
    const filteredLogs = history.filter((log) => log.type === 'message');

    const body: any = {
      model: 'gpt-4.1',
      input: [
        {
          type: 'message',
          role: 'system',
          content: supervisorAgentInstructions,
        },
        {
          type: 'message',
          role: 'user',
          content: `==== Historial de Conversación ====
          ${JSON.stringify(filteredLogs, null, 2)}
          
          ==== Contexto Relevante del Último Mensaje del Usuario ===
          ${relevantContextFromLastUserMessage}
          `,
        },
      ],
      tools: supervisorAgentTools,
    };

    const response = await fetchResponsesMessage(body);
    if (response.error) {
      return { error: 'Algo salió mal.' }; // Traducido
    }

    const finalText = await handleToolCalls(body, response, addBreadcrumb);
    if ((finalText as any)?.error) {
      return { error: 'Algo salió mal.' }; // Traducido
    }

    return { nextResponse: finalText as string };
  },
});
  