import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCoalescer } from '../src/market/coalesce.ts';

describe('createCoalescer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits the first value immediately', () => {
    const emit = vi.fn();
    createCoalescer(50, emit).push(1);
    expect(emit).toHaveBeenCalledWith(1);
  });

  it('holds a burst and emits only the latest value at the end of the window', () => {
    const emit = vi.fn();
    const c = createCoalescer(50, emit);
    c.push(1);
    c.push(2);
    c.push(3);
    expect(emit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(49);
    expect(emit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(emit).toHaveBeenLastCalledWith(3);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('emits again immediately once a quiet window has passed', () => {
    const emit = vi.fn();
    const c = createCoalescer(50, emit);
    c.push(1);
    vi.advanceTimersByTime(80);
    c.push(2);
    expect(emit).toHaveBeenLastCalledWith(2);
  });

  it('flush emits a held value right away', () => {
    const emit = vi.fn();
    const c = createCoalescer(50, emit);
    c.push(1);
    c.push(2);
    c.flush();
    expect(emit).toHaveBeenLastCalledWith(2);
    vi.advanceTimersByTime(100);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('cancel drops a held value', () => {
    const emit = vi.fn();
    const c = createCoalescer(50, emit);
    c.push(1);
    c.push(2);
    c.cancel();
    vi.advanceTimersByTime(100);
    expect(emit).toHaveBeenCalledTimes(1);
  });
});
