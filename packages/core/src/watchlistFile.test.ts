import { describe, expect, it } from 'vitest';
import { MAX_WATCHLIST_SYMBOLS } from './watchlist.ts';
import {
  fileSymbolCount,
  formatWatchlistFile,
  parseWatchlistFile,
  watchlistFileName,
  watchlistFromFile,
} from './watchlistFile.ts';

/** A list exported by TradingView (the user's, 2026-10-24). */
const TRADINGVIEW_FILE =
  '###MARKET CAP WISE,GLASSNODE:BTC_HASHRATE,CRYPTOCAP:TOTAL2/BITSTAMP:XRPUSD,CRYPTOCAP:SUI,' +
  'CRYPTOCAP:HBAR,CRYPTOCAP:LUNC,CRYPTOCAP:BTC.D,CRYPTOCAP:ETH.D,CRYPTOCAP:USDT.D,CRYPTOCAP:XRP.D,' +
  'BITSTAMP:USDTUSD,BYBIT:SNTUSDT.P,BINANCE:VETUSDT,BINANCE:SHIBUSDT,BINANCE:PEPEUSDT,' +
  '###CRYPTO ETFS,AMEX:GBTC,AMEX:XXRP,AMEX:ETHE,OTC:LTCN,NASDAQ:HYPG,AMEX:GSOL,OTC:FILG,OTC:BCHG,' +
  'OTC:GBAT,OTC:MANA,AMEX:SBIT,NASDAQ:ETHA,NASDAQ:IBIT,NASDAQ:THYP,NYSE:STWD,OTC:NTDOY,NASDAQ:CSX,' +
  'NYSE:IRM,NYSE:SUI,AMEX:AVUV,NASDAQ:NTES,AMEX:IJS,NYSE:DLR,NYSE:AMT,NASDAQ:HGX,NASDAQ:GSOX,' +
  'NASDAQ:GSOXNR,NASDAQ:GSOXTR,###USA SECTOR WISE 🇺🇸,CBOE:SIXT,CBOE:SIXRE,CBOE:SIXC,CBOE:SIXM,' +
  'CBOE:SIXU,CBOE:SIXR,CBOE:SIXB,CBOE:SIXE,CBOE:SIXI,CBOE:SIXV,CBOE:SIXY,###USA PRIVATE CREDIT';

describe("TradingView's watchlist file", () => {
  it('reads sections and every symbol, those we chart and those we only keep', () => {
    const file = parseWatchlistFile(TRADINGVIEW_FILE);
    expect(file.sections.map((s) => [s.title, s.symbols.length])).toEqual([
      ['MARKET CAP WISE', 14],
      ['CRYPTO ETFS', 28],
      ['USA SECTOR WISE 🇺🇸', 11],
      ['USA PRIVATE CREDIT', 0],
    ]);
    expect(fileSymbolCount(file)).toBe(53);
    expect(file.sections[0]?.symbols.slice(0, 3)).toEqual([
      'GLASSNODE:BTC_HASHRATE',
      'CRYPTOCAP:TOTAL2/BITSTAMP:XRPUSD',
      'CRYPTOCAP:SUI',
    ]);
    expect(file.skipped).toBe(0);
  });

  it('writes a list back exactly as TradingView wrote it', () => {
    const list = watchlistFromFile(parseWatchlistFile(TRADINGVIEW_FILE));
    expect(formatWatchlistFile(list)).toBe(TRADINGVIEW_FILE);
  });

  it('takes one item a line too, with a byte-order mark and blank lines', () => {
    const file = parseWatchlistFile('﻿NASDAQ:AAPL\r\n\r\n###Crypto\nbinance:xrpusdt\n');
    expect(file.sections).toEqual([
      { title: '', symbols: ['NASDAQ:AAPL'] },
      { title: 'Crypto', symbols: ['BINANCE:XRPUSDT'] },
    ]);
    // Symbols above the first section have no "###" of their own.
    expect(formatWatchlistFile(watchlistFromFile(file))).toBe(
      'NASDAQ:AAPL,###Crypto,BINANCE:XRPUSDT',
    );
  });

  it('keeps each symbol once and leaves out what a list cannot hold', () => {
    const file = parseWatchlistFile('NASDAQ:AAPL,AAPL,nasdaq:aapl,  ,###,BINANCE:XRPUSDT');
    expect(file.sections).toEqual([
      { title: '', symbols: ['NASDAQ:AAPL'] },
      { title: '', symbols: ['BINANCE:XRPUSDT'] },
    ]);
    expect(file.skipped).toBe(2); // "AAPL" has no exchange; the second AAPL is a repeat
  });

  it("stops at TradingView's 1,000 symbols", () => {
    const many = Array.from({ length: MAX_WATCHLIST_SYMBOLS + 5 }, (_, i) => `BINANCE:C${i}USDT`);
    const file = parseWatchlistFile(many.join(','));
    expect(fileSymbolCount(file)).toBe(MAX_WATCHLIST_SYMBOLS);
    expect(file.overLimit).toBe(5);
  });

  it('cuts a long section title without splitting a character', () => {
    const title = `${'A'.repeat(62)}🇺🇸`;
    const [section] = parseWatchlistFile(`###${title},NASDAQ:AAPL`).sections;
    expect(section?.title).toBe('A'.repeat(62));
  });

  it("names the file after the list, without characters a file name can't have", () => {
    expect(watchlistFileName('USA / Tech: big 5')).toBe('USA Tech big 5.txt');
    expect(watchlistFileName('   ')).toBe('Watchlist.txt');
  });
});
