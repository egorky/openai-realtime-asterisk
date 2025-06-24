// @ts-check

import {
  Agent,
  run,
  setTraceProcessors,
  ConsoleSpanExporter,
  BatchTraceProcessor,
} from '@openai/agents';

setTraceProcessors([new BatchTraceProcessor(new ConsoleSpanExporter())]);

const agent = new Agent({
  name: 'Test Agent',
  instructions:
    'You will always only respond with "Hello there!". Not more not less.',
});

const result = await run(agent, 'Hey there!');
console.log(`[RESPONSE]${result.finalOutput}[/RESPONSE]`);
