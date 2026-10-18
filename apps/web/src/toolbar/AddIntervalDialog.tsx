import { formatResolution, parseResolution } from '@tradingnerd/core';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import styles from './AddIntervalDialog.module.css';
import { CloseIcon } from './icons';

interface Unit {
  label: string;
  /** Largest count the interval parser accepts for this unit. */
  max: number;
  /** TradingView notation for `count` of this unit. */
  notation(count: number): string;
}

const UNITS: readonly Unit[] = [
  { label: 'Ticks', max: 1_000, notation: (n) => `${n}T` },
  { label: 'Seconds', max: 59, notation: (n) => `${n}S` },
  { label: 'Minutes', max: 1_440, notation: (n) => `${n}` },
  { label: 'Hours', max: 24, notation: (n) => `${n * 60}` },
  { label: 'Days', max: 365, notation: (n) => `${n}D` },
  { label: 'Weeks', max: 52, notation: (n) => `${n}W` },
  { label: 'Months', max: 12, notation: (n) => `${n}M` },
];

const MINUTES = 2;

/** The interval in TradingView notation, or null when the count is out of range. */
export function customInterval(countText: string, unitIndex: number): string | null {
  const unit = UNITS[unitIndex];
  if (!unit || !/^\d{1,4}$/.test(countText.trim())) return null;
  const count = Number(countText);
  if (count < 1 || count > unit.max) return null;
  const resolution = parseResolution(unit.notation(count));
  return resolution ? formatResolution(resolution) : null;
}

export interface AddIntervalDialogProps {
  onAdd(interval: string): void;
  onClose(): void;
}

/** "Add custom interval": a count and a unit; the interval joins its menu section. */
export function AddIntervalDialog({ onAdd, onClose }: AddIntervalDialogProps) {
  const id = useId();
  const [count, setCount] = useState('1');
  const [unitIndex, setUnitIndex] = useState(MINUTES);
  const interval = customInterval(count, unitIndex);
  const unit = UNITS[unitIndex] ?? (UNITS[MINUTES] as Unit);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (interval) onAdd(interval);
  };

  return createPortal(
    <div className={styles.backdrop}>
      <form
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        onSubmit={submit}
      >
        <div className={styles.titleRow}>
          <h2 id={`${id}-title`} className={styles.title}>
            Add custom interval
          </h2>
          <button type="button" className={styles.close} aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <div className={styles.fields}>
          <label className={styles.field}>
            <span className={styles.label}>Interval</span>
            <input
              className={styles.input}
              inputMode="numeric"
              // biome-ignore lint/a11y/noAutofocus: the dialog exists to type this number
              autoFocus
              value={count}
              aria-invalid={interval === null}
              onChange={(event) => setCount(event.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Type</span>
            <select
              className={styles.input}
              value={unitIndex}
              onChange={(event) => setUnitIndex(Number(event.target.value))}
            >
              {UNITS.map((option, index) => (
                <option key={option.label} value={index}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className={styles.hint} data-invalid={interval === null}>
          {interval === null ? `Enter a whole number from 1 to ${unit.max}` : ' '}
        </p>
        <div className={styles.actions}>
          <button type="button" className={styles.cancel} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={styles.submit} disabled={interval === null}>
            Add
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
