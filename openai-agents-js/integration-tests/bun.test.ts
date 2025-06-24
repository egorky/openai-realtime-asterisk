import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { execa as execaBase } from 'execa';

const execa = execaBase({ cwd: './integration-tests/bun' });

describe('Bun', () => {
  beforeAll(async () => {
    // remove lock file to avoid errors
    await execa`rm -f bun.lock`;
    console.log('[bun] Removing node_modules');
    await execa`rm -rf node_modules`;
    console.log('[bun] Installing dependencies');
    await execa`bun install`;
  }, 60000);

  test('should be able to run', async () => {
    const { stdout } = await execa`bun run index.ts`;
    expect(stdout).toContain('[RESPONSE]Hello there![/RESPONSE]');
  });

  afterAll(async () => {
    await execa`rm -f bun.lock`;
  });
});
