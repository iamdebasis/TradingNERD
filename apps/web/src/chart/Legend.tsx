import { formatPrice, formatSignedPercent, formatSignedPrice } from '@tradingnerd/chart';
import { resolutionLabel } from '@tradingnerd/core';
import { type Ref, useImperativeHandle, useRef } from 'react';
import type { LegendView } from './ChartSession';
import styles from './Legend.module.css';

const setText = (element: HTMLElement | null, text: string) => {
  if (element && element.textContent !== text) element.textContent = text;
};

/**
 * The chart's top-left overlay: symbol title, live-data dot, OHLC of the hovered bar with its
 * change, and the Sell / spread / Buy quote. Updated imperatively by ChartSession, so cursor
 * moves and live ticks never re-render React.
 */
export function Legend({ ref }: { ref: Ref<LegendView> }) {
  const root = useRef<HTMLDivElement>(null);
  const logo = useRef<HTMLSpanElement>(null);
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
  const precision = useRef(2);

  useImperativeHandle(
    ref,
    (): LegendView => ({
      setInstrument(info, resolution) {
        precision.current = info.pricePrecision;
        setText(logo.current, info.base.charAt(0));
        setText(
          title.current,
          `${info.description} · ${resolutionLabel(resolution)} · ${info.exchangeName}`,
        );
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
        <span ref={logo} className={styles.logo} aria-hidden="true" />
        <span ref={title} className={styles.title} data-field="title" />
        <span className={styles.status} data-field="status" />
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
