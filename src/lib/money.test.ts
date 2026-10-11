import { describe, expect, it } from 'vitest';
import { parsePeso } from './money';
describe('parsePeso (patch 180 edge cases)', () => {
  it('cases', () => {
    expect(parsePeso('1,234.56')).toBe(123456);
    expect(parsePeso('₱1,234.56')).toBe(123456);
    expect(parsePeso('P 1,234.56')).toBe(123456);
    expect(parsePeso('PHP 5')).toBe(500);
    expect(parsePeso('(1,234.56)')).toBe(-123456);
    expect(parsePeso('-5')).toBe(-500);
    expect(parsePeso('(-5)')).toBe(null);
    expect(parsePeso('1p2')).toBe(null);
    expect(parsePeso('.')).toBe(null);
    expect(parsePeso('.5')).toBe(50);
    expect(parsePeso('5.')).toBe(500);
    expect(parsePeso(1.005)).toBe(101);
    expect(parsePeso(-0.125)).toBe(-13);
    expect(parsePeso(1234.5)).toBe(123450);
    expect(parsePeso(0)).toBe(0);
    expect(parsePeso('-₱5.00')).toBe(-500);
  });
});
