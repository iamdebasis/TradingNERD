"""TOTAL2/XRPUSD's weekly highs against TradingView's, year by year (docs/HANDOVER.md, M9f).

TradingView's are read off docs/reference/tv-total2-xrpusd-1w-2026-10-26.png, pixel column by
pixel column; ours, from a gateway, are drawn into the same columns (a column's value: the
highest high of the weeks it covers). The time scale's offset is fitted on a span where ours is
trusted. Read-only: GET requests only.

    python3 -I tools/accuracy/total2_xrpusd.py http://127.0.0.1:5191 [--detail]
"""
import json
import os
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from statistics import median

sys.dont_write_bytecode = True  # no __pycache__ left in the repo
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from shot import Shot, is_green, is_red  # noqa: E402

REFERENCE = os.path.join(os.path.dirname(__file__), '..', '..', 'docs', 'reference', 'tv-total2-xrpusd-1w-2026-10-26.png')
# The price grid, measured on the screenshot: TradingView's lines every 100B, 2.6T at the top
# and -100B at the bottom (42.25 px apart; its last price, 810.51B, reads 811.8B).
GRID = [69, 112, 154, 196, 238, 281, 323, 365, 407, 450, 492, 534, 576, 619, 661, 703, 745, 787, 830, 872, 914, 956, 999, 1041, 1083, 1125, 1168, 1210]
# Rows of the red last-price line, which isn't a candle.
MASK = {824, 825, 826}
# The year labels' centres (x): 2015's and 2027's, each at its 1 January.
X2015, X2027 = 770.5, 1719.0
# Where ours is trusted (our own CoinGecko history, within 0.5% of TradingView's): the offset is fitted there.
FIT = ('2025-11', '2026-10')


def value_scale():
    n = len(GRID)
    values = [(26 - k) * 100e9 for k in range(n)]
    mx, mv = sum(GRID) / n, sum(values) / n
    slope = sum((g - mx) * (v - mv) for g, v in zip(GRID, values)) / sum((g - mx) ** 2 for g in GRID)
    return lambda y: mv + slope * (y - mx)


def tradingview_columns():
    shot, value = Shot(REFERENCE), value_scale()
    columns = {}
    for x in range(700, 1720):
        for y in range(60, 1240):
            if y in MASK:
                continue
            c = shot.px(x, y)
            if is_red(c) or is_green(c):
                columns[x] = value(y)
                break
    return columns


def our_weeks(base):
    bars, to = [], None
    while True:
        params = {'symbol': 'CRYPTOCAP:TOTAL2/BITSTAMP:XRPUSD', 'resolution': '1W', 'countBack': 5000}
        if to is not None:
            params['to'] = to
        with urllib.request.urlopen(f'{base}/api/bars?{urllib.parse.urlencode(params)}', timeout=600) as r:
            page = json.load(r)
        bars = page['bars'] + bars
        if not page['hasMore'] or not page['bars']:
            return bars
        to = page['bars'][0]['time']


def main():
    base = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:5180'
    detail = '--detail' in sys.argv
    d2015 = datetime(2015, 1, 1, tzinfo=timezone.utc).timestamp() / 86400
    d2027 = datetime(2027, 1, 1, tzinfo=timezone.utc).timestamp() / 86400
    per_day = (X2027 - X2015) / (d2027 - d2015)
    tv = tradingview_columns()
    weeks = our_weeks(base)

    def ours(shift):
        cols = {}
        for bar in weeks:
            d0 = bar['time'] / 86400 + shift
            for x in range(int(X2015 + (d0 - d2015) * per_day), int(X2015 + (d0 + 7 - d2015) * per_day) + 1):
                cols[x] = max(cols.get(x, 0), bar['high'])
        return cols

    def month(x, shift):
        return datetime.fromtimestamp((d2015 + (x - X2015) / per_day - shift) * 86400, timezone.utc).strftime('%Y-%m')

    def errors(shift, lo, hi):
        mine = ours(shift)
        return [(month(x, shift), mine[x] / t - 1) for x, t in tv.items() if x in mine and t > 0 and lo <= month(x, shift) <= hi]

    fitted = min((median([abs(e) for _, e in errors(s, *FIT)]), s) for s in [i / 2 for i in range(-30, 31)])
    shift = fitted[1]
    print(f'time offset fitted on {FIT[0]}..{FIT[1]}: {shift:+.1f} days (median |difference| {100 * fitted[0]:.2f}%)')
    by_year = {}
    for k, e in errors(shift, '2016-12', '2099-12'):
        by_year.setdefault(k[:4], []).append(e)
    print('year  columns  median  (25th .. 75th)   ours against TradingView, weekly highs')
    for year, v in sorted(by_year.items()):
        v.sort()
        q = lambda p: v[int(p * (len(v) - 1))]  # noqa: E731
        print(f'{year}  {len(v):7}  {100 * median(v):+6.1f}%  ({100 * q(.25):+.1f} .. {100 * q(.75):+.1f})')
    if detail:
        by_month = {}
        for k, e in errors(shift, '2016-12', '2099-12'):
            by_month.setdefault(k, []).append(e)
        for k, v in sorted(by_month.items()):
            print(k, f'{100 * median(v):+.1f}%')


if __name__ == '__main__':
    main()
