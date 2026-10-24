import { formatPrice, formatSignedPercent, formatSignedPrice } from '@tradingnerd/chart';
import { type MarketStatus, resolutionLabel } from '@tradingnerd/core';
import { type Ref, useImperativeHandle, useRef, useState } from 'react';
import { CoinLogo } from '../logos/CoinLogo';
import type { LegendView } from './ChartSession';
import styles from './Legend.module.css';
import { MoonIcon, SunriseIcon } from './marketIcons';
import { MARKET_STATUS_NAMES } from './marketStatusNames';

const setText = (element: HTMLElement | null, text: string) => {
  if (element && element.textContent !== text) element.textContent = text;
};

/**
 * The chart's top-left overlay: symbol title, the market status and data pill, OHLC of the
 * hovered bar with its change, and the Sell / spread / Buy quote. Updated imperatively by
 * ChartSession, so cursor moves and live ticks never re-render React.
 */
export function Legend({ ref }: { ref: Ref<LegendView> }) {
  const root = useRef<HTMLDivElement>(null);
  // The symbol changes rarely, so its logo is rendered by React; everything else is imperative.
  const [coin, setCoin] = useState<{ id: string; base: string } | null>(null);
  const title = useRef<HTMLSpanElement>(null);
  const open = useRef<HTMLSpanElement>(null);
  const high = useRef<HTMLSpanElement>(null);
  const low = useRef<HTMLSpanElement>(null);
  const close = useRef<HTMLSpanElement>(null);
  const change = useRef<HTMLSpanElement>(null);
  const bid = useRef<HTMLSpanElement>(null);
  const ask = useRef<HTMLSpanElement>(null);
  const spread = useRef<HTMLSpanElement>(null);
  const message = useRef<HTMLDivElement>(null);
  const badges = useRef<HTMLSpanElement>(null);
  const market = useRef<HTMLSpanElement>(null);
  const delayed = useRef<HTMLSpanElement>(null);
  const precision = useRef(2);

  useImperativeHandle(
    ref,
    (): LegendView => ({
      setInstrument(info, resolution) {
        precision.current = info.pricePrecision;
        setCoin((current) =>
          current?.id === info.id ? current : { id: info.id, base: info.base },
        );
        setText(
          title.current,
          `${info.description} · ${resolutionLabel(resolution)} · ${info.exchangeName}`,
        );
        // TradingView's "Data is delayed" (D) sign, for symbols whose data runs behind.
        const minutes = Math.round(info.delayMs / 60_000);
        if (delayed.current) {
          delayed.current.hidden = info.delayMs <= 0;
          const text = `Data is delayed by ${minutes} minutes`;
          delayed.current.title = text;
          delayed.current.setAttribute('aria-label', text);
        }
        if (badges.current) badges.current.dataset.delayed = String(info.delayMs > 0);
      },
      setMarketStatus(status: MarketStatus) {
        if (badges.current) badges.current.dataset.market = status;
        if (market.current) {
          market.current.title = MARKET_STATUS_NAMES[status];
          market.current.setAttribute('aria-label', MARKET_STATUS_NAMES[status]);
        }
      },
      showBar(bar, previous) {
        const digits = precision.current;
        setText(open.current, formatPrice(bar.open, digits));
        setText(high.current, formatPrice(bar.high, digits));
        setText(low.current, formatPrice(bar.low, digits));
        setText(close.current, formatPrice(bar.close, digits));
        if (previous && previous.close !== 0) {
          const delta = bar.close - previous.close;
          const percent = (delta / previous.close) * 100;
          setText(
            change.current,
            `${formatSignedPrice(delta, digits)} (${formatSignedPercent(percent)})`,
          );
        } else {
          setText(change.current, '');
        }
        if (root.current) root.current.dataset.direction = bar.close >= bar.open ? 'up' : 'down';
      },
      setBook(bidPrice, askPrice) {
        const digits = precision.current;
        setText(bid.current, formatPrice(bidPrice, digits));
        setText(ask.current, formatPrice(askPrice, digits));
        setText(spread.current, formatPrice(askPrice - bidPrice, digits));
        if (root.current) root.current.dataset.book = 'true';
      },
      setStatus(status, text) {
        if (root.current) root.current.dataset.status = status;
        setText(message.current, status === 'error' ? (text ?? 'Something went wrong') : '');
      },
    }),
    [],
  );

  return (
    <div
      ref={root}
      className={styles.legend}
      data-status="loading"
      data-direction="up"
      data-book="false"
    >
      <div className={styles.titleRow}>
        {coin ? (
          <CoinLogo
            symbol={coin.id}
            base={coin.base}
            letter={coin.base.charAt(0)}
            className={styles.logo}
          />
        ) : (
          <span className={styles.logo} aria-hidden="true" />
        )}
        <span ref={title} className={styles.title} data-field="title" />
        {/* TradingView's pill: the market status icon, then the data's (D: delayed). */}
        <span
          ref={badges}
          className={styles.badges}
          data-field="status"
          data-market="open"
          data-delayed="false"
        >
          <span
            ref={market}
            className={styles.market}
            role="img"
            aria-label={MARKET_STATUS_NAMES.open}
            title={MARKET_STATUS_NAMES.open}
          >
            <SunriseIcon className={styles.sunrise} />
            <MoonIcon className={styles.moon} />
          </span>
          <span ref={delayed} className={styles.delayed} data-field="delayed" role="img" hidden>
            D
          </span>
        </span>
        <span className={styles.values}>
          <span className={styles.key}>O</span>
          <span ref={open} className={styles.value} data-field="open" />
          <span className={styles.key}>H</span>
          <span ref={high} className={styles.value} data-field="high" />
          <span className={styles.key}>L</span>
          <span ref={low} className={styles.value} data-field="low" />
          <span className={styles.key}>C</span>
          <span ref={close} className={styles.value} data-field="close" />
          <span ref={change} className={`${styles.value} ${styles.change}`} data-field="change" />
        </span>
      </div>
      <div ref={message} className={styles.message} data-field="message" />
      <div className={styles.tradeRow}>
        <div className={`${styles.trade} ${styles.sell}`} data-field="sell">
          <span ref={bid} className={styles.tradePrice} data-field="bid" />
          <span className={styles.tradeSide}>SELL</span>
        </div>
        <span ref={spread} className={styles.spread} data-field="spread" />
        <div className={`${styles.trade} ${styles.buy}`} data-field="buy">
          <span ref={ask} className={styles.tradePrice} data-field="ask" />
          <span className={styles.tradeSide}>BUY</span>
        </div>
      </div>
    </div>
  );
}
