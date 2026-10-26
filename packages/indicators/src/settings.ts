import {
  type IndicatorDefinition,
  type InputSpec,
  type InputValue,
  isSourceName,
  type LineDash,
  type StyleValue,
} from './types.ts';

/** One instance's settings: its inputs and the look of each plot, level and fill by id. */
export interface IndicatorSettings {
  inputs: Record<string, InputValue>;
  styles: Record<string, StyleValue>;
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
  return { inputs, styles };
}

const isColor = (value: unknown): value is string =>
  typeof value === 'string' && /^#[0-9A-Fa-f]{6}$/.test(value);

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
    opacity:
      typeof v.opacity === 'number' && Number.isFinite(v.opacity)
        ? Math.min(1, Math.max(0, v.opacity))
        : base.opacity,
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
  return style;
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
  return { inputs, styles };
}
