/**
 * The sound an alert plays when it triggers (the dialog's "Play sound"): a short two-note chime,
 * ours (provisional: TradingView's sounds aren't ours to copy, docs/SPEC.md §11, item 133). A
 * browser that hasn't been clicked yet may keep it silent (Chrome's autoplay policy, the same for
 * audio elements and Web Audio).
 *
 * It plays from an audio element, its sound made once in the page. It used to play through an
 * AudioContext made for each alert, and making a browser's first AudioContext waits on the
 * computer's audio output, the page with it: 41 to 76 ms in the cloud's Chromium, where a play
 * takes up to 2 ms (measured 2026-11-18, docs/SPEC.md §3). On the Mac, alerts.spec.ts saw a task
 * of 277 ms when its alert triggered.
 */

/** The chime's samples a second. */
export const CHIME_RATE = 44_100;

/**
 * Its notes: [pitch in Hz, start, length], in seconds. Each rises from FLOOR to PEAK in RISE,
 * falls back to FLOOR by the end of its length and holds there for TAIL more, as Web Audio played
 * them: an oscillator through a gain, with exponential ramps (the Web Audio spec's formula).
 */
const NOTES: readonly (readonly [number, number, number])[] = [
  [880, 0, 0.18],
  [1318.5, 0.2, 0.3],
];
const PEAK = 0.18;
const FLOOR = 0.0001;
const RISE = 0.02;
const TAIL = 0.05;

/** A note's sample at `time` seconds into the chime; 0 before it starts and after it stops. */
function noteAt([pitch, start, length]: readonly [number, number, number], time: number): number {
  const t = time - start;
  if (t < 0 || t >= length + TAIL) return 0;
  const gain =
    t < RISE
      ? FLOOR * (PEAK / FLOOR) ** (t / RISE)
      : t < length
        ? PEAK * (FLOOR / PEAK) ** ((t - RISE) / (length - RISE))
        : FLOOR;
  return gain * Math.sin(2 * Math.PI * pitch * t);
}

/** The chime's samples, between -1 and 1: 0.55 s, its notes summed. */
export function chimeSamples(rate: number = CHIME_RATE): Float32Array {
  const end = Math.max(...NOTES.map(([, start, length]) => start + length + TAIL));
  const samples = new Float32Array(Math.round(end * rate));
  for (let i = 0; i < samples.length; i++) {
    let sum = 0;
    for (const note of NOTES) sum += noteAt(note, i / rate);
    samples[i] = sum;
  }
  return samples;
}

/** Samples as a WAV file: 16-bit PCM, one channel. */
export function wavOf(samples: Float32Array, rate: number): ArrayBuffer {
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true); // the format's own length
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // one channel
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // bytes a second
  view.setUint16(32, 2, true); // bytes a sample
  view.setUint16(34, 16, true); // bits a sample
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => {
    view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, sample)) * 32767), true);
  });
  return bytes;
}

/** The chime's WAV in the page's memory, made at its first play. */
let chime: string | null = null;

export function playAlertSound(): void {
  try {
    if (typeof Audio === 'undefined') return;
    chime ??= URL.createObjectURL(
      new Blob([wavOf(chimeSamples(), CHIME_RATE)], { type: 'audio/wav' }),
    );
    // An element for each: two alerts at once chime twice. A browser keeping the page silent
    // refuses the play.
    new Audio(chime).play().catch(() => {});
  } catch {
    // No sound where audio isn't available.
  }
}
