import type { ChartController } from '@tradingnerd/chart';
import {
  applyDrawingStyle,
  type DisplacementAxis,
  type Drawing,
  type DrawingFill,
  type DrawingLevel,
  type DrawingLineStyle,
  type DrawingPoint,
  type DrawingStats,
  type DrawingStyle,
  type DrawingText,
  defaultDrawingStyle,
  displayName,
  drawingName,
  groupPath,
  H_ALIGNS,
  type HAlign,
  isPitchforkTool,
  LINE_ENDS,
  type LineEnd,
  MAX_DEVIATION,
  MAX_DRAWING_NAME,
  MAX_DRAWING_TEXT,
  MAX_LEVEL_COEFF,
  PITCHFORK_KIND_NAMES,
  PITCHFORK_TOOLS,
  PRICE_SOURCES,
  type PriceSource,
  parseDisplacement,
  type RegressionSettings,
  renameGroup,
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
import { PopupMenu } from '../watchlist/PopupMenu';
import { ColorField } from './ColorEditor';
import { joinColor, splitColor } from './color';
import styles from './Drawings.module.css';
import { drawingStore, useDrawings } from './drawingStore';
import { RenameIcon } from './icons';
import { groupLabel } from './objectTreeModel';
import {
  displaceDrawings,
  severalStyle,
  withFill,
  withLine,
  withLineColor,
  withTextColor,
} from './severalStyle';
import { APPLY_DEFAULTS, templateDialogs, templateEntries } from './TemplateMenu';
import { useTemplates } from './templateStore';

type Tab = 'inputs' | 'style' | 'text' | 'coordinates' | 'visibility';

const ALIGN_H_NAMES: Record<HAlign, string> = { left: 'Left', center: 'Center', right: 'Right' };
const ALIGN_V_NAMES: Record<VAlign, string> = { top: 'Top', middle: 'Middle', bottom: 'Bottom' };
/** A channel's text sits over it, inside it or under it (TradingView's blog, 21 August 2023). */
const CHANNEL_V_NAMES: Record<VAlign, string> = { top: 'Top', middle: 'Inside', bottom: 'Bottom' };
const END_NAMES: Record<LineEnd, string> = { normal: 'Normal', arrow: 'Arrow' };
/** Flat top/bottom's and Disjoint channel's Extend drop-down (their Help Center pages). */
const EXTENDS = ['none', 'left', 'right', 'both'] as const;
const EXTEND_NAMES: Record<(typeof EXTENDS)[number], string> = {
  none: "Don't extend",
  left: 'Extend left',
  right: 'Extend right',
  both: 'Extend both',
};
/** The pitchforks' Style drop-down, switching one into another (Help Center, each pitchfork). */
const PITCHFORK_NAMES = PITCHFORK_KIND_NAMES;

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
 * Cancel, Escape and ✕ put the drawing back. Template, at the bottom left (D3b), saves the style
 * shown as a template, or shows a template or the tool's defaults, kept on Ok as the rest is. The
 * rows each tool has, and the look, are provisional until measured from screenshots
 * (docs/SPEC.md §11).
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
  // A regression trend opens on its Inputs, as TradingView's studies do (provisional, §11).
  const [tab, setTab] = useState<Tab>(() =>
    drawing && TOOL_OPTIONS[drawing.tool].regression ? 'inputs' : 'style',
  );
  const dialog = useRef<HTMLDivElement>(null);
  const templates = useTemplates();
  /** The Template menu, open at this place in the window. */
  const [templateAt, setTemplateAt] = useState<{ x: number; y: number } | null>(null);
  const templateButton = useRef<HTMLButtonElement>(null);
  /** Escape is the Template menu's, or its question's, while either is open. */
  const templateOpen = useRef(false);
  templateOpen.current = templateAt !== null;

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
      if (templateOpen.current || templateDialogs.get() !== null) return;
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
    ...(options.regression ? [{ tab: 'inputs' as const, name: 'Inputs' }] : []),
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
          <DrawingTitle
            id={titleId}
            name={displayName(drawing)}
            onRename={(name) => set({ ...drawing, name: drawingName(name) })}
          />
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
          {tab === 'inputs' && (
            <InputsTab
              settings={drawing.style.regression}
              onSettings={(change) =>
                setStyle({ regression: { ...drawing.style.regression, ...change } })
              }
            />
          )}
          {tab === 'style' && <StyleTab drawing={drawing} onStyle={setStyle} onDrawing={set} />}
          {tab === 'text' && (
            <TextTab
              text={drawing.style.text}
              channel={options.fill === 'color'}
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
          <button
            ref={templateButton}
            type="button"
            className={frame.secondary}
            aria-haspopup="menu"
            aria-expanded={templateAt !== null}
            onClick={(event) => {
              if (templateAt) {
                setTemplateAt(null);
                return;
              }
              const at = event.currentTarget.getBoundingClientRect();
              setTemplateAt({ x: Math.round(at.left), y: Math.round(at.bottom + 4) });
            }}
          >
            Template
          </button>
          <span style={{ marginRight: 'auto' }} />
          <button type="button" className={frame.secondary} onClick={cancel}>
            Cancel
          </button>
          <button type="button" className={frame.primary} onClick={ok}>
            Ok
          </button>
        </footer>
        {templateAt && (
          <PopupMenu
            x={templateAt.x}
            y={templateAt.y}
            label="Template"
            anchor={templateButton.current}
            layer={TEMPLATE_MENU_LAYER}
            items={templateEntries({
              tool: drawing.tool,
              state: templates,
              style: () => drawing.style,
              onApply: (style) => set(applyDrawingStyle(drawing, style)),
              dialog: true,
            })}
            onClose={() => setTemplateAt(null)}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}

/** The Template menu over the dialogs (their z-index is 200). */
const TEMPLATE_MENU_LAYER = 210;

/**
 * The dialog's title: the drawing's name, its tool's until it's given one, and a pencil that
 * edits it in place (TradingView's blog, 5 February 2020: "the new name will be displayed in the
 * drawing settings dialog"; its Help Center's image of a group's settings shows the pencil). Enter
 * or leaving the field keeps the name for Ok, as the dialog's other changes are; Escape doesn't.
 */
function DrawingTitle({
  id,
  name,
  onRename,
}: {
  id: string;
  name: string;
  onRename(name: string): void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const editing = draft !== null;
  useEffect(() => {
    if (!editing) return;
    field.current?.focus();
    field.current?.select();
  }, [editing]);
  const keep = () => {
    if (draft === null) return;
    setDraft(null);
    onRename(draft);
  };
  return (
    <div className={styles.titleRow}>
      <h2 id={id} className={frame.title}>
        {draft === null ? (
          name
        ) : (
          <input
            ref={field}
            className={styles.titleField}
            aria-label="Name"
            value={draft}
            maxLength={MAX_DRAWING_NAME}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                keep();
              } else if (event.key === 'Escape') {
                // The field's, not the dialog's Cancel.
                event.preventDefault();
                setDraft(null);
              }
            }}
            onBlur={keep}
          />
        )}
      </h2>
      {draft === null && (
        <button
          type="button"
          className={styles.titleRename}
          aria-label="Rename"
          title="Rename"
          onClick={() => setDraft(name)}
        >
          <RenameIcon />
        </button>
      )}
    </div>
  );
}

/**
 * Settings with several drawings selected, or a group's (docs/SPEC.md §5.27, D3a, D3c2), as
 * TradingView's Help Center and blog images show them (43000660419's GIFs, November 2024;
 * 43000682552's image, 2022): titled "Selected Drawings", or the group's name with the pencil that
 * renames it; tabs Style (Line, Background, Text, a rainbow where they differ), Displacement
 * (price and bar expressions) and Visibility (set for every one, starting from the first's); the
 * Template button's menu without "Save…" (one tool's templates, or "Apply defaults" alone for
 * several tools: provisional §11). Changes show at once; Ok keeps them as one undo step, Cancel,
 * Escape and ✕ put them back.
 */
export function SelectedDrawingsDialog({
  ids,
  group,
  chart,
  onClose,
}: {
  ids: readonly string[];
  /** A group's settings: its id. */
  group: string | null;
  chart: ChartController | null;
  onClose(): void;
}) {
  const titleId = useId();
  const { drawings } = useDrawings();
  const chosen = drawings.filter((item) => ids.includes(item.id));
  const [before] = useState(() => drawingStore.get().drawings);
  const [tab, setTab] = useState<'style' | 'displacement' | 'visibility'>('style');
  const [shift, setShift] = useState<Record<DisplacementAxis, Expression>>({
    price: { text: '', applied: true },
    bar: { text: '', applied: true },
  });
  const dialog = useRef<HTMLDivElement>(null);
  const templates = useTemplates();
  const [templateAt, setTemplateAt] = useState<{ x: number; y: number } | null>(null);
  const templateButton = useRef<HTMLButtonElement>(null);
  const templateOpen = useRef(false);
  templateOpen.current = templateAt !== null;

  const set = (next: readonly Drawing[]) => drawingStore.previewMany(next);
  /** An expression typed in Displacement, on every drawing: true when it was one. */
  const displaceBy = (axis: DisplacementAxis, text: string): boolean => {
    const by = parseDisplacement(text, axis);
    if (!by) return false;
    const current = drawingStore.get().drawings.filter((item) => ids.includes(item.id));
    set(displaceDrawings(current, axis, by, chart));
    return true;
  };

  const cancel = () => {
    drawingStore.finishPreview(before, false);
    onClose();
  };
  const ok = () => {
    // An expression typed and not yet applied with Enter is applied as Ok keeps the rest.
    for (const axis of ['price', 'bar'] as const) {
      if (!shift[axis].applied) displaceBy(axis, shift[axis].text);
    }
    drawingStore.finishPreview(before, true);
    onClose();
  };
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;

  useEffect(() => {
    dialog.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (templateOpen.current) return;
      event.preventDefault();
      cancelRef.current();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  // Every one removed meanwhile (undo, another tab): nothing left to set.
  useEffect(() => {
    if (chosen.length === 0) onClose();
  }, [chosen.length, onClose]);

  const first = chosen[0];
  if (!first) return null;
  const groupName = group ? (groupPath(chosen, group)?.at(-1)?.name ?? '') : null;
  const oneTool = chosen.every((item) => item.tool === first.tool);
  const templateItems = oneTool
    ? templateEntries({
        tool: first.tool,
        state: templates,
        style: () => first.style,
        onApply: (style) => set(chosen.map((item) => applyDrawingStyle(item, style))),
        several: chosen.length > 1,
        dialog: true,
      })
    : [
        {
          label: APPLY_DEFAULTS,
          onSelect: () =>
            set(chosen.map((item) => applyDrawingStyle(item, defaultDrawingStyle(item.tool)))),
        },
      ];
  const tabs = [
    { tab: 'style', name: 'Style' },
    { tab: 'displacement', name: 'Displacement' },
    { tab: 'visibility', name: 'Visibility' },
  ] as const;
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
          {group && groupName !== null ? (
            <DrawingTitle
              id={titleId}
              name={groupLabel(groupName)}
              onRename={(name) => {
                const renamed = renameGroup(drawingStore.get().drawings, group, name);
                set(renamed.filter((item) => item.groups.some((g) => g.id === group)));
              }}
            />
          ) : (
            <h2 id={titleId} className={frame.title}>
              Selected Drawings
            </h2>
          )}
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
          {tab === 'style' && <SeveralStyleTab chosen={chosen} onChange={set} />}
          {tab === 'displacement' && (
            <DisplacementTab
              shift={shift}
              onShift={(axis, text) =>
                setShift((now) => ({ ...now, [axis]: { text, applied: text.trim() === '' } }))
              }
              onApply={(axis) => {
                if (!displaceBy(axis, shift[axis].text)) return false;
                setShift((now) => ({ ...now, [axis]: { ...now[axis], applied: true } }));
                return true;
              }}
            />
          )}
          {tab === 'visibility' && (
            <VisibilityTab
              drawing={first}
              onSet={(visibility) => set(chosen.map((item) => ({ ...item, visibility })))}
            />
          )}
        </div>
        <footer className={frame.footer}>
          <button
            ref={templateButton}
            type="button"
            className={frame.secondary}
            aria-haspopup="menu"
            aria-expanded={templateAt !== null}
            onClick={(event) => {
              if (templateAt) {
                setTemplateAt(null);
                return;
              }
              const at = event.currentTarget.getBoundingClientRect();
              setTemplateAt({ x: Math.round(at.left), y: Math.round(at.bottom + 4) });
            }}
          >
            Template
          </button>
          <span style={{ marginRight: 'auto' }} />
          <button type="button" className={frame.secondary} onClick={cancel}>
            Cancel
          </button>
          <button type="button" className={frame.primary} onClick={ok}>
            Ok
          </button>
        </footer>
        {templateAt && (
          <PopupMenu
            x={templateAt.x}
            y={templateAt.y}
            label="Template"
            anchor={templateButton.current}
            layer={TEMPLATE_MENU_LAYER}
            items={templateItems}
            onClose={() => setTemplateAt(null)}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}

/** An expression typed in Displacement, and whether it's been applied since it was typed. */
interface Expression {
  text: string;
  applied: boolean;
}

/**
 * Several drawings' Style: Line, Background and Text, each when any of them has one, a value they
 * differ in shown as a rainbow (see severalStyle.ts).
 */
function SeveralStyleTab({
  chosen,
  onChange,
}: {
  chosen: readonly Drawing[];
  onChange(drawings: readonly Drawing[]): void;
}) {
  const look = severalStyle(chosen);
  return (
    <>
      {look.line && (
        <div className={frame.row}>
          <span className={frame.label}>Line</span>
          <ColorField
            label="Line"
            color={look.line.color.value}
            mixed={look.line.color.mixed}
            onChange={(color) => onChange(withLineColor(chosen, color))}
            line={{
              width: look.line.width.value,
              lineStyle: look.line.lineStyle.value,
              onWidth: (width) => onChange(withLine(chosen, { width })),
              onStyle: (lineStyle) => onChange(withLine(chosen, { lineStyle })),
            }}
          />
        </div>
      )}
      {look.fill && (
        <CheckRow
          label="Background"
          checked={look.fill.on.value || look.fill.on.mixed}
          mixed={look.fill.on.mixed}
          onChecked={(on) => onChange(withFill(chosen, { on }))}
        >
          <ColorField
            label="Background"
            color={look.fill.color.value}
            mixed={look.fill.color.mixed}
            onChange={(color) => onChange(withFill(chosen, { color }))}
          />
        </CheckRow>
      )}
      {look.text && (
        <Row label="Text">
          <ColorField
            label="Text"
            color={look.text.value}
            mixed={look.text.mixed}
            onChange={(color) => onChange(withTextColor(chosen, color))}
          />
        </Row>
      )}
    </>
  );
}

/**
 * Displacement (TradingView's Help Center image, How to move multiple drawing objects at the same
 * time?): "Displacement (price, bar)", a price field ("e.g. /2") and a bar field ("e.g. +1"), and
 * its hint. Enter applies an expression to every drawing; Ok applies one typed and not applied
 * (ours, provisional §11).
 */
function DisplacementTab({
  shift,
  onShift,
  onApply,
}: {
  shift: Record<DisplacementAxis, Expression>;
  onShift(axis: DisplacementAxis, text: string): void;
  onApply(axis: DisplacementAxis): boolean;
}) {
  const field = (axis: DisplacementAxis, label: string, placeholder: string) => {
    const { text } = shift[axis];
    return (
      <input
        className={styles.displacementField}
        aria-label={label}
        placeholder={placeholder}
        value={text}
        aria-invalid={text.trim() !== '' && parseDisplacement(text, axis) === null}
        onChange={(event) => onShift(axis, event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          // Applied, the text stays chosen: Enter again moves them as far again.
          if (onApply(axis)) event.currentTarget.select();
        }}
      />
    );
  };
  return (
    <>
      <div className={frame.row}>
        <span className={frame.label}>Displacement (price, bar)</span>
        <div className={styles.displacement}>
          {field('price', 'Price displacement', 'e.g. /2')}
          {field('bar', 'Bar displacement', 'e.g. +1')}
        </div>
      </div>
      <p className={styles.hint}>
        Use special math signs to displace selected drawings: +,-,/,* for price and +,- for bar
        index.
      </p>
    </>
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
  onDrawing,
}: {
  drawing: Drawing;
  onStyle(change: Partial<DrawingStyle>): void;
  onDrawing(drawing: Drawing): void;
}) {
  const { style } = drawing;
  const options = TOOL_OPTIONS[drawing.tool];
  if (options.regression) return <RegressionStyle style={style} onStyle={onStyle} />;
  if (isPitchforkTool(drawing.tool)) {
    return <PitchforkStyle drawing={drawing} onStyle={onStyle} onDrawing={onDrawing} />;
  }
  if (drawing.tool === 'parallel-channel') {
    return <ParallelChannelStyle style={style} onStyle={onStyle} />;
  }
  if (options.extendMenu) return <AngledChannelStyle style={style} onStyle={onStyle} />;
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

interface LineLook {
  color: string;
  width: number;
  lineStyle: DrawingLineStyle;
}

/** A line's color, thickness and style in one swatch, as TradingView's rows have them. */
function LineSwatch({
  label,
  look,
  onLook,
}: {
  label: string;
  look: LineLook;
  onLook(change: Partial<LineLook>): void;
}) {
  return (
    <ColorField
      label={label}
      color={look.color}
      onChange={(color) => onLook({ color })}
      line={{
        width: look.width,
        lineStyle: look.lineStyle,
        onWidth: (width) => onLook({ width }),
        onStyle: (lineStyle) => onLook({ lineStyle }),
      }}
    />
  );
}

/** A row whose name has a checkbox before it, its controls on the right. */
function CheckRow({
  label,
  checked,
  mixed = false,
  onChecked,
  children,
}: {
  label: string;
  checked: boolean;
  /** Several drawings, some on and some off: the box half checked. */
  mixed?: boolean;
  onChecked(checked: boolean): void;
  children?: ReactNode;
}) {
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (box.current) box.current.indeterminate = mixed;
  }, [mixed]);
  return (
    <div className={frame.row}>
      <label className={frame.checkLabel}>
        <input
          ref={box}
          type="checkbox"
          className={frame.checkbox}
          checked={checked}
          onChange={(event) => onChecked(event.target.checked)}
        />
        {label}
      </label>
      {children}
    </div>
  );
}

/**
 * A tool's levels: each on or off, its coefficient, and its line (TradingView's blog, Parallel
 * channel gets more levels: "coefficient, color, thickness, and line style"; Help Center, each
 * pitchfork's Levels).
 */
function LevelRows({
  levels,
  onLevels,
}: {
  levels: readonly DrawingLevel[];
  onLevels(levels: DrawingLevel[]): void;
}) {
  const set = (index: number, change: Partial<DrawingLevel>) =>
    onLevels(levels.map((level, i) => (i === index ? { ...level, ...change } : level)));
  return (
    <>
      <h3 className={frame.section}>Levels</h3>
      {levels
        .map((level, index) => ({ level, index, key: `level-${index + 1}` }))
        .map(({ level, index, key }) => (
          <div key={key} className={frame.row}>
            <span className={frame.checkLabel}>
              <input
                type="checkbox"
                className={frame.checkbox}
                aria-label={`Level ${index + 1}`}
                checked={level.visible}
                onChange={(event) => set(index, { visible: event.target.checked })}
              />
              <span className={styles.levelCoeff}>
                <NumberField
                  label={`Level ${index + 1} coefficient`}
                  value={level.coeff}
                  min={-MAX_LEVEL_COEFF}
                  max={MAX_LEVEL_COEFF}
                  onChange={(coeff) => set(index, { coeff })}
                />
              </span>
            </span>
            <LineSwatch
              label={`Level ${index + 1}`}
              look={level}
              onLook={(change) => set(index, change)}
            />
          </div>
        ))}
    </>
  );
}

/**
 * The Background row: on or off, and a color with its opacity (the channels), or an opacity
 * over the lines' own colors (the pitchforks: Help Center, "the slider beside adjusts its
 * opacity").
 */
function BackgroundRow({
  fill,
  opacityOnly,
  onFill,
}: {
  fill: DrawingFill;
  opacityOnly: boolean;
  onFill(fill: DrawingFill): void;
}) {
  const { hex, opacity } = splitColor(fill.color);
  const percent = Math.round(opacity * 100);
  return (
    <CheckRow label="Background" checked={fill.on} onChecked={(on) => onFill({ ...fill, on })}>
      {opacityOnly ? (
        <span className={styles.opacityControl}>
          <input
            type="range"
            className={styles.range}
            min={0}
            max={100}
            value={percent}
            aria-label="Background opacity"
            onChange={(event) =>
              onFill({ ...fill, color: joinColor(hex, Number(event.target.value) / 100) })
            }
          />
          <output className={styles.percent}>{percent}%</output>
        </span>
      ) : (
        <ColorField
          label="Background"
          color={fill.color}
          onChange={(color) => onFill({ ...fill, color })}
        />
      )}
    </CheckRow>
  );
}

/** A Parallel channel's Style: its lines, its levels, Extend, Background (Help Center). */
function ParallelChannelStyle({
  style,
  onStyle,
}: {
  style: DrawingStyle;
  onStyle(change: Partial<DrawingStyle>): void;
}) {
  return (
    <>
      <div className={frame.row}>
        <span className={frame.label}>Channel</span>
        <LineSwatch label="Channel" look={style} onLook={onStyle} />
      </div>
      <LevelRows levels={style.levels} onLevels={(levels) => onStyle({ levels })} />
      <h3 className={frame.section}>Extend</h3>
      <Check
        label="Extend left line"
        checked={style.extendLeft}
        onChange={(extendLeft) => onStyle({ extendLeft })}
      />
      <Check
        label="Extend right line"
        checked={style.extendRight}
        onChange={(extendRight) => onStyle({ extendRight })}
      />
      <BackgroundRow fill={style.fill} opacityOnly={false} onFill={(fill) => onStyle({ fill })} />
    </>
  );
}

/** Flat top/bottom's and Disjoint channel's Style: Line, its ends, Extend, Prices, Background. */
function AngledChannelStyle({
  style,
  onStyle,
}: {
  style: DrawingStyle;
  onStyle(change: Partial<DrawingStyle>): void;
}) {
  const extend =
    style.extendLeft && style.extendRight
      ? 'both'
      : style.extendLeft
        ? 'left'
        : style.extendRight
          ? 'right'
          : 'none';
  return (
    <>
      <div className={frame.row}>
        <span className={frame.label}>Line</span>
        <LineSwatch label="Line" look={style} onLook={onStyle} />
      </div>
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
      <Row label="Extend">
        <Dropdown
          label="Extend"
          value={extend}
          options={EXTENDS.map((item) => ({ value: item, label: EXTEND_NAMES[item] }))}
          onChange={(value) =>
            onStyle({
              extendLeft: value === 'left' || value === 'both',
              extendRight: value === 'right' || value === 'both',
            })
          }
        />
      </Row>
      <Check
        label="Prices"
        checked={style.showPriceLabels}
        onChange={(showPriceLabels) => onStyle({ showPriceLabels })}
      />
      <BackgroundRow fill={style.fill} opacityOnly={false} onFill={(fill) => onStyle({ fill })} />
    </>
  );
}

/**
 * A pitchfork's Style (Help Center, each pitchfork): the Style drop-down switching it into
 * another kind on the same points, Extend lines, the Median, its Levels, Use one color, and the
 * Background's opacity.
 */
function PitchforkStyle({
  drawing,
  onStyle,
  onDrawing,
}: {
  drawing: Drawing;
  onStyle(change: Partial<DrawingStyle>): void;
  onDrawing(drawing: Drawing): void;
}) {
  const { style } = drawing;
  return (
    <>
      <Row label="Style">
        <Dropdown
          label="Pitchfork style"
          value={drawing.tool}
          options={PITCHFORK_TOOLS.map((tool) => ({ value: tool, label: PITCHFORK_NAMES[tool] }))}
          onChange={(value) => {
            if (isPitchforkTool(value)) onDrawing({ ...drawing, tool: value });
          }}
        />
      </Row>
      <Check
        label="Extend lines"
        checked={style.extendLines}
        onChange={(extendLines) => onStyle({ extendLines })}
      />
      <CheckRow
        label="Median"
        checked={style.lineVisible}
        onChecked={(lineVisible) => onStyle({ lineVisible })}
      >
        <LineSwatch label="Median" look={style} onLook={onStyle} />
      </CheckRow>
      <LevelRows levels={style.levels} onLevels={(levels) => onStyle({ levels })} />
      <div className={frame.row}>
        <span className={frame.label}>Use one color</span>
        <ColorField
          label="Use one color"
          color={style.color}
          onChange={(color) =>
            onStyle({ color, levels: style.levels.map((level) => ({ ...level, color })) })
          }
        />
      </div>
      <BackgroundRow fill={style.fill} opacityOnly onFill={(fill) => onStyle({ fill })} />
    </>
  );
}

/** A Regression trend's Style (Help Center): Base, Up, Down, Extend lines, Pearson's R. */
function RegressionStyle({
  style,
  onStyle,
}: {
  style: DrawingStyle;
  onStyle(change: Partial<DrawingStyle>): void;
}) {
  const { regression } = style;
  const setLine = (which: 'up' | 'down', change: Partial<RegressionSettings['up']>) =>
    onStyle({ regression: { ...regression, [which]: { ...regression[which], ...change } } });
  return (
    <>
      <CheckRow
        label="Base"
        checked={style.lineVisible}
        onChecked={(lineVisible) => onStyle({ lineVisible })}
      >
        <LineSwatch label="Base" look={style} onLook={onStyle} />
      </CheckRow>
      <CheckRow
        label="Up"
        checked={regression.up.visible}
        onChecked={(visible) => setLine('up', { visible })}
      >
        <LineSwatch label="Up" look={regression.up} onLook={(change) => setLine('up', change)} />
      </CheckRow>
      <CheckRow
        label="Down"
        checked={regression.down.visible}
        onChecked={(visible) => setLine('down', { visible })}
      >
        <LineSwatch
          label="Down"
          look={regression.down}
          onLook={(change) => setLine('down', change)}
        />
      </CheckRow>
      <Check
        label="Extend lines"
        checked={style.extendLines}
        onChange={(extendLines) => onStyle({ extendLines })}
      />
      <Check
        label="Pearson's R"
        checked={regression.showPearsons}
        onChange={(showPearsons) => onStyle({ regression: { ...regression, showPearsons } })}
      />
    </>
  );
}

/**
 * A Regression trend's Inputs (Help Center): its deviations, each used or not, and its source.
 */
function InputsTab({
  settings,
  onSettings,
}: {
  settings: RegressionSettings;
  onSettings(change: Partial<RegressionSettings>): void;
}) {
  return (
    <>
      <CheckRow
        label="Upper deviation"
        checked={settings.useUpperDeviation}
        onChecked={(useUpperDeviation) => onSettings({ useUpperDeviation })}
      >
        <div className={frame.control}>
          <NumberField
            label="Upper deviation"
            value={settings.upperDeviation}
            min={-MAX_DEVIATION}
            max={MAX_DEVIATION}
            onChange={(upperDeviation) => onSettings({ upperDeviation })}
          />
        </div>
      </CheckRow>
      <CheckRow
        label="Lower deviation"
        checked={settings.useLowerDeviation}
        onChecked={(useLowerDeviation) => onSettings({ useLowerDeviation })}
      >
        <div className={frame.control}>
          <NumberField
            label="Lower deviation"
            value={settings.lowerDeviation}
            min={-MAX_DEVIATION}
            max={MAX_DEVIATION}
            onChange={(lowerDeviation) => onSettings({ lowerDeviation })}
          />
        </div>
      </CheckRow>
      <Row label="Source">
        <Dropdown
          label="Source"
          value={settings.source}
          options={PRICE_SOURCES.map((source) => ({ value: source, label: source }))}
          onChange={(value) => onSettings({ source: value as PriceSource })}
        />
      </Row>
    </>
  );
}

function TextTab({
  text,
  channel,
  onText,
}: {
  text: DrawingText;
  /** A channel's: over it, inside it or under it. */
  channel: boolean;
  onText(change: Partial<DrawingText>): void;
}) {
  const verticalNames = channel ? CHANNEL_V_NAMES : ALIGN_V_NAMES;
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
          options={V_ALIGNS.map((align) => ({ value: align, label: verticalNames[align] }))}
          onChange={(value) => onText({ alignV: value as VAlign })}
        />
      </Row>
    </>
  );
}

/**
 * Each point's price and bar (TradingView's Coordinates tab: "price and bar number"); bars
 * counted from the first loaded. A horizontal line has only a price, a vertical line only a bar,
 * a regression trend only bars (its prices come from them). A parallel channel's third point is
 * its Price offset from the first (Help Center, Parallel channel); a flat top/bottom's and a
 * disjoint channel's third only a price, at the second point's bar.
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
  const { tool, points } = drawing;
  const parallel = tool === 'parallel-channel';
  const angled = tool === 'flat-top-bottom' || tool === 'disjoint-channel';
  const priced = tool !== 'vertical-line' && tool !== 'regression-trend';
  const timed = (index: number) =>
    tool !== 'horizontal-line' && chart !== null && !(angled && index === 2);
  const setPoint = (index: number, change: { price?: number; bar?: number }) => {
    const next = points.map((point, i) => {
      if (i !== index) return point;
      return {
        price: change.price ?? point.price,
        time: change.bar !== undefined && chart ? chart.drawingTimeOf(change.bar) : point.time,
      };
    });
    onSet({ ...drawing, points: keptThird(tool, points, next) });
  };
  const [first, , third] = points;
  return (
    <>
      {(parallel ? points.slice(0, 2) : points)
        .map((point, index) => ({ point, index, key: `point-${index + 1}` }))
        .map(({ point, index, key }) => (
          <div key={key} className={frame.row}>
            <span className={frame.label}>{points.length > 1 ? `#${index + 1}` : 'Point'}</span>
            <div className={styles.coordinate}>
              {priced && (
                <NumberField
                  label={`Price ${index + 1}`}
                  value={point.price}
                  onChange={(price) => setPoint(index, { price })}
                />
              )}
              {timed(index) && chart && (
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
      {parallel && first && third && (
        <Row label="Price offset">
          <NumberField
            label="Price offset"
            value={third.price - first.price}
            onChange={(offset) =>
              onSet({
                ...drawing,
                points: points.map((point, i) =>
                  i === 2 ? { time: first.time, price: first.price + offset } : point,
                ),
              })
            }
          />
        </Row>
      )}
    </>
  );
}

/**
 * A channel's third point after its first two changed, as the chart keeps it: a parallel
 * channel's at its first point's bar, its price offset kept; a flat top/bottom's and disjoint
 * channel's at its second point's bar.
 */
function keptThird(
  tool: Drawing['tool'],
  before: readonly DrawingPoint[],
  after: DrawingPoint[],
): DrawingPoint[] {
  const [a, b, c] = after;
  const [a0, , c0] = before;
  if (!a || !b || !c) return after;
  if (tool === 'parallel-channel' && a0 && c0 && c === c0) {
    return [a, b, { time: a.time, price: a.price + (c0.price - a0.price) }];
  }
  if (tool === 'flat-top-bottom' || tool === 'disjoint-channel') {
    return [a, b, { time: b.time, price: c.price }];
  }
  return after;
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
