# Configuración de Nuevos Agentes Virtuales (Escenarios)

Este documento explica cómo los desarrolladores pueden configurar nuevos escenarios de agentes virtuales para el sistema `websocket-server`. Un escenario define el comportamiento, las instrucciones, las herramientas y la personalidad del asistente de IA que interactuará con el llamante.

## 1. Definición del Escenario del Agente

Los escenarios de agentes se definen en el directorio `websocket-server/config/agentConfigs/`. Cada escenario es típicamente un array de objetos `RealtimeAgent` de la librería `@openai/agents/realtime`.

### Estructura de un `RealtimeAgent`

Un objeto `RealtimeAgent` tiene la siguiente estructura básica:

```typescript
import { RealtimeAgent, tool } from '@openai/agents/realtime';

export const miAgenteEspecifico = new RealtimeAgent({
  name: 'nombreTecnicoDelAgente', // Identificador único para el agente (mantener en inglés)
  voice: 'nombreDeVozTTS',      // Nombre de la voz para Text-to-Speech (ej. 'alloy', 'echo')

  instructions: `AQUÍ VAN LAS INSTRUCCIONES DETALLADAS PARA EL AGENTE.
  Esto incluye:
  - # Personalidad y Tono (Identidad, Tarea, Comportamiento, Tono, etc.)
  - # Contexto (Nombre de la empresa, horarios, productos)
  - # Instrucciones Generales de Comportamiento
  - # Estados de Conversación (si aplica, para guiar el flujo)
  ... y cualquier otra directriz específica.`,

  tools: [ // Array de herramientas que este agente puede usar
    tool({
      name: "nombre_de_la_herramienta_1",
      description: "Descripción de lo que hace la herramienta y cuándo usarla.",
      parameters: { // Esquema JSON para los parámetros de la herramienta
        type: "object",
        properties: {
          parametro1: {
            type: "string",
            description: "Descripción del parámetro 1."
          },
          parametro2: {
            type: "number",
            description: "Descripción del parámetro 2."
          }
        },
        required: ["parametro1"] // Lista de parámetros obligatorios
      },
      // La función 'execute' aquí es opcional si la herramienta es manejada centralmente
      // por toolExecutor.ts. Si se define aquí, esta lógica se usará.
      // execute: async (args) => { /* lógica de la herramienta */ return { resultado: "ok" }; }
    }),
    // ... más herramientas
  ],

  handoffDescription: 'Breve descripción para transferencias a este agente.', // Usada si otros agentes pueden transferir a este.

  handoffs: [/* array de otros objetos RealtimeAgent a los que este agente puede transferir */],
});

// Un escenario puede consistibir en uno o más agentes
export const miNuevoEscenario = [miAgenteEspecifico, /* otrosAgentesSiEsNecesario */];
```

**Puntos Clave:**
*   **`name`**: Un identificador técnico único para el agente. Se recomienda mantenerlo en inglés y usar camelCase o snake_case.
*   **`voice`**: El nombre de la voz TTS de OpenAI que usará el agente.
*   **`instructions`**: Un string detallado (puede ser multi-línea usando backticks \`) que define la personalidad, el rol, el contexto del negocio, las reglas de conversación y cualquier estado o flujo específico que el agente deba seguir. Es crucial ser muy específico aquí.
*   **`tools`**: Un array de definiciones de herramientas. Cada herramienta tiene un `name`, `description` (para que el modelo de IA sepa cuándo usarla) y un `parameters` (esquema JSON que define los argumentos que la herramienta espera).
*   **`handoffDescription`**: Una descripción breve que otros agentes pueden usar para saber cuándo transferir la conversación a este agente.
*   **`handoffs`**: Un array de otros `RealtimeAgent` a los que este agente puede decidir transferir la conversación.

**Traducción:** Todos los textos orientados al usuario o que el modelo de IA usará para formular respuestas (como `instructions`, `description` de herramientas, `description` de parámetros, `handoffDescription`) deben estar en **español**. Los nombres técnicos (`name` de agente, `name` de herramienta, nombres de parámetros en el esquema) deben permanecer en inglés para consistencia del sistema.

## 2. Implementación de la Lógica de las Herramientas

Si defines nuevas herramientas que requieren lógica personalizada (más allá de simples simulaciones), esta lógica debe implementarse en `websocket-server/src/toolExecutor.ts`.

*   Abre `src/toolExecutor.ts`.
*   Añade una nueva función `async function miNuevaHerramienta(args: any, callLogger: LoggerInstance): Promise<any>` que tome los argumentos parseados y una instancia de logger.
*   Implementa la lógica de tu herramienta dentro de esta función. Puede ser una llamada a una API externa, una consulta a una base de datos, o cualquier otra acción.
*   Asegúrate de que la función devuelva un objeto JSON serializable como resultado.
*   Añade un nuevo `case` al `switch (toolName)` dentro de la función `executeTool` para llamar a tu nueva función:

```typescript
// Dentro de src/toolExecutor.ts, en la función executeTool

// ... otros casos ...
case 'nombre_de_la_herramienta_1': // Debe coincidir con el 'name' en la definición de la herramienta
  resultData = await miNuevaHerramienta(parsedArgs, callLogger);
  break;
// ...
```

Si la herramienta es muy simple y solo devuelve datos estáticos o simulados, puedes definir la función `execute` directamente en la configuración del agente, como se muestra en el ejemplo de `RealtimeAgent`. Sin embargo, para una lógica más compleja o para mantener la consistencia, se recomienda centralizar la ejecución en `toolExecutor.ts`.

## 3. Registro del Nuevo Escenario

Una vez que hayas definido tu(s) agente(s) y el escenario (array de agentes):

*   Abre `websocket-server/config/agentConfigs/index.ts`.
*   Importa tu nuevo escenario:
    ```typescript
    import { miNuevoEscenario } from './ruta/a/tu/archivoDeEscenario';
    ```
*   Añade tu escenario al objeto `allAgentSets` con una clave única:
    ```typescript
    export const allAgentSets: Record<string, RealtimeAgent[]> = {
      simpleHandoff: simpleHandoffScenario,
      customerServiceRetail: customerServiceRetailScenario,
      chatSupervisor: chatSupervisorScenario,
      miEscenarioClave: miNuevoEscenario, // <-- Añade tu escenario aquí
    };
    ```
    La `miEscenarioClave` será el valor que uses en la variable de entorno para activar este escenario.

## 4. Selección del Escenario Activo

Para que el sistema utilice tu nuevo escenario:

*   Establece la variable de entorno `ACTIVE_AGENT_CONFIG_KEY` al valor de la clave que usaste en `allAgentSets`.
*   Puedes hacerlo en tu archivo `.env` en el directorio `websocket-server`:
    ```env
    ACTIVE_AGENT_CONFIG_KEY="miEscenarioClave"
    ```
*   Si esta variable no está definida, el sistema usará el valor de `defaultAgentSetKey` de `config/agentConfigs/index.ts`.

## 5. Consideraciones Adicionales

*   **Pruebas**: Prueba exhaustivamente tu nuevo escenario para asegurar que el agente se comporta como se espera, las herramientas se llaman correctamente y el flujo de conversación es natural.
*   **Instrucciones Detalladas**: Cuanto más detalladas y claras sean las `instructions` para tu agente, mejor será su rendimiento. Considera usar secciones como se muestra en `customerServiceRetail/authentication.ts` para estructurar las instrucciones (Personalidad, Tarea, Contexto, etc.).
*   **Manejo de Errores**: Considera cómo tu agente y tus herramientas deben manejar errores o situaciones inesperadas.
*   **Seguridad**: Si tus herramientas interactúan con APIs externas o datos sensibles, asegúrate de seguir las mejores prácticas de seguridad.

Siguiendo estos pasos, puedes crear y integrar nuevos agentes virtuales personalizados en el sistema.
