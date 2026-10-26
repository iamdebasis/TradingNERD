import { describe, expect, it } from 'vitest';
import { parseOlderCapsStatus } from './olderCaps.ts';

const STATUS = {
  key: { masked: '••••9c1e', source: 'file' },
  state: 'loading',
  progress: 0.4,
  from: '2019-03-02',
  until: '2025-10-28',
  message: null,
};

describe('older market caps status', () => {
  it('reads what the gateway says of the download and the key', () => {
    expect(parseOlderCapsStatus(STATUS)).toEqual(STATUS);
    expect(
      parseOlderCapsStatus({
        ...STATUS,
        key: null,
        state: 'none',
        progress: 0,
        from: null,
        until: null,
      }),
    ).toMatchObject({ key: null, state: 'none' });
  });

  it.each([
    ['an unknown state', { ...STATUS, state: 'paused' }],
    ['progress past 1', { ...STATUS, progress: 1.5 }],
    ['a day that is no date', { ...STATUS, from: 'May 2013' }],
    ['a key without its source', { ...STATUS, key: { masked: '••••9c1e' } }],
    ['nothing', null],
  ])('refuses %s', (_label, value) => {
    expect(parseOlderCapsStatus(value)).toBeNull();
  });
});
