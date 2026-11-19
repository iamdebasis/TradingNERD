import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHIME_RATE, chimeSamples, wavOf } from './alertSound';

/**
 * The alert's chime (the dialog's "Play sound"; docs/SPEC.md §3, 18 November, and §11, item
 * 133): the two notes Web Audio played, as a WAV made once in the page and played from an audio
 * element, with no AudioContext. Making one held the page while it waited on the audio output.
 */

const at = (seconds: number) => Math.round(seconds * CHIME_RATE);

/** The loudest sample between two times, in seconds. */
function loudest(samples: Float32Array, from: number, to: number): number {
  let most = 0;
  for (let i = at(from); i < at(to); i++) most = Math.max(most, Math.abs(samples[i] ?? 0));
  return most;
}

/** The pitch between two times, from how often the samples cross zero. */
function pitch(samples: Float32Array, from: number, to: number): number {
  let crossings = 0;
  for (let i = at(from) + 1; i < at(to); i++) {
    if ((samples[i - 1] ?? 0) < 0 !== (samples[i] ?? 0) < 0) crossings++;
  }
  return crossings / 2 / (to - from);
}

describe('the chime', () => {
  const samples = chimeSamples();

  it('lasts 0.55 s at 44.1 kHz', () => {
    expect(samples.length).toBe(24_255);
  });

  it('plays 880 Hz, then 1318.5 Hz from 0.2 s', () => {
    expect(pitch(samples, 0.02, 0.15)).toBeCloseTo(880, -1);
    expect(pitch(samples, 0.22, 0.45)).toBeCloseTo(1318.5, -1);
  });

  it('rises to 0.18 in 20 ms on each note, falls away, and is near silent between and after', () => {
    expect(loudest(samples, 0, 0.01)).toBeLessThan(0.005);
    expect(loudest(samples, 0.015, 0.025)).toBeCloseTo(0.18, 2);
    expect(loudest(samples, 0.181, 0.199)).toBeLessThan(0.0002);
    expect(loudest(samples, 0.2, 0.21)).toBeLessThan(0.005);
    expect(loudest(samples, 0.215, 0.225)).toBeCloseTo(0.18, 2);
    expect(loudest(samples, 0.5, 0.55)).toBeLessThan(0.0002);
    expect(loudest(samples, 0, 0.55)).toBeLessThanOrEqual(0.18);
  });

  it('is a 16-bit PCM WAV with one channel at 44.1 kHz, holding every sample', () => {
    const wav = new DataView(wavOf(samples, CHIME_RATE));
    const text = (offset: number) =>
      String.fromCharCode(...[0, 1, 2, 3].map((i) => wav.getUint8(offset + i)));
    expect([text(0), text(8), text(12), text(36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
    expect(wav.byteLength).toBe(44 + samples.length * 2);
    expect(wav.getUint32(4, true)).toBe(wav.byteLength - 8);
    expect(wav.getUint32(40, true)).toBe(samples.length * 2);
    // The format's length, PCM, one channel, the rate, bytes a second and a sample, bits a sample.
    expect([
      wav.getUint32(16, true),
      wav.getUint16(20, true),
      wav.getUint16(22, true),
      wav.getUint32(24, true),
      wav.getUint32(28, true),
      wav.getUint16(32, true),
      wav.getUint16(34, true),
    ]).toEqual([16, 1, 1, 44_100, 88_200, 2, 16]);
    let most = 0;
    for (let i = 0; i < samples.length; i++) {
      const sample = wav.getInt16(44 + i * 2, true);
      // As 16 bits, a rounded -0 is 0.
      expect(sample).toBe(Math.round((samples[i] ?? 0) * 32767) + 0);
      most = Math.max(most, Math.abs(sample));
    }
    expect(most).toBe(Math.round(loudest(samples, 0, 0.55) * 32767));
  });
});

describe('playAlertSound', () => {
  /** Audio elements as a browser makes them, each with what it was asked to play. */
  function audioElements(play: () => Promise<void> = () => Promise.resolve()) {
    const made: { src: string; plays: number }[] = [];
    class FakeAudio {
      private readonly element: { src: string; plays: number };
      constructor(src: string) {
        this.element = { src, plays: 0 };
        made.push(this.element);
      }
      play(): Promise<void> {
        this.element.plays++;
        return play();
      }
    }
    vi.stubGlobal('Audio', FakeAudio);
    return made;
  }

  beforeEach(() => {
    // A fresh copy of the module each time: it keeps the chime's WAV once made.
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('plays the chime from an audio element each time, its WAV made once, and makes no AudioContext', async () => {
    const made = audioElements();
    // A browser's AudioContext, counted: an alert's chime made one before.
    const contexts = vi.fn();
    class CountedContext {
      constructor() {
        contexts();
      }
    }
    vi.stubGlobal('AudioContext', CountedContext);
    vi.stubGlobal('window', { AudioContext: CountedContext });
    const urls = vi.spyOn(URL, 'createObjectURL');
    const { playAlertSound } = await import('./alertSound');
    playAlertSound();
    playAlertSound();
    expect(contexts).not.toHaveBeenCalled();
    expect(urls).toHaveBeenCalledTimes(1);
    const url = urls.mock.results[0]?.value as string;
    expect(made).toEqual([
      { src: url, plays: 1 },
      { src: url, plays: 1 },
    ]);
    // What it plays is the chime's WAV.
    const wav = urls.mock.calls[0]?.[0] as Blob;
    expect(wav.type).toBe('audio/wav');
    expect(new Uint8Array(await wav.arrayBuffer())).toEqual(
      new Uint8Array(wavOf(chimeSamples(), CHIME_RATE)),
    );
  });

  it('stays silent when the browser refuses to play: the refusal is caught', async () => {
    const made = audioElements(() =>
      Promise.reject(new DOMException('No user gesture yet', 'NotAllowedError')),
    );
    const { playAlertSound } = await import('./alertSound');
    expect(() => playAlertSound()).not.toThrow();
    expect(made).toHaveLength(1);
    // Time for a refusal nothing caught to be reported: Vitest fails the run on one.
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it('does nothing where the browser has no audio elements', async () => {
    const urls = vi.spyOn(URL, 'createObjectURL');
    const { playAlertSound } = await import('./alertSound');
    expect(() => playAlertSound()).not.toThrow();
    expect(urls).not.toHaveBeenCalled();
  });
});
