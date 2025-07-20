import { schedulingAgent } from './scheduling';
import { cancellationAgent } from './cancellation';
import { reschedulingAgent } from './rescheduling';
import { simulatedHumanAgent } from './simulatedHuman';

// Cada agente de servicio puede transferir a cualquier otro agente de servicio.
schedulingAgent.handoffs = [cancellationAgent, reschedulingAgent];
cancellationAgent.handoffs = [schedulingAgent, reschedulingAgent];
reschedulingAgent.handoffs = [schedulingAgent, cancellationAgent];

// El agente humano simulado puede ser transferido desde cualquier agente de servicio.
(schedulingAgent.handoffs as any).push(simulatedHumanAgent);
(cancellationAgent.handoffs as any).push(simulatedHumanAgent);
(reschedulingAgent.handoffs as any).push(simulatedHumanAgent);

// El agente humano simulado puede transferir a cualquier agente de servicio.
(simulatedHumanAgent.handoffs as any).push(schedulingAgent, cancellationAgent, reschedulingAgent);


export const medicalAppointmentScenario = [
  schedulingAgent,
  cancellationAgent,
  reschedulingAgent,
  simulatedHumanAgent,
];

export const medicalAppointmentCompanyName = 'Vida Sana S.A.';
