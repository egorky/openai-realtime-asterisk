import { authenticationAgent } from './authentication';
import { returnsAgent } from './returns';
import { salesAgent } from './sales';
import { simulatedHumanAgent } from './simulatedHuman';

// Cast to `any` to satisfy TypeScript until the core types make RealtimeAgent
// assignable to `Agent<unknown>` (current library versions are invariant on
// the context type).
(authenticationAgent.handoffs as any).push(returnsAgent, salesAgent, simulatedHumanAgent);
(returnsAgent.handoffs as any).push(authenticationAgent, salesAgent, simulatedHumanAgent);
(salesAgent.handoffs as any).push(authenticationAgent, returnsAgent, simulatedHumanAgent);
(simulatedHumanAgent.handoffs as any).push(authenticationAgent, returnsAgent, salesAgent);

export const customerServiceRetailScenario = [
  authenticationAgent,
  returnsAgent,
  salesAgent,
  simulatedHumanAgent,
];

// Nombre de la empresa representada por este conjunto de agentes. Usado por los guardrails.
export const customerServiceRetailCompanyName = 'Tablas Pico Nevado'; // Translated
