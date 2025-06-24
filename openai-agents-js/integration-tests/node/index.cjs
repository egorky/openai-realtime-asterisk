// @ts-check

const {
  Agent,
  run,
  setTraceProcessors,
  ConsoleSpanExporter,
  BatchTraceProcessor,
} = require('@openai/agents');
const { assert } = require('node:console');

setTraceProcessors([new BatchTraceProcessor(new ConsoleSpanExporter())]);

const agent = new Agent({
  name: 'Test Agent',
  instructions:
    'You will always only respond with "Hello there!". Not more not less.',
});

async function main() {
  const result = await run(agent, 'Hey there!');
  console.log(`[RESPONSE]${result.finalOutput}[/RESPONSE]`);
}

main().catch(console.error);
