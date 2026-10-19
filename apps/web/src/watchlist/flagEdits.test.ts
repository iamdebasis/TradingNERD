import type { FlagState } from '@tradingnerd/core';
import { describe, expect, it } from 'vitest';
import { flagOf, pickFlag, toggleFlag, unflagAll } from './flagEdits';

const STATE: FlagState = { flags: { 'X:A': 'blue' }, lastColor: 'green' };

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
