import { describe, expect, it } from 'vitest';
import { isAllowedOrigin, isLoopbackHost } from '../src/security.ts';

describe('isLoopbackHost', () => {
  it.each([
    '127.0.0.1',
    '127.0.0.1:5180',
    'localhost',
    'localhost:5173',
    'LOCALHOST:5173',
    '[::1]',
    '[::1]:5180',
  ])('accepts %s', (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each([
    ['a missing header', undefined],
    ['an empty header', ''],
    ['a public domain', 'evil.example:5180'],
    ['a look-alike domain', '127.0.0.1.evil.example'],
    ['a LAN address', '192.168.1.20:5180'],
    ['a malformed IPv6 literal', '[::1'],
  ])('rejects %s', (_label, host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe('isAllowedOrigin', () => {
  const allowed = ['http://127.0.0.1:5173', 'http://localhost:5173'];

  it('allows requests without an Origin header', () => {
    expect(isAllowedOrigin(undefined, allowed)).toBe(true);
  });

  it('allows the UI origins', () => {
    expect(isAllowedOrigin('http://127.0.0.1:5173', allowed)).toBe(true);
    expect(isAllowedOrigin('http://localhost:5173', allowed)).toBe(true);
  });

  it.each(['https://evil.example', 'http://localhost:5174', 'null', ''])('rejects %s', (origin) => {
    expect(isAllowedOrigin(origin, allowed)).toBe(false);
  });
});
