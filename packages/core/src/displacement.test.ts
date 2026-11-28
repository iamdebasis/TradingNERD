import { describe, expect, it } from 'vitest';
import { displace, parseDisplacement } from './displacement.ts';

describe('Displacement (price, bar), as TradingView’s hint says', () => {
  it('reads +, -, * and / for a price, and a bare number that sets it', () => {
    expect(parseDisplacement('+5', 'price')).toEqual({ op: '+', value: 5 });
    expect(parseDisplacement(' - 2.5 ', 'price')).toEqual({ op: '-', value: 2.5 });
    expect(parseDisplacement('*1.5', 'price')).toEqual({ op: '*', value: 1.5 });
    expect(parseDisplacement('/2', 'price')).toEqual({ op: '/', value: 2 });
    expect(parseDisplacement('.5', 'price')).toEqual({ op: '=', value: 0.5 });
    expect(parseDisplacement('100', 'price')).toEqual({ op: '=', value: 100 });
  });

  it('takes only + and − and whole bars for the bar index', () => {
    expect(parseDisplacement('+1', 'bar')).toEqual({ op: '+', value: 1 });
    expect(parseDisplacement('-10', 'bar')).toEqual({ op: '-', value: 10 });
    expect(parseDisplacement('42', 'bar')).toEqual({ op: '=', value: 42 });
    expect(parseDisplacement('*2', 'bar')).toBeNull();
    expect(parseDisplacement('/2', 'bar')).toBeNull();
    expect(parseDisplacement('+1.5', 'bar')).toBeNull();
  });

  it('refuses what isn’t an expression, and dividing by 0', () => {
    for (const text of ['', 'abc', '+', '5+', '++1', '1e3', '/0', '+-1']) {
      expect(parseDisplacement(text, 'price')).toBeNull();
    }
  });

  it('applies each to a coordinate', () => {
    expect(displace(10, { op: '+', value: 5 })).toBe(15);
    expect(displace(10, { op: '-', value: 5 })).toBe(5);
    expect(displace(10, { op: '*', value: 2 })).toBe(20);
    expect(displace(10, { op: '/', value: 4 })).toBe(2.5);
    expect(displace(10, { op: '=', value: 3 })).toBe(3);
    // A negative coordinate multiplied moves the other way, as the blog says.
    expect(displace(-10, { op: '*', value: 2 })).toBe(-20);
  });
});
