import { describe, expect, it } from 'vitest';
import { reconnectDelay } from './reconnect';

describe('reconnectDelay', () => {
  it('doubles from half a second', () => {
    expect([0, 1, 2, 3, 4].map(reconnectDelay)).toEqual([500, 1000, 2000, 4000, 8000]);
  });

  it('caps at ten seconds', () => {
    expect(reconnectDelay(5)).toBe(10_000);
    expect(reconnectDelay(50)).toBe(10_000);
  });

  it('treats a negative attempt as the first one', () => {
    expect(reconnectDelay(-3)).toBe(500);
  });
});
