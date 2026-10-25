import type { PriceFormat, Resolution } from '@tradingnerd/core';

/** TradingView prints negative numbers with a true minus sign, not a hyphen. */
const MINUS = '−';

/** Thousands, millions, billions and trillions. */
const UNITS = [
  { size: 1e3, suffix: 'K' },
  { size: 1e6, suffix: 'M' },
  { size: 1e9, suffix: 'B' },
  { size: 1e12, suffix: 'T' },
] as const;

/** "1.80" → "1.8", "142.00" → "142". */
const trimZeros = (text: string) => (text.includes('.') ? text.replace(/\.?0+$/, '') : text);

/** The digits of a formatted value, without its sign and unit. */
const digitsOf = (text: string) => Number(text.replace(/^−/, '').replace(/[KMBT]$/, ''));

/**
 * A value in thousands, millions, billions or trillions with at most two decimals, trailing
 * zeros dropped: "2.65T", "758.92B", "213.6B", "142M" (TradingView's market caps, measured from
 * the user's screenshots). The unit is the largest the value shows at least 1 of once rounded,
 * so 999.999M reads "1B".
 */
export function formatVolume(value: number): string {
  const size = Math.abs(value);
  let text = trimZeros(size.toFixed(2));
  for (const unit of UNITS) {
    const scaled = (size / unit.size).toFixed(2);
    if (Number(scaled) >= 1) text = `${trimZeros(scaled)}${unit.suffix}`;
  }
  return value < 0 && digitsOf(text) !== 0 ? `${MINUS}${text}` : text;
}

/** A price in the symbol's format: its decimals, or thousands to trillions for market caps. */
export function formatValue(value: number, precision: number, format?: PriceFormat): string {
  return format === 'volume' ? formatVolume(value) : formatPrice(value, precision);
}

/** A signed change in the symbol's format: "+0.0106", "−18.03B". */
export function formatSignedValue(value: number, precision: number, format?: PriceFormat): string {
  if (format !== 'volume') return formatSignedPrice(value, precision);
  const text = formatVolume(Math.abs(value));
  if (digitsOf(text) === 0) return text;
  return `${value < 0 ? MINUS : '+'}${text}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad2 = (n: number) => String(n).padStart(2, '0');

/** A price with the symbol's fixed number of decimals, e.g. 1.2955. */
export function formatPrice(value: number, precision: number): string {
  const text = Math.abs(value).toFixed(precision);
  return value < 0 && Number(text) !== 0 ? `${MINUS}${text}` : text;
}

/** A signed change: "+0.0106", "−0.0163", "0.0000". */
export function formatSignedPrice(value: number, precision: number): string {
  const text = Math.abs(value).toFixed(precision);
  if (Number(text) === 0) return text;
  return `${value < 0 ? MINUS : '+'}${text}`;
}

/** A signed percentage with two decimals: "+2.76%", "−1.24%", "0.00%". */
export function formatSignedPercent(value: number): string {
  return `${formatSignedPrice(value, 2)}%`;
}

/**
 * Crosshair time label on the time axis, all in UTC like TradingView's crypto charts:
 * "Thu 08 Dec '22" for daily and weekly bars, "Thu 08 Dec '22  14:35" intraday (with seconds
 * for second bars), and "Dec '22" for monthly bars.
 */
export function formatCrosshairTime(epochSeconds: number, resolution: Resolution): string {
  const date = new Date(epochSeconds * 1000);
  const year = `'${pad2(date.getUTCFullYear() % 100)}`;
  const month = MONTHS[date.getUTCMonth()] ?? '';
  if (resolution.unit === 'month') return `${month} ${year}`;
  const day = `${WEEKDAYS[date.getUTCDay()]} ${pad2(date.getUTCDate())} ${month} ${year}`;
  if (resolution.unit === 'day' || resolution.unit === 'week') return day;
  const clock = `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`;
  return resolution.unit === 'second' || resolution.unit === 'tick'
    ? `${day}  ${clock}:${pad2(date.getUTCSeconds())}`
    : `${day}  ${clock}`;
}

/** A tick bar's time on the time axis: its first trade's clock time, "16:09:54" (UTC). */
export function formatTickMark(epochMs: number): string {
  const date = new Date(epochMs);
  return `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`;
}

/**
 * Time left until the bar closes, as on TradingView's price label: "00:45" under an hour,
 * "07:50:06" under a day, "3d 07:50:06" beyond.
 */
export function formatCountdown(remainingMs: number): string {
  const total = Math.max(0, Math.floor(remainingMs / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  if (days > 0) return `${days}d ${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
  if (hours > 0) return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
  return `${pad2(minutes)}:${pad2(seconds)}`;
}
