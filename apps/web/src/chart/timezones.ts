import { timeZone } from '@tradingnerd/core';

/**
 * The time zones TradingView offers for a chart (its Charting Library's list, docs/SPEC.md
 * §12), besides "Exchange".
 */
export const TIMEZONES: readonly string[] = [
  'Etc/UTC',
  'Africa/Cairo',
  'Africa/Casablanca',
  'Africa/Johannesburg',
  'Africa/Lagos',
  'Africa/Nairobi',
  'Africa/Tunis',
  'America/Anchorage',
  'America/Argentina/Buenos_Aires',
  'America/Bogota',
  'America/Caracas',
  'America/Chicago',
  'America/El_Salvador',
  'America/Halifax',
  'America/Juneau',
  'America/Lima',
  'America/Los_Angeles',
  'America/Mexico_City',
  'America/New_York',
  'America/Phoenix',
  'America/Santiago',
  'America/Sao_Paulo',
  'America/Toronto',
  'America/Vancouver',
  'Asia/Astana',
  'Asia/Ashkhabad',
  'Asia/Bahrain',
  'Asia/Bangkok',
  'Asia/Chongqing',
  'Asia/Colombo',
  'Asia/Dhaka',
  'Asia/Dubai',
  'Asia/Ho_Chi_Minh',
  'Asia/Hong_Kong',
  'Asia/Jakarta',
  'Asia/Jerusalem',
  'Asia/Karachi',
  'Asia/Kabul',
  'Asia/Kathmandu',
  'Asia/Kolkata',
  'Asia/Kuala_Lumpur',
  'Asia/Kuwait',
  'Asia/Manila',
  'Asia/Muscat',
  'Asia/Nicosia',
  'Asia/Qatar',
  'Asia/Riyadh',
  'Asia/Seoul',
  'Asia/Shanghai',
  'Asia/Singapore',
  'Asia/Taipei',
  'Asia/Tehran',
  'Asia/Tokyo',
  'Asia/Yangon',
  'Atlantic/Azores',
  'Atlantic/Reykjavik',
  'Australia/Adelaide',
  'Australia/Brisbane',
  'Australia/Perth',
  'Australia/Sydney',
  'Europe/Amsterdam',
  'Europe/Athens',
  'Europe/Belgrade',
  'Europe/Berlin',
  'Europe/Bratislava',
  'Europe/Brussels',
  'Europe/Bucharest',
  'Europe/Budapest',
  'Europe/Copenhagen',
  'Europe/Dublin',
  'Europe/Helsinki',
  'Europe/Istanbul',
  'Europe/Lisbon',
  'Europe/Ljubljana',
  'Europe/London',
  'Europe/Luxembourg',
  'Europe/Madrid',
  'Europe/Malta',
  'Europe/Moscow',
  'Europe/Oslo',
  'Europe/Paris',
  'Europe/Prague',
  'Europe/Riga',
  'Europe/Rome',
  'Europe/Sofia',
  'Europe/Stockholm',
  'Europe/Tallinn',
  'Europe/Vienna',
  'Europe/Vilnius',
  'Europe/Warsaw',
  'Europe/Zagreb',
  'Europe/Zurich',
  'Pacific/Auckland',
  'Pacific/Chatham',
  'Pacific/Fakaofo',
  'Pacific/Honolulu',
  'Pacific/Norfolk',
  'US/Mountain',
];

const supported = new Set(TIMEZONES);

/** Zones TradingView names that the platform's time zone data knows by another name. */
const ALIASES: Readonly<Record<string, string>> = { 'Asia/Astana': 'Asia/Almaty' };

/** The platform's name for one of TradingView's zones, for Intl and the chart. */
export const intlZone = (zone: string): string => ALIASES[zone] ?? zone;

/** Whether `zone` is one TradingView offers (and this browser knows). */
export function isSupportedTimezone(zone: string): boolean {
  if (!supported.has(zone)) return false;
  try {
    timeZone(intlZone(zone));
    return true;
  } catch {
    return false;
  }
}

/** "+2", "-4", "+5:30": a UTC offset in minutes, as TradingView writes it. */
function offsetText(minutes: number): string {
  if (minutes === 0) return '';
  const sign = minutes < 0 ? '-' : '+';
  const hours = Math.floor(Math.abs(minutes) / 60);
  const rest = Math.abs(minutes) % 60;
  return `${sign}${hours}${rest ? `:${String(rest).padStart(2, '0')}` : ''}`;
}

/** The zone's offset from UTC at `ms`, in minutes. */
export function offsetMinutes(zone: string, ms: number): number {
  return Math.round(timeZone(intlZone(zone)).offset(ms) / 60_000);
}

/**
 * A zone as the time zone menu names it: "(UTC-4) New York", with the offset of the moment
 * (summer time included), and "UTC" for UTC. City names come from the zone's id
 * (provisional: TradingView may name a few differently, docs/SPEC.md §11).
 */
export function timezoneLabel(zone: string, ms: number): string {
  if (zone === 'Etc/UTC') return 'UTC';
  const city = (zone.split('/').at(-1) ?? zone).replaceAll('_', ' ');
  return `(UTC${offsetText(offsetMinutes(zone, ms))}) ${city}`;
}

/** The menu's zones: UTC first, then by offset at `ms`, west to east. */
export function timezoneMenu(ms: number): { zone: string; label: string }[] {
  const zones = TIMEZONES.filter((zone) => zone !== 'Etc/UTC' && isSupportedTimezone(zone));
  const sorted = zones
    .map((zone) => ({ zone, label: timezoneLabel(zone, ms), offset: offsetMinutes(zone, ms) }))
    .sort((a, b) => a.offset - b.offset || a.label.localeCompare(b.label));
  return [{ zone: 'Etc/UTC', label: 'UTC' }, ...sorted.map(({ zone, label }) => ({ zone, label }))];
}
