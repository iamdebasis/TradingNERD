import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CloseIcon } from '../toolbar/icons';
import styles from './ChartSettingsDialog.module.css';
import { chartSettings, type Fill, useChartSettings } from './chartSettings';
import { Dropdown } from './Dropdown';
import { timezoneMenu } from './timezones';

const SESSIONS = [
  { value: 'regular', label: 'Regular trading hours' },
  { value: 'extended', label: 'Extended trading hours' },
] as const;

/**
 * TradingView's Chart settings, Symbol tab (docs/SPEC.md §5.8): its Data modification fields
 * that this chart has. Session and the pre/post market hours background are for symbols with
 * extended hours (stocks and funds); the time zone is for every chart. Changes show at once;
 * Cancel, Escape and ✕ put the old settings back, Ok keeps them.
 */
export function ChartSettingsDialog({
  hasSessions,
  onClose,
}: {
  /** The chart's symbol trades in sessions with pre- and post-market hours. */
  hasSessions: boolean;
  onClose(): void;
}) {
  const titleId = useId();
  const settings = useChartSettings();
  const [initial] = useState(() => chartSettings.get());
  const dialog = useRef<HTMLDivElement>(null);
  const zones = useMemo(
    () => [{ value: 'exchange', label: 'Exchange' }, ...timezoneMenu(Date.now()).map(toOption)],
    [],
  );

  const cancel = () => {
    chartSettings.replace(initial);
    onClose();
  };
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;

  useEffect(() => {
    dialog.current?.querySelector<HTMLElement>('button[aria-haspopup]')?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      cancelRef.current();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  return createPortal(
    <div className={styles.backdrop}>
      <div
        ref={dialog}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className={styles.header}>
          <h2 id={titleId} className={styles.title}>
            Chart settings
          </h2>
          <button type="button" className={styles.close} aria-label="Close" onClick={cancel}>
            <CloseIcon />
          </button>
        </header>
        <div className={styles.body}>
          <nav className={styles.tabs} aria-label="Settings">
            <button type="button" className={styles.tab} aria-current="page">
              <SymbolTabIcon />
              Symbol
            </button>
          </nav>
          <section className={styles.content} aria-label="Symbol">
            <h3 className={styles.section}>Data modification</h3>
            {hasSessions && (
              <div className={styles.row}>
                <span className={styles.label}>Session</span>
                <div className={styles.control}>
                  <Dropdown
                    label="Session"
                    value={settings.session}
                    options={SESSIONS}
                    onChange={(session) =>
                      chartSettings.set({
                        session: session === 'extended' ? 'extended' : 'regular',
                      })
                    }
                  />
                </div>
              </div>
            )}
            {hasSessions && (
              <div className={styles.row}>
                <span className={styles.label}>Pre/post market hours background</span>
                <div className={styles.swatches}>
                  <Swatch
                    label="Pre-market hours background"
                    fill={settings.preMarketBackground}
                    onChange={(fill) => chartSettings.set({ preMarketBackground: fill })}
                  />
                  <Swatch
                    label="Post-market hours background"
                    fill={settings.postMarketBackground}
                    onChange={(fill) => chartSettings.set({ postMarketBackground: fill })}
                  />
                </div>
              </div>
            )}
            <div className={styles.row}>
              <span className={styles.label}>Timezone</span>
              <div className={styles.control}>
                <Dropdown
                  label="Timezone"
                  value={settings.timezone}
                  options={zones}
                  onChange={(timezone) => chartSettings.set({ timezone })}
                />
              </div>
            </div>
          </section>
        </div>
        <footer className={styles.footer}>
          <button type="button" className={styles.secondary} onClick={cancel}>
            Cancel
          </button>
          <button type="button" className={styles.primary} onClick={onClose}>
            Ok
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

const toOption = ({ zone, label }: { zone: string; label: string }) => ({ value: zone, label });

/**
 * A background color's swatch: the color over a checkerboard, so its transparency shows. It
 * opens a small editor: the color and its opacity. (TradingView's own color picker isn't
 * documented; this one is provisional, docs/SPEC.md §11.)
 */
function Swatch({
  label,
  fill,
  onChange,
}: {
  label: string;
  fill: Fill;
  onChange(fill: Fill): void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const percent = Math.round(fill.opacity * 100);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // The editor closes; the dialog under it stays.
      event.preventDefault();
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  return (
    <div ref={box} className={styles.swatchBox}>
      <button
        type="button"
        className={styles.swatch}
        aria-label={`${label}: ${fill.color}, ${percent}% opacity`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className={styles.swatchColor} style={{ background: cssColor(fill) }} />
      </button>
      {open && (
        <fieldset className={styles.editor} aria-label={label}>
          <label className={styles.editorRow}>
            <span>Color</span>
            <input
              type="color"
              className={styles.colorInput}
              value={fill.color.toLowerCase()}
              onChange={(event) => onChange({ ...fill, color: event.target.value.toUpperCase() })}
            />
          </label>
          <label className={styles.editorRow}>
            <span>Opacity</span>
            <input
              type="range"
              className={styles.range}
              min={0}
              max={100}
              value={percent}
              onChange={(event) => onChange({ ...fill, opacity: Number(event.target.value) / 100 })}
            />
            <output className={styles.percent}>{percent}%</output>
          </label>
        </fieldset>
      )}
    </div>
  );
}

function cssColor({ color, opacity }: Fill): string {
  const value = Number.parseInt(color.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${opacity})`;
}

/** The Symbol tab's icon: TradingView's two candles. */
function SymbolTabIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" aria-hidden>
      <rect x="7.5" y="9.5" width="4" height="9" rx="0.5" />
      <path d="M9.5 6.5v3M9.5 18.5v3" />
      <rect x="16.5" y="11.5" width="4" height="6" rx="0.5" />
      <path d="M18.5 8.5v3M18.5 17.5v3" />
    </svg>
  );
}
