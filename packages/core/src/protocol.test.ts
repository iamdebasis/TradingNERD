import { describe, expect, it } from 'vitest';
import { parseClientMessage, parseServerMessage } from './protocol.ts';

describe('parseServerMessage', () => {
  it('accepts a well-formed hello', () => {
    expect(parseServerMessage('{"type":"hello","protocolVersion":1,"serverTime":123}')).toEqual({
      type: 'hello',
      protocolVersion: 1,
      serverTime: 123,
    });
  });

  it('accepts a well-formed pong', () => {
    expect(parseServerMessage('{"type":"pong","t":42}')).toEqual({ type: 'pong', t: 42 });
  });

  it('drops extra fields instead of passing them through', () => {
    expect(parseServerMessage('{"type":"pong","t":1,"extra":"x"}')).toEqual({ type: 'pong', t: 1 });
  });

  it.each([
    ['invalid JSON', '{nope'],
    ['a JSON array', '[1,2]'],
    ['a JSON primitive', '42'],
    ['null', 'null'],
    ['an unknown type', '{"type":"bars"}'],
    ['a hello with a string version', '{"type":"hello","protocolVersion":"1","serverTime":1}'],
    ['a hello without serverTime', '{"type":"hello","protocolVersion":1}'],
    ['a pong without t', '{"type":"pong"}'],
  ])('rejects %s', (_label, raw) => {
    expect(parseServerMessage(raw)).toBeNull();
  });
});

describe('parseClientMessage', () => {
  it('accepts a well-formed ping', () => {
    expect(parseClientMessage('{"type":"ping","t":7}')).toEqual({ type: 'ping', t: 7 });
  });

  it.each([
    ['invalid JSON', 'ping'],
    ['a ping without t', '{"type":"ping"}'],
    ['a server-only type', '{"type":"hello","protocolVersion":1,"serverTime":1}'],
  ])('rejects %s', (_label, raw) => {
    expect(parseClientMessage(raw)).toBeNull();
  });
});
