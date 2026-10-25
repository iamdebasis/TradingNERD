import type { FlagState } from '@tradingnerd/core';
import { describe, expect, it } from 'vitest';
import {
  copyFlag,
  flagOf,
  pickFlag,
  pickFlags,
  sharedFlag,
  toggleFlag,
  toggleFlags,
  unflagAll,
} from './flagEdits';

const STATE: FlagState = { flags: { 'X:A': 'blue' }, lastColor: 'green' };

describe("a formula's fix taking its row", () => {
  it('carries the flag over, keeping a flag the fix has and the old one', () => {
    expect(copyFlag(STATE, 'X:A', 'X:B')).toEqual({
      flags: { 'X:A': 'blue', 'X:B': 'blue' },
      lastColor: 'green',
    });
    const both: FlagState = { flags: { 'X:A': 'blue', 'X:B': 'red' }, lastColor: 'green' };
    expect(copyFlag(both, 'X:A', 'X:B')).toBe(both);
    expect(copyFlag(STATE, 'X:C', 'X:B')).toBe(STATE);
  });
});

describe('flag edits on several selected symbols', () => {
  it('toggle: the unflagged ones in the last color, the flagged keeping theirs; all off once all are', () => {
    const some = toggleFlags(STATE, ['X:A', 'X:B', 'X:C']);
    expect(some).toEqual({
      flags: { 'X:A': 'blue', 'X:B': 'green', 'X:C': 'green' },
      lastColor: 'green',
    });
    expect(toggleFlags(some, ['X:A', 'X:B'])).toEqual({
      flags: { 'X:C': 'green' },
      lastColor: 'green',
    });
    expect(toggleFlags(STATE, ['X:B'])).toEqual(toggleFlag(STATE, 'X:B'));
    expect(toggleFlags(STATE, [])).toBe(STATE);
  });

  it('pick: all in the color, which becomes the next; all off when all have it', () => {
    const pink = pickFlags(STATE, ['X:A', 'X:B'], 'pink');
    expect(pink).toEqual({ flags: { 'X:A': 'pink', 'X:B': 'pink' }, lastColor: 'pink' });
    expect(pickFlags(pink, ['X:A', 'X:B'], 'pink')).toEqual({ flags: {}, lastColor: 'pink' });
    expect(pickFlags(STATE, [], 'red')).toBe(STATE);
  });

  it('the color they share, if they share one', () => {
    const state: FlagState = {
      flags: { 'X:A': 'red', 'X:B': 'red', 'X:C': 'blue' },
      lastColor: 'red',
    };
    expect(sharedFlag(state, ['X:A', 'X:B'])).toBe('red');
    expect(sharedFlag(state, ['X:A', 'X:C'])).toBeNull();
    expect(sharedFlag(state, ['X:A', 'X:D'])).toBeNull();
    expect(sharedFlag(null, ['X:A'])).toBeNull();
    expect(sharedFlag(state, [])).toBeNull();
  });
});

describe('flag edits', () => {
  it('toggle: a flagged symbol is unflagged, another is flagged in the last color picked', () => {
    expect(toggleFlag(STATE, 'X:A')).toEqual({ flags: {}, lastColor: 'green' });
    expect(toggleFlag(STATE, 'X:B').flags).toEqual({ 'X:A': 'blue', 'X:B': 'green' });
  });

  it('pick: flags or recolors, and the color is the next one; its own color unflags', () => {
    expect(pickFlag(STATE, 'X:B', 'pink')).toEqual({
      flags: { 'X:A': 'blue', 'X:B': 'pink' },
      lastColor: 'pink',
    });
    expect(pickFlag(STATE, 'X:A', 'red')).toEqual({ flags: { 'X:A': 'red' }, lastColor: 'red' });
    expect(pickFlag(STATE, 'X:A', 'blue')).toEqual({ flags: {}, lastColor: 'green' });
  });

  it('unflag all keeps the last color, and changes nothing when nothing is flagged', () => {
    const none = unflagAll(STATE);
    expect(none).toEqual({ flags: {}, lastColor: 'green' });
    expect(unflagAll(none)).toBe(none);
    expect(flagOf(STATE, 'X:A')).toBe('blue');
    expect(flagOf(null, 'X:A')).toBeNull();
  });
});
