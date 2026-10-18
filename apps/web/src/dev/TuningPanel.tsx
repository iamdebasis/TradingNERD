import {
  type ChartController,
  DEFAULT_GESTURE_TUNING,
  type GestureTuning,
  type PriceAnchor,
  sanitizeTuning,
  TUNING_LIMITS,
  type TuningNumber,
} from '@tradingnerd/chart';
import { type CSSProperties, useEffect, useId, useState } from 'react';
import styles from './TuningPanel.module.css';

const STORAGE_KEY = 'tn.dev.gestureTuning';

const percent = (value: number) => `${Math.round(value * 100)}%`;

const SLIDERS: readonly {
  key: TuningNumber;
  label: string;
  hint: string;
  format(value: number): string;
}[] = [
  {
    key: 'zoomStep',
    label: 'Chart zoom',
    hint: 'Two-finger vertical swipe or mouse wheel over the chart: zoom per wheel notch',
    format: percent,
  },
  {
    key: 'pinchStep',
    label: 'Pinch zoom',
    hint: 'Trackpad pinch or Ctrl + wheel: zoom per wheel notch',
    format: percent,
  },
  {
    key: 'panFactor',
    label: 'Sideways pan',
    hint: 'Two-finger sideways swipe or Shift + wheel: pixels moved per pixel swiped',
    format: (value) => `${value.toFixed(2)}×`,
  },
  {
    key: 'priceStep',
    label: 'Price-axis swipe',
    hint: 'Two-finger vertical swipe or mouse wheel over the price axis: stretch per wheel notch',
    format: percent,
  },
];

const ANCHORS: readonly { value: PriceAnchor; label: string; hint: string }[] = [
  { value: 'center', label: 'Middle', hint: 'The middle of the visible prices stays put' },
  { value: 'pointer', label: 'Pointer', hint: 'The price under the pointer stays put' },
  { value: 'lastPrice', label: 'Last price', hint: 'The latest price stays put' },
];

function loadTuning(): GestureTuning {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return sanitizeTuning(raw === null ? null : JSON.parse(raw));
  } catch {
    return { ...DEFAULT_GESTURE_TUNING };
  }
}

function saveTuning(tuning: GestureTuning | null): void {
  try {
    if (tuning) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(tuning));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable: the values just won't survive a reload.
  }
}

/**
 * TEMPORARY and development-only, opened with `?tune` in the URL: sliders for the gesture
 * constants TradingView doesn't publish, to match its feel side by side (docs/SPEC.md §11).
 * Once calibrated, the values become the defaults in packages/chart/src/tuning.ts and this
 * panel is deleted.
 */
export function TuningPanel({ chart }: { chart: ChartController }) {
  const id = useId();
  const [tuning, setTuning] = useState(loadTuning);
  const [open, setOpen] = useState(true);
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    chart.setGestureTuning(tuning);
  }, [chart, tuning]);

  const update = (patch: Partial<GestureTuning>) => {
    const next = sanitizeTuning(patch, tuning);
    saveTuning(next);
    setTuning(next);
    setCopy('idle');
  };

  const reset = () => {
    saveTuning(null);
    setTuning({ ...DEFAULT_GESTURE_TUNING });
    setCopy('idle');
  };

  const copyValues = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(tuning, null, 2));
      setCopy('copied');
    } catch {
      setCopy('failed');
    }
  };

  return (
    <section className={styles.panel} aria-label="Gesture tuning">
      <header className={styles.header}>
        <span className={styles.title}>Gesture tuning</span>
        <span className={styles.badge}>dev</span>
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={open}
          aria-controls={`${id}-body`}
          onClick={() => setOpen(!open)}
        >
          {open ? 'Hide' : 'Show'}
        </button>
      </header>
      {open && (
        <div id={`${id}-body`} className={styles.body}>
          {SLIDERS.map(({ key, label, hint, format }) => {
            const { min, max, step } = TUNING_LIMITS[key];
            const inputId = `${id}-${key}`;
            const fill = (tuning[key] - min) / (max - min);
            return (
              <div key={key} className={styles.row} title={hint}>
                <label htmlFor={inputId} className={styles.label}>
                  {label}
                </label>
                <output htmlFor={inputId} className={styles.value}>
                  {format(tuning[key])}
                </output>
                <input
                  id={inputId}
                  type="range"
                  className={styles.slider}
                  style={{ '--fill': `${fill * 100}%` } as CSSProperties}
                  min={min}
                  max={max}
                  step={step}
                  value={tuning[key]}
                  aria-valuetext={format(tuning[key])}
                  onChange={(event) => update({ [key]: Number(event.target.value) })}
                />
              </div>
            );
          })}
          <fieldset className={styles.choice}>
            <legend className={styles.label}>Price-axis fixed point</legend>
            <div className={styles.segments}>
              {ANCHORS.map(({ value, label, hint }) => (
                <label key={value} className={styles.segment} title={hint}>
                  <input
                    type="radio"
                    name={`${id}-anchor`}
                    value={value}
                    checked={tuning.priceAnchor === value}
                    onChange={() => update({ priceAnchor: value })}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={tuning.priceReversed}
              onChange={(event) => update({ priceReversed: event.target.checked })}
            />
            Reverse price-axis direction
          </label>
          <div className={styles.actions}>
            <button type="button" onClick={reset}>
              Reset to defaults
            </button>
            <button type="button" onClick={() => void copyValues()}>
              {copy === 'copied' ? 'Copied' : copy === 'failed' ? 'Copy failed' : 'Copy values'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
