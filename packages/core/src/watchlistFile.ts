import type { SymbolId } from './market.ts';
import {
  MAX_SECTION_TITLE,
  MAX_WATCHLIST_SECTIONS,
  MAX_WATCHLIST_SYMBOLS,
  parseWatchlistSymbol,
  type Watchlist,
} from './watchlist.ts';

/**
 * TradingView's watchlist file, as its "Upload list…" reads and its "Export list" writes: a .txt
 * of items separated by commas, each "EXCHANGE:SYMBOL", where an item starting "###" begins a
 * section ("###CRYPTO ETFS,AMEX:GBTC,NASDAQ:IBIT,###USA SECTOR WISE 🇺🇸,…"). Its Charting
 * Library's lists use the same "###" items (docs/SPEC.md §12).
 */

const SECTION = '###';

export interface WatchlistFile {
  /** In order; symbols before the first "###" are in a first section with no title. */
  sections: { title: string; symbols: SymbolId[] }[];
  /** Items left out: repeats, and ones a list can't hold (no exchange prefix, …). */
  skipped: number;
  /** Symbols past TradingView's 1,000 a list, left out. */
  overLimit: number;
}

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** A title cut to the longest a section takes, without splitting a character (🇺🇸). */
function sectionTitle(text: string): string {
  let title = '';
  for (const { segment } of graphemes.segment(text.trim())) {
    if (title.length + segment.length > MAX_SECTION_TITLE) break;
    title += segment;
  }
  return title.trim();
}

/**
 * Reads a watchlist file. Items may also be one per line, as other tools write them; blank
 * items and a byte-order mark are ignored. Each symbol is kept once, in its first place.
 */
export function parseWatchlistFile(text: string): WatchlistFile {
  const sections: WatchlistFile['sections'] = [];
  const seen = new Set<SymbolId>();
  let skipped = 0;
  let overLimit = 0;
  let count = 0;
  for (const raw of text.replace(/^﻿/, '').split(/[,\r\n]+/)) {
    const item = raw.trim();
    if (item === '') continue;
    if (item.startsWith(SECTION)) {
      // Past the section limit, the rest stay in the last section.
      if (sections.length < MAX_WATCHLIST_SECTIONS) {
        sections.push({ title: sectionTitle(item.slice(SECTION.length)), symbols: [] });
      }
      continue;
    }
    const symbol = parseWatchlistSymbol(item);
    if (!symbol || seen.has(symbol)) {
      skipped++;
      continue;
    }
    if (count >= MAX_WATCHLIST_SYMBOLS) {
      overLimit++;
      continue;
    }
    seen.add(symbol);
    count++;
    let section = sections.at(-1);
    if (!section) {
      section = { title: '', symbols: [] };
      sections.push(section);
    }
    section.symbols.push(symbol);
  }
  return { sections, skipped, overLimit };
}

/** A watchlist as TradingView writes its file: one line, sections as "###" items. */
export function formatWatchlistFile(list: Watchlist): string {
  const items: string[] = [];
  list.sections.forEach((section, index) => {
    // Symbols above the first section have no header of their own.
    if (index > 0 || section.title !== '') items.push(`${SECTION}${section.title}`);
    items.push(...section.symbols);
  });
  return items.join(',');
}

/** The sections of a file as a watchlist's, with new ids. */
export function watchlistFromFile(file: WatchlistFile): Watchlist {
  return {
    sections: file.sections.map((section, index) => ({
      id: `s${index + 1}`,
      title: section.title,
      collapsed: false,
      symbols: [...section.symbols],
    })),
  };
}

/** The symbols in a file. */
export const fileSymbolCount = (file: WatchlistFile) =>
  file.sections.reduce((sum, section) => sum + section.symbols.length, 0);

/** A file name for a list: its name without characters file systems refuse, and ".txt". */
export function watchlistFileName(name: string): string {
  const safe = [...name]
    .map((character) => (character < ' ' || '\\/:*?"<>|'.includes(character) ? ' ' : character))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return `${safe || 'Watchlist'}.txt`;
}
