import type { ChartController } from '@tradingnerd/chart';
import {
  type Drawing,
  type DrawingStats,
  type DrawingStyle,
  type DrawingText,
  H_ALIGNS,
  type HAlign,
  LINE_ENDS,
  type LineEnd,
  MAX_DRAWING_TEXT,
  TOOL_NAMES,
  TOOL_OPTIONS,
  V_ALIGNS,
  type VAlign,
  VISIBILITY_LIMITS,
  VISIBILITY_UNITS,
  type VisibilityUnit,
} from '@tradingnerd/core';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Dropdown } from '../chart/Dropdown';
import frame from '../indicators/IndicatorSettingsDialog.module.css';
import { CloseIcon } from '../toolbar/icons';
import { ColorField } from './ColorEditor';
import styles from './Drawings.module.css';
import { drawingStore, useDrawings } from './drawingStore';

type Tab = 'style' | 'text' | 'coordinates' | 'visibility';

const ALIGN_H_NAMES: Record<HAlign, string> = { left: 'Left', center: 'Center', right: 'Right' };
const ALIGN_V_NAMES: Record<VAlign, string> = { top: 'Top', middle: 'Middle', bottom: 'Bottom' };
const END_NAMES: Record<LineEnd, string> = { normal: 'Normal', arrow: 'Arrow' };

/** TradingView's stats, as its Style tab names them (Help Center, Trendline drawing tool). */
const STATS: readonly { key: keyof DrawingStats; name: string }[] = [
  { key: 'priceRange', name: 'Price range' },
  { key: 'percentChange', name: 'Percent change' },
  { key: 'pips', name: 'Change in pips' },
  { key: 'barsRange', name: 'Bars range' },
  { key: 'dateTimeRange', name: 'Date/time range' },
  { key: 'distance', name: 'Distance' },
  { key: 'angle', name: 'Angle' },
];

const UNIT_NAMES: Record<VisibilityUnit, string> = {
  ticks: 'Ticks',
  seconds: 'Seconds',
  minutes: 'Minutes',
  hours: 'Hours',
  days: 'Days',
  weeks: 'Weeks',
  months: 'Months',
  ranges: 'Ranges',
};

/** The text sizes offered (provisional, §11). */
const TEXT_SIZES = [10, 11, 12, 14, 16, 20, 24, 28, 32, 40];

/**
 * A drawing's settings (TradingView's dialog: Style, Text, Coordinates, Visibility; Help Center,
 * Trendline drawing tool). Changes show on the chart at once; Ok keeps them as one undo step,
 * Cancel, Escape and ✕ put the drawing back. The rows each tool has, and the look, are
 * provisional until measured from screenshots (docs/SPEC.md §11).
 */
export function DrawingSettingsDialog({
  id,
  chart,
  onClose,
}: {
  id: string;
  chart: ChartController | null;
  onClose(): void;
}) {
  const titleId = useId();
  const { drawings } = useDrawings();
  const drawing = drawings.find((item) => item.id === id);
  const [before] = useState(() => drawingStore.get().drawings);
  const [tab, setTab] = useState<Tab>('style');
  const dialog = useRef<HTMLDivElement>(null);

  const cancel = () => {
    drawingStore.finishPreview(before, false);
    onClose();
  };
  const ok = () => {
    drawingStore.finishPreview(before, true);
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

  // Removed meanwhile (undo, another tab): nothing left to set.
  useEffect(() => {
    if (!drawing) onClose();
  }, [drawing, onClose]);

  if (!drawing) return null;
  const options = TOOL_OPTIONS[drawing.tool];
  const set = (next: Drawing) => drawingStore.preview(next);
  const setStyle = (change: Partial<DrawingStyle>) =>
    set({ ...drawing, style: { ...drawing.style, ...change } });
  const tabs: { tab: Tab; name: string }[] = [
    { tab: 'style', name: 'Style' },
    ...(options.text ? [{ tab: 'text' as const, name: 'Text' }] : []),
    { tab: 'coordinates', name: 'Coordinates' },
    { tab: 'visibility', name: 'Visibility' },
  ];

  return createPortal(
    <div className={frame.backdrop}>
      <div
        ref={dialog}
        className={frame.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className={frame.header}>
          <h2 id={titleId} className={frame.title}>
            {TOOL_NAMES[drawing.tool]}
          </h2>
          <button type="button" className={frame.close} aria-label="Close" onClick={cancel}>
            <CloseIcon />
          </button>
        </header>
        <div className={frame.tabs} role="tablist" aria-label="Settings">
          {tabs.map((item) => (
            <button
              key={item.tab}
              type="button"
              role="tab"
              className={frame.tab}
              aria-selected={tab === item.tab}
              onClick={() => setTab(item.tab)}
            >
              {item.name}
            </button>
          ))}
        </div>
        <div className={frame.content} role="tabpanel">
          {tab === 'style' && <StyleTab drawing={drawing} onStyle={setStyle} />}
          {tab === 'text' && (
            <TextTab
              text={drawing.style.text}
              onText={(text) => setStyle({ text: { ...drawing.style.text, ...text } })}
            />
          )}
          {tab === 'coordinates' && <CoordinatesTab drawing={drawing} chart={chart} onSet={set} />}
          {tab === 'visibility' && (
            <VisibilityTab
              drawing={drawing}
              onSet={(visibility) => set({ ...drawing, visibility })}
            />
          )}
        </div>
        <footer className={frame.footer}>
          <span style={{ marginRight: 'auto' }} />
          <button type="button" className={frame.secondary} onClick={cancel}>
            Cancel
          </button>
          <button type="button" className={frame.primary} onClick={ok}>
            Ok
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange(checked: boolean): void;
}) {
  return (
    <label className={frame.row}>
      <span className={frame.checkLabel}>
        <input
          type="checkbox"
          className={frame.checkbox}
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
        />
        {label}
      </span>
    </label>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={frame.row}>
      <span className={frame.label}>{label}</span>
      <div className={frame.control}>{children}</div>
    </div>
  );
}

function StyleTab({
  drawing,
  onStyle,
}: {
  drawing: Drawing;
  onStyle(change: Partial<DrawingStyle>): void;
}) {
  const { style } = drawing;
  const options = TOOL_OPTIONS[drawing.tool];
  return (
    <>
      <div className={frame.row}>
        <span className={frame.label}>Line</span>
        <ColorField
          label="Line"
          color={style.color}
          onChange={(color) => onStyle({ color })}
          line={{
            width: style.width,
            lineStyle: style.lineStyle,
            onWidth: (width) => onStyle({ width }),
            onStyle: (lineStyle) => onStyle({ lineStyle }),
          }}
        />
      </div>
      {options.ends && (
        <>
          <Row label="Left end">
            <Dropdown
              label="Left end"
              value={style.leftEnd}
              options={LINE_ENDS.map((end) => ({ value: end, label: END_NAMES[end] }))}
              onChange={(value) => onStyle({ leftEnd: value as LineEnd })}
            />
          </Row>
          <Row label="Right end">
            <Dropdown
              label="Right end"
              value={style.rightEnd}
              options={LINE_ENDS.map((end) => ({ value: end, label: END_NAMES[end] }))}
              onChange={(value) => onStyle({ rightEnd: value as LineEnd })}
            />
          </Row>
        </>
      )}
      {options.extend && (
        <>
          <Check
            label="Extend left"
            checked={style.extendLeft}
            onChange={(extendLeft) => onStyle({ extendLeft })}
          />
          <Check
            label="Extend right"
            checked={style.extendRight}
            onChange={(extendRight) => onStyle({ extendRight })}
          />
        </>
      )}
      {options.middlePoint && (
        <Check
          label="Middle point"
          checked={style.showMiddlePoint}
          onChange={(showMiddlePoint) => onStyle({ showMiddlePoint })}
        />
      )}
      {options.priceLabels && (
        <Check
          label="Price labels"
          checked={style.showPriceLabels}
          onChange={(showPriceLabels) => onStyle({ showPriceLabels })}
        />
      )}
      {options.showPrice && (
        <Check
          label="Price label"
          checked={style.showPrice}
          onChange={(showPrice) => onStyle({ showPrice })}
        />
      )}
      {options.showTime && (
        <Check
          label="Time label"
          checked={style.showTime}
          onChange={(showTime) => onStyle({ showTime })}
        />
      )}
      {options.stats && (
        <>
          <h3 className={frame.section}>Stats</h3>
          {STATS.map(({ key, name }) => (
            <Check
              key={key}
              label={name}
              checked={style.stats[key]}
              onChange={(on) => onStyle({ stats: { ...style.stats, [key]: on } })}
            />
          ))}
          <Check
            label="Always show stats"
            checked={style.alwaysShowStats}
            onChange={(alwaysShowStats) => onStyle({ alwaysShowStats })}
          />
          <Row label="Stats position">
            <Dropdown
              label="Stats position"
              value={style.statsPosition}
              options={H_ALIGNS.map((align) => ({ value: align, label: ALIGN_H_NAMES[align] }))}
              onChange={(value) => onStyle({ statsPosition: value as HAlign })}
            />
          </Row>
        </>
      )}
    </>
  );
}

function TextTab({
  text,
  onText,
}: {
  text: DrawingText;
  onText(change: Partial<DrawingText>): void;
}) {
  return (
    <>
      <textarea
        className={frame.textArea}
        aria-label="Text"
        placeholder="Add text"
        rows={4}
        maxLength={MAX_DRAWING_TEXT}
        value={text.value}
        onChange={(event) => onText({ value: event.target.value })}
      />
      <div className={frame.row}>
        <span className={frame.label}>Color</span>
        <ColorField label="Text color" color={text.color} onChange={(color) => onText({ color })} />
      </div>
      <Row label="Font size">
        <Dropdown
          label="Font size"
          value={String(text.size)}
          options={[...new Set([...TEXT_SIZES, text.size])]
            .sort((a, b) => a - b)
            .map((size) => ({ value: String(size), label: String(size) }))}
          onChange={(value) => onText({ size: Number(value) })}
        />
      </Row>
      <Check label="Bold" checked={text.bold} onChange={(bold) => onText({ bold })} />
      <Check label="Italic" checked={text.italic} onChange={(italic) => onText({ italic })} />
      <Row label="Text alignment">
        <Dropdown
          label="Horizontal alignment"
          value={text.alignH}
          options={H_ALIGNS.map((align) => ({ value: align, label: ALIGN_H_NAMES[align] }))}
          onChange={(value) => onText({ alignH: value as HAlign })}
        />
      </Row>
      <Row label="Vertical alignment">
        <Dropdown
          label="Vertical alignment"
          value={text.alignV}
          options={V_ALIGNS.map((align) => ({ value: align, label: ALIGN_V_NAMES[align] }))}
          onChange={(value) => onText({ alignV: value as VAlign })}
        />
      </Row>
    </>
  );
}

/**
 * Each point's price and bar (TradingView's Coordinates tab: "price and bar number"); bars
 * counted from the first loaded. A horizontal line has only a price, a vertical line only a bar.
 */
function CoordinatesTab({
  drawing,
  chart,
  onSet,
}: {
  drawing: Drawing;
  chart: ChartController | null;
  onSet(drawing: Drawing): void;
}) {
  const priced = drawing.tool !== 'vertical-line';
  const timed = drawing.tool !== 'horizontal-line' && chart !== null;
  const setPoint = (index: number, change: { price?: number; bar?: number }) => {
    const points = drawing.points.map((point, i) => {
      if (i !== index) return point;
      return {
        price: change.price ?? point.price,
        time: change.bar !== undefined && chart ? chart.drawingTimeOf(change.bar) : point.time,
      };
    });
    onSet({ ...drawing, points });
  };
  return (
    <>
      {drawing.points
        .map((point, index) => ({ point, index, key: `point-${index + 1}` }))
        .map(({ point, index, key }) => (
          <div key={key} className={frame.row}>
            <span className={frame.label}>
              {drawing.points.length > 1 ? `#${index + 1}` : 'Point'}
            </span>
            <div className={styles.coordinate}>
              {priced && (
                <NumberField
                  label={`Price ${index + 1}`}
                  value={point.price}
                  onChange={(price) => setPoint(index, { price })}
                />
              )}
              {timed && chart && (
                <NumberField
                  label={`Bar ${index + 1}`}
                  value={chart.drawingBarOf(point.time)}
                  step={1}
                  onChange={(bar) => setPoint(index, { bar: Math.round(bar) })}
                />
              )}
            </div>
          </div>
        ))}
    </>
  );
}

/** A number field that takes what's typed once it's a number. */
function NumberField({
  label,
  value,
  step = 'any',
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  step?: number | 'any';
  min?: number;
  max?: number;
  onChange(value: number): void;
}) {
  const [text, setText] = useState(String(value));
  const shown = useRef(value);
  // Changed from outside (another field, undo): the field follows.
  if (shown.current !== value && Number(text) !== value) {
    shown.current = value;
    setText(String(value));
  }
  return (
    <input
      type="number"
      className={frame.number}
      aria-label={label}
      value={text}
      step={step}
      min={min}
      max={max}
      onChange={(event) => {
        setText(event.target.value);
        const number = Number(event.target.value);
        if (event.target.value.trim() === '' || !Number.isFinite(number)) return;
        if ((min !== undefined && number < min) || (max !== undefined && number > max)) return;
        shown.current = number;
        onChange(number);
      }}
    />
  );
}

/** Which intervals it shows on (Help Center, How to set drawing visibility on intervals). */
function VisibilityTab({
  drawing,
  onSet,
}: {
  drawing: Drawing;
  onSet(visibility: Drawing['visibility']): void;
}) {
  const { visibility } = drawing;
  return (
    <>
      {VISIBILITY_UNITS.map((unit) => {
        const row = visibility[unit];
        const limits = VISIBILITY_LIMITS[unit];
        const setRow = (change: Partial<typeof row>) =>
          onSet({ ...visibility, [unit]: { ...row, ...change } });
        return (
          <div key={unit} className={frame.row}>
            <label className={frame.checkLabel}>
              <input
                type="checkbox"
                className={frame.checkbox}
                checked={row.on}
                onChange={(event) => setRow({ on: event.target.checked })}
              />
              {UNIT_NAMES[unit]}
            </label>
            {limits && (
              <div className={styles.range2}>
                <NumberField
                  label={`${UNIT_NAMES[unit]} from`}
                  value={row.from}
                  step={1}
                  min={limits[0]}
                  max={limits[1]}
                  onChange={(from) => setRow({ from, to: Math.max(from, row.to) })}
                />
                <span aria-hidden>–</span>
                <NumberField
                  label={`${UNIT_NAMES[unit]} to`}
                  value={row.to}
                  step={1}
                  min={limits[0]}
                  max={limits[1]}
                  onChange={(to) => setRow({ to, from: Math.min(row.from, to) })}
                />
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
