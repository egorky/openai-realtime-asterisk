# Guía para Crear y Configurar Nuevos Escenarios de Agentes

Esta guía proporciona un tutorial completo sobre cómo crear, configurar y personalizar nuevos escenarios de agentes de voz en tiempo real dentro de este proyecto.

## 1. Concepto de Escenario

Un **escenario** es un conjunto de agentes configurados para manejar un flujo de conversación específico. Por ejemplo, un escenario de "atención al cliente" puede tener agentes para ventas, devoluciones y soporte técnico, mientras que un escenario de "citas médicas" puede tener agentes para agendar, cancelar y reprogramar.

El sistema puede tener múltiples escenarios definidos, pero solo uno estará activo a la vez.

## 2. Estructura de Archivos de un Escenario

Para mantener el código organizado, cada escenario debe vivir en su propio directorio dentro de `websocket-server/config/agentConfigs/`.

La estructura recomendada es la siguiente:

```
websocket-server/config/agentConfigs/
└── nombreDelEscenario/
    ├── index.ts
    ├── agente1.ts
    ├── agente2.ts
    └── ... (otros archivos de agentes)
```

-   **`nombreDelEscenario/`**: Un directorio con un nombre descriptivo para tu escenario (ej. `citasMedicas`).
-   **`agente1.ts`, `agente2.ts`, ...**: Cada archivo define un `RealtimeAgent` especializado en una tarea (ej. `saludo.ts`, `agendamiento.ts`).
-   **`index.ts`**: El archivo principal que exporta el escenario completo y define las interacciones (transferencias o "handoffs") entre los agentes.

## 3. Creando un Agente

Cada agente se define en su propio archivo TypeScript como una instancia de `RealtimeAgent`.

**Ejemplo de `agente.ts`:**

```typescript
import { RealtimeAgent, tool } from '@openai/agents/realtime';

export const miAgente = new RealtimeAgent({
  // 1. Identificador y Voz
  name: 'nombreUnicoDelAgente', // Identificador técnico, en inglés.
  voice: 'nova', // Nombre de la voz TTS de OpenAI.

  // 2. Descripción para Transferencias
  handoffDescription: 'Descripción de lo que hace este agente, para que otros agentes sepan cuándo transferirle la llamada.',

  // 3. Instrucciones (El "cerebro" del agente)
  instructions: `
    # Contexto General
    - La fecha y hora actual es: ${new Date().toLocaleString()}
    - Nombre de la empresa: Mi Empresa S.A.

    # Personalidad y Tono
    // Describe cómo debe comportarse y sonar el agente.

    # Flujo de Conversación
    // Define los pasos o estados por los que debe pasar la conversación.
  `,

  // 4. Herramientas (APIs)
  tools: [
    tool({
      name: 'nombreDeLaHerramienta',
      description: 'Qué hace esta herramienta.',
      parameters: {
        type: 'object',
        properties: {
          param1: { type: 'string', description: 'Descripción del parámetro.' },
        },
        required: ['param1'],
        additionalProperties: false, // ¡Importante! Siempre incluir esto.
      },
      execute: async ({ param1 }) => {
        // Lógica de la herramienta (ej. llamar a una API real).
        return { success: true, data: `Recibido: ${param1}` };
      },
    }),
  ],

  // 5. Transferencias (Handoffs)
  handoffs: [], // Se define en el index.ts del escenario.
});
```

### Propiedades Clave del Agente:

-   **`name`**: Un identificador único para el agente.
-   **`voice`**: La voz de Text-to-Speech a utilizar. Las voces soportadas por OpenAI son: `alloy`, `ash`, `ballad`, `coral`, `echo`, `fable`, `onyx`, `nova`, `sage`, `shimmer`, y `verse`. **Importante**: Esta configuración puede ser sobreescrita por la configuración de la sesión en la UI o por variables de entorno. Si un cambio de voz no funciona, es probable que se esté aplicando una configuración global.
-   **`handoffDescription`**: Una descripción que otros agentes usan para decidir si deben transferir la conversación a este agente.
-   **`instructions`**: El prompt principal del sistema. Aquí defines su personalidad, tareas, contexto y flujo de la conversación.
-   **`tools`**: Un array de herramientas (funciones) que el agente puede ejecutar, como llamar a APIs.
-   **`handoffs`**: Un array de otros agentes a los que este agente puede transferir la conversación. Se suele dejar vacío aquí y se rellena en el `index.ts`.

## 4. Configurando el Escenario en `index.ts`

El `index.ts` de tu escenario une a todos los agentes y define sus interacciones.

**Ejemplo de `nombreDelEscenario/index.ts`:**

```typescript
// 1. Importar todos los agentes del escenario
import { agenteDeSaludo } from './saludo';
import { agenteDeAgendamiento } from './agendamiento';
import { agenteDeCancelacion } from './cancelacion';

// 2. Definir las transferencias (handoffs)
// Desde el agente de saludo, se puede pasar a los otros dos.
(agenteDeSaludo.handoffs as any).push(agenteDeAgendamiento, agenteDeCancelacion);

// Los otros agentes pueden volver al de saludo o entre ellos si el usuario cambia de tema.
(agenteDeAgendamiento.handoffs as any).push(agenteDeCancelacion, agenteDeSaludo);
(agenteDeCancelacion.handoffs as any).push(agenteDeAgendamiento, agenteDeSaludo);

// 3. Exportar el escenario completo
export const miEscenarioCompleto = [
  agenteDeSaludo, // El primer agente en la lista es el agente de entrada.
  agenteDeAgendamiento,
  agenteDeCancelacion,
];

// (Opcional) Exportar metadatos del escenario
export const nombreDeLaEmpresa = 'Mi Empresa S.A.';
```

### Puntos Clave del `index.ts`:

-   **Agente de Entrada**: El primer agente que aparece en el array exportado (en el ejemplo, `agenteDeSaludo`) será el **agente de entrada** del escenario, es decir, el primero en responder la llamada.
-   **Handoffs**: Se configuran las posibles transiciones entre agentes. Esto le da al sistema la capacidad de pasar la conversación de un especialista a otro de forma fluida.

### 4.1. Usando un Agente Supervisor para Enrutamiento (Avanzado)

Para escenarios más complejos donde la primera interacción del usuario determina el flujo completo de la llamada (ej. agendar, cancelar o reprogramar), puedes usar un **agente supervisor**.

Un agente supervisor es un agente especial, sin herramientas y con instrucciones muy simples, cuyo único propósito es decidir a qué otro agente transferir la llamada.

**Creación del Supervisor (`supervisor.ts`):**

```typescript
import { RealtimeAgent } from '@openai/agents/realtime';
import { agenteAgendamiento } from './agendamiento';
import { agenteCancelacion } from './cancelacion';

export const miSupervisor = new RealtimeAgent({
  name: 'miSupervisor',
  voice: 'echo', // Voz neutral, no hablará.
  handoffDescription: 'Supervisor que enruta la llamada.',
  instructions: `
    # Rol
    Eres un supervisor que enruta llamadas. Analiza la petición del usuario y transfiérelo inmediatamente al agente correcto. No hables.

    # Agentes
    - **agenteAgendamiento**: Para agendar citas.
    - **agenteCancelacion**: Para cancelar citas.
  `,
  tools: [],
  handoffs: [agenteAgendamiento, agenteCancelacion], // Puede transferir a estos agentes.
});
```

**Modificación del `index.ts` del Escenario:**

Para usar el supervisor, colócalo como el **primer agente** en el array del escenario.

```typescript
import { miSupervisor } from './supervisor';
// ... otras importaciones

export const miEscenarioCompleto = [
  miSupervisor, // El supervisor es ahora el agente de entrada.
  agenteDeAgendamiento,
  agenteDeCancelacion,
];
```

Ahora, cuando una llamada entre, `miSupervisor` la recibirá, analizará la intención del usuario y la transferirá silenciosamente al agente correspondiente.

## 5. Activando tu Nuevo Escenario

Finalmente, para que el sistema reconozca tu nuevo escenario, debes registrarlo en el `index.ts` principal de configuraciones:

**Archivo a modificar:** `websocket-server/config/agentConfigs/index.ts`

```typescript
// 1. Importa tu escenario
import { miEscenarioCompleto } from './nombreDelEscenario';
// ... otras importaciones

// 2. Añade tu escenario al mapa de agentes
export const allAgentSets: Record<string, RealtimeAgent[]> = {
  // ... otros escenarios
  nombreDelEscenario: miEscenarioCompleto,
};

// 3. (Opcional) Establece tu escenario como el predeterminado al iniciar
export const defaultAgentSetKey = 'nombreDelEscenario';
```

Con estos pasos, has creado, configurado y activado un nuevo escenario de agente de voz completamente funcional.
