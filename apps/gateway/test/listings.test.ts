import { describe, expect, it } from 'vitest';
import {
  cleanName,
  kindFromName,
  parseNasdaqListed,
  parseOtherListed,
} from '../src/stocks/listings.ts';
import { NASDAQ_LISTED, OTHER_LISTED } from './fixtures/usDirectory.ts';

describe("Nasdaq's own listings", () => {
  it('reads stocks, ETFs, warrants, units and rights, leaving out test issues', () => {
    const listings = parseNasdaqListed(NASDAQ_LISTED);
    expect(listings.map((l) => [l.ticker, l.root, l.kind, l.name])).toEqual([
      ['AAPL', 'AAPL', 'stock', 'Apple Inc.'],
      ['GOOGL', 'GOOGL', 'stock', 'Alphabet Inc. Class A'],
      ['IBIT', 'IBIT', 'etf', 'iShares Bitcoin Trust ETF'],
      ['QQQ', 'QQQ', 'etf', 'Invesco QQQ Trust, Series 1'],
      ['AACIW', 'AACI', 'warrant', 'Armada Acquisition Corp. III - Warrant'],
      ['AACIU', 'AACI', 'unit', 'Armada Acquisition Corp. III - Units'],
      ['AACPR', 'AACP', 'right', 'Apogee Acquisition Corp - Rights'],
    ]);
    expect(listings[0]).toMatchObject({ exchange: 'NASDAQ', venue: 'NASDAQ', dataSymbol: 'AAPL' });
  });

  it('refuses a file cut short', () => {
    expect(() => parseNasdaqListed(NASDAQ_LISTED.replace(/File Creation.*\n/, ''))).toThrow();
  });
});

describe("the other exchanges' listings", () => {
  it("writes tickers as TradingView does, under TradingView's exchange codes", () => {
    const unknown: string[] = [];
    const listings = parseOtherListed(OTHER_LISTED, (code) => unknown.push(code));
    expect(listings.map((l) => `${l.exchange}:${l.ticker}`)).toEqual([
      'NYSE:A',
      'NYSE:AAC/U',
      'NYSE:AAC/W',
      'NYSE:AIIA/R',
      'NYSE:BRK.B',
      'NYSE:CIG.C',
      'NYSE:DCOM/P',
      'AMEX:DOG',
      'TXSE:ET',
      'CBOE:FBTC',
      'NYSE:JPM/PD',
      'AMEX:SPY',
      'AMEX:UEC',
    ]);
    expect(unknown).toEqual(['Q']);
  });

  it('knows each kind, venue and data symbol', () => {
    const byTicker = new Map(parseOtherListed(OTHER_LISTED).map((l) => [l.ticker, l]));
    expect(byTicker.get('SPY')).toMatchObject({
      venue: 'NYSE Arca',
      kind: 'etf',
      dataSymbol: 'SPY',
    });
    expect(byTicker.get('UEC')).toMatchObject({ venue: 'NYSE American', kind: 'stock' });
    expect(byTicker.get('BRK.B')).toMatchObject({
      kind: 'stock',
      root: 'BRK',
      dataSymbol: 'BRK.B',
      name: 'Berkshire Hathaway Inc.',
    });
    expect(byTicker.get('CIG.C')).toMatchObject({ kind: 'dr' });
    expect(byTicker.get('JPM/PD')).toMatchObject({
      kind: 'preferred',
      root: 'JPM',
      dataSymbol: null,
    });
    expect(byTicker.get('AAC/W')).toMatchObject({ kind: 'warrant', dataSymbol: null });
    expect(byTicker.get('ET')).toMatchObject({ name: 'Energy Transfer LP', kind: 'stock' });
    expect(byTicker.get('FBTC')).toMatchObject({ venue: 'Cboe BZX', kind: 'etf' });
  });
});

describe('names and kinds', () => {
  it.each([
    ['Apple Inc. - Common Stock', 'Apple Inc.'],
    ['Alphabet Inc. - Class A Common Stock', 'Alphabet Inc. Class A'],
    ['Sunoco LP Common Units representing limited partner interests', 'Sunoco LP'],
    ['Berkshire Hathaway Inc. New Common Stock', 'Berkshire Hathaway Inc.'],
    [
      'Taiwan Semiconductor Manufacturing Company Ltd.',
      'Taiwan Semiconductor Manufacturing Company Ltd.',
    ],
    [
      'Alibaba Group Holding Limited American Depositary Shares each representing eight Ordinary share',
      'Alibaba Group Holding Limited',
    ],
    ['Comp En De Mn Cemig ADS American Depositary Receipts', 'Comp En De Mn Cemig'],
  ])('cleans %j', (name, cleaned) => {
    expect(cleanName(name)).toBe(cleaned);
  });

  it('keeps the full names of other securities, tidily spaced', () => {
    expect(cleanName('a 1/400th  interest in  Preferred Stock', 'preferred')).toBe(
      'a 1/400th interest in Preferred Stock',
    );
  });

  it.each([
    ['Armada Acquisition Corp. III - Warrant', 'warrant'],
    ['Apogee Acquisition Corp - Rights', 'right'],
    ['Bristol-Myers Squibb Company Celegne Contingent Value Rights', 'right'],
    ['Energy Transfer LP Common Units', 'stock'],
    ['Comp En De Mn Cemig ADS American Depositary Receipts', 'dr'],
    ['Affiliated Managers Group, Inc. 5.875% Junior Subordinated Notes due 2059', 'note'],
    ['Dime Commercial Bancshares, Inc. Preferred Stock, Series A', 'preferred'],
  ])('classifies %j', (name, kind) => {
    expect(kindFromName(name)).toBe(kind);
  });
});
