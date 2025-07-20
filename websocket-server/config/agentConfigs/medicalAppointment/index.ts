import { schedulingAgent } from './scheduling';
import { cancellationAgent } from './cancellation';
import { reschedulingAgent } from './rescheduling';
import { simulatedHumanAgent } from './simulatedHuman';

(schedulingAgent.handoffs as any).push(cancellationAgent, reschedulingAgent, simulatedHumanAgent);
(cancellationAgent.handoffs as any).push(schedulingAgent, reschedulingAgent, simulatedHumanAgent);
(reschedulingAgent.handoffs as any).push(schedulingAgent, cancellationAgent, simulatedHumanAgent);
(simulatedHumanAgent.handoffs as any).push(schedulingAgent, cancellationAgent, reschedulingAgent);

export const medicalAppointmentScenario = [
  schedulingAgent,
  cancellationAgent,
  reschedulingAgent,
  simulatedHumanAgent,
];

export const medicalAppointmentCompanyName = 'Servicios Médicos Vitales';
