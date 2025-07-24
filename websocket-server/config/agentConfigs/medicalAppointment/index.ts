import { authenticationAgent } from './authentication';
import { schedulingAgent } from './scheduling';
import { cancellationAgent } from './cancellation';
import { reschedulingAgent } from './rescheduling';
import { simulatedHumanAgent } from './simulatedHuman';

// El agente de autenticación puede transferir a cualquier otro agente de servicio.
authenticationAgent.handoffs = [schedulingAgent, cancellationAgent, reschedulingAgent, simulatedHumanAgent];

// Cada agente de servicio puede transferir a cualquier otro agente de servicio.
schedulingAgent.handoffs = [cancellationAgent, reschedulingAgent, authenticationAgent];
cancellationAgent.handoffs = [schedulingAgent, reschedulingAgent, authenticationAgent];
reschedulingAgent.handoffs = [schedulingAgent, cancellationAgent, authenticationAgent];

// El agente humano simulado puede ser transferido desde cualquier agente de servicio.
(schedulingAgent.handoffs as any).push(simulatedHumanAgent);
(cancellationAgent.handoffs as any).push(simulatedHumanAgent);
(reschedulingAgent.handoffs as any).push(simulatedHumanAgent);

// El agente humano simulado puede transferir a cualquier agente de servicio.
(simulatedHumanAgent.handoffs as any).push(schedulingAgent, cancellationAgent, reschedulingAgent, authenticationAgent);


export const medicalAppointmentScenario = [
  authenticationAgent,
  schedulingAgent,
  cancellationAgent,
  reschedulingAgent,
  simulatedHumanAgent,
];

export const medicalAppointmentCompanyName = 'Vida Sana S.A.';
