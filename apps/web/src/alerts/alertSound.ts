/**
 * The sound an alert plays when it triggers (the dialog's "Play sound"): a short two-note chime,
 * ours (provisional: TradingView's sounds aren't ours to copy, docs/SPEC.md §11). A browser that
 * hasn't been clicked yet may keep it silent.
 */
export function playAlertSound(): void {
  try {
    const Context =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) return;
    const audio = new Context();
    const note = (frequency: number, start: number, length: number) => {
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      const at = audio.currentTime + start;
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.18, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
      oscillator.connect(gain).connect(audio.destination);
      oscillator.start(at);
      oscillator.stop(at + length + 0.05);
    };
    note(880, 0, 0.18);
    note(1318.5, 0.2, 0.3);
    window.setTimeout(() => void audio.close().catch(() => {}), 1_000);
  } catch {
    // No sound where audio isn't available.
  }
}
