import {
  DEFAULT_GESTURE_TUNING,
  type PriceAnchor,
  TUNING_LIMITS,
  type TuningNumber,
} from '@tradingnerd/chart';
import {
  type CSSProperties,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { CloseIcon } from '../toolbar/icons';
import styles from './GesturesPopup.module.css';
import { gestureSettings, isChanged, useGestureSettings } from './gestureSettings';

const percent = (value: number) => `${Math.round(value * 100)}%`;

const SLIDERS: readonly {
  key: TuningNumber;
  label: string;
  hint: string;
  format(value: number): string;
}[] = [
  {
    key: 'zoomStep',
    label: 'Zoom',
    hint: 'Two-finger swipe up or down, or the wheel',
    format: percent,
  },
  { key: 'pinchStep', label: 'Pinch zoom', hint: 'Pinch, or Ctrl + wheel', format: percent },
  {
    key: 'panFactor',
    label: 'Scroll',
    hint: 'Two-finger swipe sideways, or Shift + wheel',
    format: (value) => `${value.toFixed(2)}×`,
  },
  {
    key: 'priceStep',
    label: 'Price scale',
    hint: 'Swipe or wheel over the price axis',
    format: percent,
  },
];

const ANCHORS: readonly { value: PriceAnchor; label: string; hint: string }[] = [
  { value: 'center', label: 'Middle', hint: 'The middle of the visible prices stays put' },
  { value: 'pointer', label: 'Pointer', hint: 'The price under the pointer stays put' },
  { value: 'lastPrice', label: 'Last price', hint: 'The latest price stays put' },
];

/** How long a setting stays lit after a gesture used it. */
const LIT_MS = 900;
/** Gap kept from the window's edges. */
const EDGE = 4;

export interface GesturesPopupProps {
  /** The top bar's Gestures button, which the popup hangs from. */
  anchor: RefObject<HTMLElement | null>;
  onClose(): void;
}

/**
 * The top bar's gesture settings: how fast zoom, pinch, scroll and the price scale move, and
 * which price holds still. It leaves the chart free, so a change can be tried on it at once,
 * and the setting each gesture uses lights up as it's made. Escape, ✕ or the button close it.
 */
export function GesturesPopup({ anchor, onClose }: GesturesPopupProps) {
  const id = useId();
  const tuning = useGestureSettings();
  const popup = useRef<HTMLElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const [lit, setLit] = useState<TuningNumber | null>(null);
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');

  // Under its button, inside the window.
  useLayoutEffect(() => {
    const placeUnder = () => {
      const button = anchor.current?.getBoundingClientRect();
      if (!button) return;
      const width = popup.current?.offsetWidth ?? 0;
      const left = Math.max(EDGE, Math.min(button.left, window.innerWidth - width - EDGE));
      setPlace({ left, top: button.bottom + 2 });
    };
    placeUnder();
    window.addEventListener('resize', placeUnder);
    return () => window.removeEventListener('resize', placeUnder);
  }, [anchor]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = gestureSettings.onGesture((setting) => {
      setLit(setting);
      clearTimeout(timer);
      timer = setTimeout(() => setLit(null), LIT_MS);
    });
    return () => {
      stop();
      clearTimeout(timer);
    };
  }, []);

  // Escape closes it, unless a dialog or menu has used the key. Presses elsewhere don't: the
  // chart stays in use while it's open.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      onClose();
      anchor.current?.focus();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [anchor, onClose]);

  const update = (patch: Parameters<typeof gestureSettings.set>[0]) => {
    gestureSettings.set(patch);
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

  return createPortal(
    <section
      ref={popup}
      className={styles.popup}
      aria-label="Gestures"
      style={place ?? { visibility: 'hidden' }}
    >
      <header className={styles.header}>
        <h2 className={styles.title}>Gestures</h2>
        <button type="button" className={styles.close} aria-label="Close" onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      <p className={styles.intro}>Changes apply at once: try them on the chart.</p>
      {SLIDERS.map(({ key, label, hint, format }) => {
        const { min, max, step } = TUNING_LIMITS[key];
        const value = tuning[key];
        const at = (fraction: number) => ({ '--at': fraction }) as CSSProperties;
        return (
          <div
            key={key}
            className={styles.setting}
            data-setting={key}
            data-lit={lit === key || undefined}
          >
            <div className={styles.labels}>
              <label htmlFor={`${id}-${key}`}>{label}</label>
              <output htmlFor={`${id}-${key}`} className={styles.value}>
                {format(value)}
              </output>
            </div>
            <p id={`${id}-${key}-hint`} className={styles.hint}>
              {hint}
            </p>
            <div className={styles.track}>
              <input
                id={`${id}-${key}`}
                type="range"
                className={styles.slider}
                style={at((value - min) / (max - min))}
                min={min}
                max={max}
                step={step}
                value={value}
                aria-valuetext={format(value)}
                aria-describedby={`${id}-${key}-hint`}
                onChange={(event) => update({ [key]: Number(event.target.value) })}
              />
              <span
                className={styles.mark}
                style={at((DEFAULT_GESTURE_TUNING[key] - min) / (max - min))}
                title={`Default: ${format(DEFAULT_GESTURE_TUNING[key])}`}
                aria-hidden
              />
            </div>
          </div>
        );
      })}
      <fieldset className={styles.anchor}>
        <legend>Price scale holds</legend>
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
        Reverse price-scale direction
      </label>
      <footer className={styles.actions}>
        <button
          type="button"
          disabled={!isChanged(tuning)}
          onClick={() => {
            gestureSettings.reset();
            setCopy('idle');
          }}
        >
          Reset to defaults
        </button>
        <button type="button" onClick={() => void copyValues()}>
          {copy === 'copied' ? 'Copied' : copy === 'failed' ? 'Copy failed' : 'Copy values'}
        </button>
      </footer>
    </section>,
    document.body,
  );
}
