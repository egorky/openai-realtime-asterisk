import { describe, test, expect } from 'vitest';
import { toSmartString } from '../../src/utils/smartString';

describe('toSmartString()', () => {
  test('should convert null to string', () => {
    expect(toSmartString(null)).toBe('null');
  });
  test('should convert undefined to string', () => {
    expect(toSmartString(undefined)).toBe('undefined');
  });
  test('should convert string to string', () => {
    expect(toSmartString('test')).toBe('test');
  });

  test('should convert number to string', () => {
    expect(toSmartString(123)).toBe('123');
  });

  test('should convert boolean to string', () => {
    expect(toSmartString(true)).toBe('true');
  });

  test('should convert an array to string', () => {
    expect(toSmartString([1, 2, 3])).toBe('[1,2,3]');
  });

  test('should convert object to string', () => {
    expect(toSmartString({ foo: 'bar' })).toBe(JSON.stringify({ foo: 'bar' }));
  });
});
