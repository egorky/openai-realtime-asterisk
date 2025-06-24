import { describe, it, expect } from 'vitest';
import { serializeTool, serializeHandoff } from '../../src/utils/serialize';

describe('serialize utilities', () => {
  it('serializes function tools', () => {
    const t: any = {
      type: 'function',
      name: 'fn',
      description: 'desc',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      strict: true,
    };
    expect(serializeTool(t)).toEqual({
      type: 'function',
      name: 'fn',
      description: 'desc',
      parameters: t.parameters,
      strict: true,
    });
  });

  it('serializes computer tools', () => {
    const t: any = {
      type: 'computer',
      name: 'comp',
      computer: { environment: 'node', dimensions: { width: 1, height: 2 } },
    };
    expect(serializeTool(t)).toEqual({
      type: 'computer',
      name: 'comp',
      environment: 'node',
      dimensions: { width: 1, height: 2 },
    });
  });

  it('serializes hosted tools', () => {
    const t: any = { type: 'hosted_tool', name: 'bt', providerData: { a: 1 } };
    expect(serializeTool(t)).toEqual({
      type: 'hosted_tool',
      name: 'bt',
      providerData: { a: 1 },
    });
  });

  it('serializeHandoff', () => {
    const h: any = {
      toolName: 'hn',
      toolDescription: 'desc',
      inputJsonSchema: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      strictJsonSchema: false,
    };
    expect(serializeHandoff(h)).toEqual({
      toolName: 'hn',
      toolDescription: 'desc',
      inputJsonSchema: h.inputJsonSchema,
      strictJsonSchema: false,
    });
  });
});
