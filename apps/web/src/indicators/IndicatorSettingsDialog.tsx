import {
  type DisplaySettings,
  defaultSettings,
  type IndicatorDefinition,
  type IndicatorSettings,
  type InputSpec,
  type InputValue,
  indicatorDefinition,
  type LineDash,
  PRECISIONS,
  SOURCES,
  type StyleValue,
} from '@tradingnerd/indicators';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Dropdown } from '../chart/Dropdown';
import { CloseIcon } from '../toolbar/icons';
import styles from './IndicatorSettingsDialog.module.css';
import { indicatorStore, useIndicators } from './indicatorStore';

type Tab = 'inputs' | 'style';

const DASHES: readonly { value: LineDash; label: string }[] = [
  { value: 'solid', label: 'Solid' },
  { value: 'dashed', label: 'Dashed' },
  { value: 'dotted', label: 'Dotted' },
];

/** The Precision menu: Default (the indicator's own), then 0 to 8 decimals. */
const PRECISION_OPTIONS = [
  { value: 'default', label: 'Default' },
  ...PRECISIONS.map((digits) => ({ value: String(digits), label: String(digits) })),
];

/**
 * An indicator's settings, as TradingView's (Pine docs, Inputs; the Help Center): the Inputs
 * tab when it has inputs, then Style; Defaults → Reset settings at the bottom left, Cancel and
 * Ok at the right. Changes show on the chart at once; Cancel, Escape and ✕ put the old ones
 * back, Ok keeps them. Visibility and Save as default come later (milestones I2 and I4). The
 * look is provisional until measured from a screenshot (docs/SPEC.md §11).
 */
export function IndicatorSettingsDialog({ id, onClose }: { id: string; onClose(): void }) {
  const titleId = useId();
  const { list } = useIndicators();
  const indicator = list.find((item) => item.id === id);
  const [initial] = useState(() => indicator?.settings);
  const definition = indicator ? indicatorDefinition(indicator.kind) : null;
  const [tab, setTab] = useState<Tab>(
    definition && definition.inputs.length > 0 ? 'inputs' : 'style',
  );
  const [defaultsOpen, setDefaultsOpen] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);

  const cancel = () => {
    if (initial) indicatorStore.setSettings(id, initial);
    onClose();
  };
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;

  useEffect(() => {
    dialog.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      cancelRef.current();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  // Removed meanwhile (another tab of the app): nothing left to set.
  useEffect(() => {
    if (!indicator) onClose();
  }, [indicator, onClose]);

  if (!indicator || !definition) return null;
  const { settings } = indicator;
  const set = (next: IndicatorSettings) => indicatorStore.setSettings(id, next);
  const setInput = (inputId: string, value: InputValue) =>
    set({ ...settings, inputs: { ...settings.inputs, [inputId]: value } });
  const setStyle = (styleId: string, style: StyleValue) =>
    set({ ...settings, styles: { ...settings.styles, [styleId]: style } });
  const setDisplay = (display: DisplaySettings) => set({ ...settings, display });

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
            {definition.shortName}
          </h2>
          <button type="button" className={styles.close} aria-label="Close" onClick={cancel}>
            <CloseIcon />
          </button>
        </header>
        <div className={styles.tabs} role="tablist" aria-label="Settings">
          {definition.inputs.length > 0 && (
            <button
              type="button"
              role="tab"
              className={styles.tab}
              aria-selected={tab === 'inputs'}
              onClick={() => setTab('inputs')}
            >
              Inputs
            </button>
          )}
          <button
            type="button"
            role="tab"
            className={styles.tab}
            aria-selected={tab === 'style'}
            onClick={() => setTab('style')}
          >
            Style
          </button>
        </div>
        <div className={styles.content} role="tabpanel">
          {tab === 'inputs' ? (
            <InputsTab definition={definition} settings={settings} onInput={setInput} />
          ) : (
            <StyleTab
              definition={definition}
              settings={settings}
              onStyle={setStyle}
              onDisplay={setDisplay}
            />
          )}
        </div>
        <footer className={styles.footer}>
          <div className={styles.defaults}>
            <button
              type="button"
              className={styles.secondary}
              aria-expanded={defaultsOpen}
              onClick={() => setDefaultsOpen(!defaultsOpen)}
            >
              Defaults
            </button>
            {defaultsOpen && (
              <div className={styles.defaultsMenu} role="menu">
                <button
                  type="button"
                  role="menuitem"
                  className={styles.menuItem}
                  onClick={() => {
                    setDefaultsOpen(false);
                    set(defaultSettings(definition));
                  }}
                >
                  Reset settings
                </button>
              </div>
            )}
          </div>
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

function InputsTab({
  definition,
  settings,
  onInput,
}: {
  definition: IndicatorDefinition;
  settings: IndicatorSettings;
  onInput(id: string, value: InputValue): void;
}) {
  let group: string | undefined;
  const rows = [];
  for (const spec of definition.inputs) {
    if (spec.group !== group) {
      group = spec.group;
      if (group) {
        rows.push(
          <h3 key={`group-${group}`} className={styles.section}>
            {group}
          </h3>,
        );
      }
    }
    rows.push(
      <InputRow
        key={spec.id}
        spec={spec}
        value={settings.inputs[spec.id] ?? spec.default}
        disabled={spec.enabledWhen ? !spec.enabledWhen(settings.inputs) : false}
        onChange={(value) => onInput(spec.id, value)}
      />,
    );
  }
  return <>{rows}</>;
}

function InputRow({
  spec,
  value,
  disabled,
  onChange,
}: {
  spec: InputSpec;
  value: InputValue;
  disabled: boolean;
  onChange(value: InputValue): void;
}) {
  const id = useId();
  if (spec.kind === 'bool') {
    return (
      <label className={styles.row} data-disabled={disabled || undefined}>
        <span className={styles.checkLabel}>
          <input
            type="checkbox"
            className={styles.checkbox}
            checked={value === true}
            disabled={disabled}
            onChange={(event) => onChange(event.target.checked)}
          />
          {spec.title}
        </span>
      </label>
    );
  }
  return (
    <div className={styles.row} data-disabled={disabled || undefined}>
      <label className={styles.label} htmlFor={id}>
        {spec.title}
      </label>
      <div className={styles.control}>
        {spec.kind === 'int' || spec.kind === 'float' ? (
          <NumberField
            id={id}
            value={value as number}
            min={spec.min}
            max={spec.max}
            step={spec.kind === 'float' ? spec.step : 1}
            disabled={disabled}
            onChange={onChange}
          />
        ) : (
          <Dropdown
            label={spec.title}
            value={String(value)}
            options={(spec.kind === 'source' ? SOURCES : spec.options).map((option) => ({
              value: option,
              label: option,
            }))}
            onChange={onChange}
          />
        )}
      </div>
    </div>
  );
}

/**
 * A number field that keeps what's typed until it's a number: each valid value applies at once
 * (clamped to the input's range by the store), and leaving the field shows the value applied.
 */
function NumberField({
  id,
  value,
  min,
  max,
  step,
  disabled,
  onChange,
}: {
  id: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled: boolean;
  onChange(value: number): void;
}) {
  const [text, setText] = useState(String(value));
  const [focused, setFocused] = useState(false);
  const shown = focused ? text : String(value);
  return (
    <input
      id={id}
      type="number"
      className={styles.number}
      inputMode="decimal"
      value={shown}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onFocus={() => {
        setText(String(value));
        setFocused(true);
      }}
      onBlur={() => setFocused(false)}
      onChange={(event) => {
        setText(event.target.value);
        const number = Number(event.target.value);
        if (event.target.value.trim() !== '' && Number.isFinite(number)) onChange(number);
      }}
    />
  );
}

type StyleKind = 'line' | 'columns' | 'level' | 'fill' | 'gradient';

function StyleTab({
  definition,
  settings,
  onStyle,
  onDisplay,
}: {
  definition: IndicatorDefinition;
  settings: IndicatorSettings;
  onStyle(id: string, style: StyleValue): void;
  onDisplay(display: DisplaySettings): void;
}) {
  const { inputs, styles: looks, display } = settings;
  const plots = definition.plots.filter((plot) => plot.shownWhen?.(inputs) ?? true);
  const fills = definition.fills.filter((fill) => fill.shownWhen?.(inputs) ?? true);
  const row = (id: string, title: string, kind: StyleKind) => {
    const style = looks[id];
    if (!style) return null;
    return (
      <StyleRow
        key={id}
        title={title}
        kind={kind}
        style={style}
        onChange={(next) => onStyle(id, next)}
      />
    );
  };
  return (
    <>
      {plots.map((plot) => row(plot.id, plot.title, plot.kind))}
      {definition.levels.map((level) => row(level.id, level.title, 'level'))}
      {fills.map((fill) => row(fill.id, fill.title, fill.gradient ? 'gradient' : 'fill'))}
      <DisplaySection definition={definition} display={display} onChange={onDisplay} />
    </>
  );
}

/**
 * The Style tab's "Output values": Precision, "Labels on price scale" and "Values in status
 * line" (TradingView's Help Center and blog, 2022); then "Input values" with "Inputs in status
 * line" (not in TradingView's docs: provisional, docs/SPEC.md §11). Volume has no inputs in its
 * legend, and no label on the price scale yet (whether TradingView draws one is still to
 * measure), so those rows aren't offered for it.
 */
function DisplaySection({
  definition,
  display,
  onChange,
}: {
  definition: IndicatorDefinition;
  display: DisplaySettings;
  onChange(display: DisplaySettings): void;
}) {
  const labelsOnScale = definition.placement === 'pane';
  const inputsInLegend = definition.legendInputs(defaultSettings(definition).inputs) !== '';
  const check = (key: 'priceLabels' | 'statusValues' | 'statusInputs', title: string) => (
    <label className={styles.row}>
      <span className={styles.checkLabel}>
        <input
          type="checkbox"
          className={styles.checkbox}
          checked={display[key]}
          onChange={(event) => onChange({ ...display, [key]: event.target.checked })}
        />
        {title}
      </span>
    </label>
  );
  return (
    <>
      <h3 className={styles.section}>Output values</h3>
      <div className={styles.row}>
        <span className={styles.label}>Precision</span>
        <div className={styles.control}>
          <Dropdown
            label="Precision"
            value={display.precision === null ? 'default' : String(display.precision)}
            options={PRECISION_OPTIONS}
            onChange={(value) =>
              onChange({ ...display, precision: value === 'default' ? null : Number(value) })
            }
          />
        </div>
      </div>
      {labelsOnScale && check('priceLabels', 'Labels on price scale')}
      {check('statusValues', 'Values in status line')}
      {inputsInLegend && (
        <>
          <h3 className={styles.section}>Input values</h3>
          {check('statusInputs', 'Inputs in status line')}
        </>
      )}
    </>
  );
}

function StyleRow({
  title,
  kind,
  style,
  onChange,
}: {
  title: string;
  kind: StyleKind;
  style: StyleValue;
  onChange(style: StyleValue): void;
}) {
  const id = useId();
  return (
    <div className={styles.row}>
      <span className={styles.checkLabel}>
        <input
          id={id}
          type="checkbox"
          className={styles.checkbox}
          checked={style.visible}
          onChange={(event) => onChange({ ...style, visible: event.target.checked })}
        />
        <label htmlFor={id}>{title}</label>
      </span>
      <div className={styles.styleControls}>
        <Swatch
          label={
            kind === 'columns' ? `${title}: growing` : kind === 'gradient' ? `${title}: top` : title
          }
          style={style}
          lines={kind === 'line' || kind === 'level'}
          onChange={onChange}
        />
        {kind === 'columns' && style.fallingColor !== undefined && (
          <Swatch
            label={`${title}: falling`}
            style={{ ...style, color: style.fallingColor }}
            lines={false}
            onChange={(next) =>
              onChange({ ...style, fallingColor: next.color, opacity: next.opacity })
            }
          />
        )}
        {kind === 'gradient' && style.bottomColor !== undefined && (
          <Swatch
            label={`${title}: bottom`}
            style={{
              ...style,
              color: style.bottomColor,
              opacity: style.bottomOpacity ?? style.opacity,
            }}
            lines={false}
            onChange={(next) =>
              onChange({ ...style, bottomColor: next.color, bottomOpacity: next.opacity })
            }
          />
        )}
        {kind === 'level' && (
          <input
            type="number"
            className={styles.levelValue}
            aria-label={`${title} value`}
            value={style.value ?? 0}
            onChange={(event) => {
              const number = Number(event.target.value);
              if (event.target.value.trim() !== '' && Number.isFinite(number)) {
                onChange({ ...style, value: number });
              }
            }}
          />
        )}
      </div>
    </div>
  );
}

/**
 * A plot's color swatch, over a checkerboard so its transparency shows. It opens a small editor:
 * the color and its opacity, and for lines their thickness and style. TradingView's own picker
 * isn't documented; this one is provisional (docs/SPEC.md §11).
 */
function Swatch({
  label,
  style,
  lines,
  onChange,
}: {
  label: string;
  style: StyleValue;
  /** A line's thickness and style are set here too. */
  lines: boolean;
  onChange(style: StyleValue): void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const percent = Math.round(style.opacity * 100);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      // The line style's list opens over everything; a choice in it is still the editor's.
      const target = event.target as Element;
      if (!box.current?.contains(target) && !target.closest?.('[role="listbox"]')) setOpen(false);
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
        aria-label={`${label}: ${style.color}, ${percent}% opacity`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className={styles.swatchColor} style={{ background: cssColor(style) }} />
      </button>
      {open && (
        <fieldset className={styles.editor} aria-label={label}>
          <label className={styles.editorRow}>
            <span>Color</span>
            <input
              type="color"
              className={styles.colorInput}
              value={style.color.toLowerCase()}
              onChange={(event) => onChange({ ...style, color: event.target.value.toUpperCase() })}
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
              onChange={(event) =>
                onChange({ ...style, opacity: Number(event.target.value) / 100 })
              }
            />
            <output className={styles.percent}>{percent}%</output>
          </label>
          {lines && style.width !== undefined && (
            <div className={styles.editorRow}>
              <span>Thickness</span>
              <fieldset className={styles.widths} aria-label="Thickness">
                {[1, 2, 3, 4].map((width) => (
                  <button
                    key={width}
                    type="button"
                    className={styles.width}
                    aria-label={`${width} px`}
                    aria-pressed={style.width === width}
                    onClick={() => onChange({ ...style, width })}
                  >
                    <span style={{ height: width }} />
                  </button>
                ))}
              </fieldset>
            </div>
          )}
          {lines && style.dash !== undefined && (
            <div className={styles.editorRow}>
              <span>Style</span>
              <div className={styles.dash}>
                <Dropdown
                  label="Line style"
                  value={style.dash}
                  options={DASHES}
                  onChange={(dash) => onChange({ ...style, dash: dash as LineDash })}
                />
              </div>
            </div>
          )}
        </fieldset>
      )}
    </div>
  );
}

function cssColor({ color, opacity }: StyleValue): string {
  const value = Number.parseInt(color.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${opacity})`;
}
