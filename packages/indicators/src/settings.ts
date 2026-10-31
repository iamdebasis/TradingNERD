import {
  type IndicatorDefinition,
  type InputSpec,
  type InputValue,
  isSourceName,
  type LineDash,
  type StyleValue,
  type ValueFormat,
} from './types.ts';

/**
 * The Style tab's "Output values" (TradingView's Help Center, "I want to hide the values of
 * individual indicators"; docs/SPEC.md §5.15): the values' precision, and whether they show on
 * the price scale and in the legend (the status line). Its "Input values", whether the inputs
 * show in the legend, isn't in TradingView's docs: provisional (§11).
 */
export interface DisplaySettings {
  /** Decimals for the values; null for Default, the indicator's own (RSI's 2). */
  precision: number | null;
  /** "Labels on price scale" */
  priceLabels: boolean;
  /** "Values in status line" */
  statusValues: boolean;
  /** "Inputs in status line" */
  statusInputs: boolean;
}

/** The Precision menu's choices after Default (provisional until measured, §11). */
export const PRECISIONS = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const;

export const DEFAULT_DISPLAY: Readonly<DisplaySettings> = {
  precision: null,
  priceLabels: true,
  statusValues: true,
  statusInputs: true,
};

/**
 * One instance's settings: its inputs, the look of each plot, level and fill by id, and how its
 * values show.
 */
export interface IndicatorSettings {
  inputs: Record<string, InputValue>;
  styles: Record<string, StyleValue>;
  display: DisplaySettings;
}

/** An indicator's value format with the Style tab's Precision applied. */
export function displayFormat(format: ValueFormat, precision: number | null): ValueFormat {
  if (precision === null) return format;
  return format.kind === 'volume'
    ? { kind: 'volume', decimals: precision }
    : { kind: 'decimals', decimals: precision };
}

/** Everything that has a look, by id: plots, levels, then fills. */
export function styleSpecs(definition: IndicatorDefinition) {
  return [...definition.plots, ...definition.levels, ...definition.fills];
}

export function defaultSettings(definition: IndicatorDefinition): IndicatorSettings {
  const inputs: Record<string, InputValue> = {};
  for (const input of definition.inputs) inputs[input.id] = input.default;
  const styles: Record<string, StyleValue> = {};
  for (const spec of styleSpecs(definition)) styles[spec.id] = { ...spec.style };
  return { inputs, styles, display: { ...DEFAULT_DISPLAY } };
}

const isColor = (value: unknown): value is string =>
  typeof value === 'string' && /^#[0-9A-Fa-f]{6}$/.test(value);

const isOpacity = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const DASHES: readonly LineDash[] = ['solid', 'dashed', 'dotted'];

function sanitizeInput(spec: InputSpec, value: unknown): InputValue {
  switch (spec.kind) {
    case 'int': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return spec.default;
      return Math.min(spec.max, Math.max(spec.min, Math.round(value)));
    }
    case 'float': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return spec.default;
      return Math.min(spec.max, Math.max(spec.min, value));
    }
    case 'source':
      return isSourceName(value) ? value : spec.default;
    case 'select':
      return typeof value === 'string' && spec.options.includes(value) ? value : spec.default;
    case 'bool':
      return typeof value === 'boolean' ? value : spec.default;
  }
}

function sanitizeStyle(base: StyleValue, value: unknown): StyleValue {
  if (typeof value !== 'object' || value === null) return { ...base };
  const v = value as Record<string, unknown>;
  const style: StyleValue = {
    visible: typeof v.visible === 'boolean' ? v.visible : base.visible,
    color: isColor(v.color) ? v.color.toUpperCase() : base.color,
    opacity: isOpacity(v.opacity) ? Math.min(1, Math.max(0, v.opacity)) : base.opacity,
  };
  if (base.width !== undefined) {
    style.width =
      typeof v.width === 'number' && Number.isInteger(v.width) && v.width >= 1 && v.width <= 4
        ? v.width
        : base.width;
  }
  if (base.dash !== undefined) {
    style.dash = DASHES.includes(v.dash as LineDash) ? (v.dash as LineDash) : base.dash;
  }
  if (base.value !== undefined) {
    style.value = typeof v.value === 'number' && Number.isFinite(v.value) ? v.value : base.value;
  }
  if (base.fallingColor !== undefined) {
    style.fallingColor = isColor(v.fallingColor) ? v.fallingColor.toUpperCase() : base.fallingColor;
  }
  if (base.bottomColor !== undefined) {
    style.bottomColor = isColor(v.bottomColor) ? v.bottomColor.toUpperCase() : base.bottomColor;
  }
  if (base.bottomOpacity !== undefined) {
    style.bottomOpacity = isOpacity(v.bottomOpacity)
      ? Math.min(1, Math.max(0, v.bottomOpacity))
      : base.bottomOpacity;
  }
  return style;
}

function sanitizeDisplay(value: unknown): DisplaySettings {
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_DISPLAY };
  const v = value as Record<string, unknown>;
  const flag = (key: keyof DisplaySettings) =>
    typeof v[key] === 'boolean' ? (v[key] as boolean) : (DEFAULT_DISPLAY[key] as boolean);
  return {
    precision: PRECISIONS.includes(v.precision as (typeof PRECISIONS)[number])
      ? (v.precision as number)
      : null,
    priceLabels: flag('priceLabels'),
    statusValues: flag('statusValues'),
    statusInputs: flag('statusInputs'),
  };
}

/**
 * Settings from storage or an edit: anything missing, unknown or out of range falls back to
 * TradingView's default, so a damaged entry still gives a working indicator.
 */
export function sanitizeSettings(
  definition: IndicatorDefinition,
  value: unknown,
): IndicatorSettings {
  const raw = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const rawInputs =
    typeof raw.inputs === 'object' && raw.inputs !== null
      ? (raw.inputs as Record<string, unknown>)
      : {};
  const rawStyles =
    typeof raw.styles === 'object' && raw.styles !== null
      ? (raw.styles as Record<string, unknown>)
      : {};
  const inputs: Record<string, InputValue> = {};
  for (const spec of definition.inputs) inputs[spec.id] = sanitizeInput(spec, rawInputs[spec.id]);
  const styles: Record<string, StyleValue> = {};
  for (const spec of styleSpecs(definition)) {
    styles[spec.id] = sanitizeStyle(spec.style, rawStyles[spec.id]);
  }
  return { inputs, styles, display: sanitizeDisplay(raw.display) };
}
