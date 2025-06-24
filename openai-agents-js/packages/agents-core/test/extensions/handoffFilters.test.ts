import { describe, test, expect } from 'vitest';
import { removeAllTools } from '../../src/extensions';

describe('removeAllTools', () => {
  test('should be available', () => {
    const result = removeAllTools({
      inputHistory: [],
      preHandoffItems: [],
      newItems: [],
    });
    expect(result).toEqual({
      inputHistory: [],
      preHandoffItems: [],
      newItems: [],
    });
  });
});
