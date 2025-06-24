import { zodTextFormat } from 'openai/helpers/zod';
import { GuardrailOutputZod, GuardrailOutput } from '@/app/types';

// Validator that calls the /api/responses endpoint to
// validates the realtime output according to moderation policies. 
// This will prevent the realtime model from responding in undesired ways
// By sending it a corrective message and having it redirect the conversation.
export async function runGuardrailClassifier(
  message: string,
  companyName: string = 'newTelco',
): Promise<GuardrailOutput> {
  const messages = [
    {
      role: 'user',
      content: `Eres un experto en clasificar texto según políticas de moderación. Considera el mensaje proporcionado, analiza las posibles clases de output_classes y devuelve la mejor clasificación. Emite la respuesta en formato JSON, siguiendo el esquema proporcionado. Mantén tu análisis y razonamiento breves y directos, máximo 2 frases.

      <info>
      - Nombre de la empresa: ${companyName}
      </info>

      <message>
      ${message}
      </message>

      <output_classes>
      - OFFENSIVE: Contenido que incluye discurso de odio, lenguaje discriminatorio, insultos, injurias o acoso.
      - OFF_BRAND: Contenido que habla de competidores de forma despectiva.
      - VIOLENCE: Contenido que incluye amenazas explícitas, incitación al daño o descripciones gráficas de lesiones físicas o violencia.
      - NONE: Si ninguna otra clase es apropiada y el mensaje está bien.
      </output_classes>
      `,
    },
  ];

  const response = await fetch('/api/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      input: messages,
      text: {
        format: zodTextFormat(GuardrailOutputZod, 'output_format'),
      },
    }),
  });

  if (!response.ok) {
    console.warn('Server returned an error:', response);
    return Promise.reject('Error with runGuardrailClassifier.');
  }

  const data = await response.json();

  try {
    const output = GuardrailOutputZod.parse(data.output_parsed);
    return {
      ...output,
      testText: message,
    };
  } catch (error) {
    console.error('Error parsing the message content as GuardrailOutput:', error);
    return Promise.reject('Failed to parse guardrail output.');
  }
}

export interface RealtimeOutputGuardrailResult {
  tripwireTriggered: boolean;
  outputInfo: any;
}

export interface RealtimeOutputGuardrailArgs {
  agentOutput: string;
  agent?: any;
  context?: any;
}

// Creates a guardrail bound to a specific company name for output moderation purposes. 
export function createModerationGuardrail(companyName: string) {
  return {
    name: 'moderation_guardrail',

    async execute({ agentOutput }: RealtimeOutputGuardrailArgs): Promise<RealtimeOutputGuardrailResult> {
      try {
        const res = await runGuardrailClassifier(agentOutput, companyName);
        const triggered = res.moderationCategory !== 'NONE';
        return {
          tripwireTriggered: triggered,
          outputInfo: res,
        };
      } catch {
        return {
          tripwireTriggered: false,
          outputInfo: { error: 'guardrail_failed' },
        };
      }
    },
  } as const;
}