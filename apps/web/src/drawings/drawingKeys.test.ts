import { describe, expect, it } from 'vitest';
import { drawingKeyAction } from './drawingKeys';

const key = (
  code: string,
  key: string,
  mods: { alt?: boolean; ctrl?: boolean; meta?: boolean; shift?: boolean } = {},
) =>
  drawingKeyAction({
    code,
    key,
    altKey: mods.alt ?? false,
    ctrlKey: mods.ctrl ?? false,
    metaKey: mods.meta ?? false,
    shiftKey: mods.shift ?? false,
  });

describe('the drawing tools’ keys', () => {
  it('choose the Lines tools with ⌥ and their letters, by the key’s place', () => {
    // On a Mac ⌥T types "†", ⌥H "˙"…: the place is what counts.
    expect(key('KeyT', '†', { alt: true })).toEqual({ kind: 'tool', tool: 'trend-line' });
    expect(key('KeyH', '˙', { alt: true })).toEqual({ kind: 'tool', tool: 'horizontal-line' });
    expect(key('KeyJ', '∆', { alt: true })).toEqual({ kind: 'tool', tool: 'horizontal-ray' });
    expect(key('KeyV', '√', { alt: true })).toEqual({ kind: 'tool', tool: 'vertical-line' });
    expect(key('KeyC', 'ç', { alt: true })).toEqual({ kind: 'tool', tool: 'cross-line' });
    // ⌥A is Create alert's, ⌥R the chart's reset.
    expect(key('KeyA', 'å', { alt: true })).toBeNull();
    expect(key('KeyR', '®', { alt: true })).toBeNull();
  });

  it('undo with Ctrl/⌘ + Z and redo with Ctrl+Y or Ctrl/⌘ + Shift + Z', () => {
    expect(key('KeyZ', 'z', { meta: true })).toEqual({ kind: 'undo' });
    expect(key('KeyZ', 'z', { ctrl: true })).toEqual({ kind: 'undo' });
    expect(key('KeyZ', 'Z', { meta: true, shift: true })).toEqual({ kind: 'redo' });
    expect(key('KeyY', 'y', { ctrl: true })).toEqual({ kind: 'redo' });
    // ⌘Y is the browser's history on a Mac.
    expect(key('KeyY', 'y', { meta: true })).toBeNull();
  });

  it('read undo by the letter typed, on any layout', () => {
    // AZERTY: the letter z sits where QWERTY has w.
    expect(key('KeyW', 'z', { ctrl: true })).toEqual({ kind: 'undo' });
    expect(key('KeyZ', 'w', { ctrl: true })).toBeNull();
    // A layout without Latin letters: the key's place.
    expect(key('KeyZ', 'я', { ctrl: true })).toEqual({ kind: 'undo' });
  });

  it('hide every drawing with Ctrl+Alt+H or ⌘⌥H', () => {
    expect(key('KeyH', '˙', { meta: true, alt: true })).toEqual({ kind: 'hide-all' });
    expect(key('KeyH', 'h', { ctrl: true, alt: true })).toEqual({ kind: 'hide-all' });
  });

  it('copy and paste drawings with Ctrl/⌘ + C and V, nothing else held (D3a)', () => {
    expect(key('KeyC', 'c', { meta: true })).toEqual({ kind: 'copy' });
    expect(key('KeyC', 'c', { ctrl: true })).toEqual({ kind: 'copy' });
    expect(key('KeyV', 'v', { meta: true })).toEqual({ kind: 'paste' });
    expect(key('KeyV', 'м', { ctrl: true })).toEqual({ kind: 'paste' });
    expect(key('KeyC', 'C', { meta: true, shift: true })).toBeNull();
    expect(key('KeyC', 'ç', { meta: true, alt: true })).toBeNull();
    // Bare, C is the Crossline's ⌥ letter's place and nothing else.
    expect(key('KeyC', 'c')).toBeNull();
  });

  it('let go with Escape and remove with Delete or Backspace, bare only', () => {
    expect(key('Escape', 'Escape')).toEqual({ kind: 'cancel' });
    expect(key('Delete', 'Delete')).toEqual({ kind: 'delete' });
    expect(key('Backspace', 'Backspace')).toEqual({ kind: 'delete' });
    expect(key('Backspace', 'Backspace', { meta: true })).toBeNull();
    expect(key('KeyT', 't')).toBeNull();
  });
});
