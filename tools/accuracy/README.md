# Accuracy ruler

Checks CRYPTOCAP's older history against TradingView's by reading the user's screenshot of TradingView's TOTAL2/XRPUSD weekly chart (`docs/reference/tv-total2-xrpusd-1w-2026-10-26.png`, cropped to the chart) pixel column by pixel column. It needs Python 3 (standard library only) and macOS's `sips`.

- `python3 -I tools/accuracy/total2_xrpusd.py <gateway URL> [--detail]`: ours against TradingView's, year by year (read-only).
- `tools/accuracy/check.sh`: the M9f accuracy test.
  - It starts a gateway of its own on 5191, on a copy of `data/` without `secrets.json` (no keys, so it downloads nothing).
  - It switches each coin's older days on (`CRYPTOCAP_OLDER_COINS=1`) and runs the ruler against it.
  - It stops the gateway after, and deletes the copy.

**Validated (26 October 2026)** on our own last year, which is within 0.5% of TradingView's: median −0.2%, half the columns between −0.3% and +0.1%.

**Baseline (M9e, Live Coin Watch's whole market):**

| 2018 | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 |
|---|---|---|---|---|---|---|---|
| +20.7% | +11.7% | +2.2% | +5.9% | +8.3% | +9.2% | +9.2% | +2.3% |

TradingView's own 2017 is incomplete, so it can't be compared.

**Calibration** (in `total2_xrpusd.py`):
- The price grid's rows: 42.25 px to 100B, 0 at row 1168.
- The year labels' centres: 2015 at x 770.5, 2027 at 1719.0.
- The red last-price line's rows are masked.

A new screenshot needs these measured again.
