import { parseResolution, resolutionLabel, type SymbolInfo, symbolName } from '@tradingnerd/core';
import { compileCached } from '@tradingnerd/pine';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { chartSettings } from '../chart/chartSettings';
import { Dropdown } from '../chart/Dropdown';
import { useGateway } from '../data/GatewayContext';
import { librariesStore } from '../pine/librariesStore';
import { CloseIcon } from '../toolbar/icons';
import styles from './AlertDialog.module.css';
import {
  type AlertCondition,
  type AlertDef,
  type AlertTrigger,
  conditionLabel,
  ORDER_FILL_MESSAGE,
  PRICE_OPERATORS,
  PRICE_TRIGGERS,
  type PriceCondition,
  type PriceOperator,
  priceAlertText,
  TRIGGERS,
  takesFills,
} from './alertModel';
import { type AlertSource, conditionKey, conditionOptions, conditionsOf } from './alertSources';
import { alertStore, type NewAlert } from './alertStore';

/** The Source drop-down's first choice: the symbol's own price (chart indicator ids are "rsi-2"). */
const PRICE_SOURCE = 'price';

/** The Message field's start for a condition (Pine docs, Alerts; provisional where undocumented). */
function messageFor(
  condition: AlertCondition,
  source: AlertSource | null,
  program?: readonly { message: string }[],
) {
  if (condition.kind === 'condition') {
    const message = program?.[condition.index]?.message ?? '';
    return message || condition.title;
  }
  return takesFills(condition) ? ORDER_FILL_MESSAGE : (source?.title ?? '');
}

/** The decimals a price is written with, when the symbol's own aren't known yet. */
function decimalsOf(price: number): number {
  const text = String(price);
  if (text.includes('e')) return 8;
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : Math.min(8, text.length - dot - 1);
}

const roundTo = (value: number, decimals: number) => Number(value.toFixed(decimals));

/**
 * TradingView's Create Alert dialog (Help Center: How to set up alerts, Learn how to configure
 * alerts, How to use price alerts, Alerts on alert() function). The Condition starts with what the
 * alert is on: the symbol's price, as TradingView's does, or a script on the chart. A price alert
 * takes an operator and a Value (the current price to start with) and triggers Only once or Every
 * time; an alert on a script takes the script's condition, and an alertcondition() alert its
 * trigger. Then the alert's name, its message, and how it notifies. An alert keeps the chart's
 * symbol and timeframe, and a copy of the script and its inputs; editing an alert changes those
 * settings, never its copy. The layout is provisional until measured (§11).
 */
export function CreateAlertDialog({
  symbol,
  interval,
  info,
  sources,
  editing,
  onClose,
}: {
  symbol: string;
  interval: string;
  /** The chart's symbol as resolved (its decimals, tick and hours), or null while it loads. */
  info: SymbolInfo | null;
  /** The chart's scripts that make alert events (alertSources). */
  sources: readonly AlertSource[];
  /** The alert edited; null for a new one. */
  editing: AlertDef | null;
  onClose(): void;
}) {
  const titleId = useId();
  const valueId = useId();
  const nameId = useId();
  const messageId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const gateway = useGateway();
  const editedPrice = editing?.condition.kind === 'price' ? editing.condition : null;
  const alertSymbol = editing?.symbol ?? symbol;
  // The chart's symbol details, when it's the alert's own symbol (an edited alert's may not be).
  const own = info?.id.toUpperCase() === alertSymbol.toUpperCase() ? info : null;

  // An edited alert on a script offers its own copy's conditions.
  const copy = useMemo(() => {
    if (!editing?.script) return null;
    const compiled = compileCached(editing.script.source, librariesStore.compileOptions());
    if (!compiled.ok) return null;
    return {
      conditions: conditionsOf(compiled.program),
      messages: compiled.program.alertConditions as readonly { message: string }[],
    };
  }, [editing]);
  const [sourceId, setSourceId] = useState(PRICE_SOURCE);
  const onPrice = editing ? editedPrice !== null : sourceId === PRICE_SOURCE;
  const source = editing || onPrice ? null : (sources.find((s) => s.id === sourceId) ?? null);
  const conditions = editing
    ? (copy?.conditions ?? [editing.condition])
    : (source?.conditions ?? []);
  const messages = useMemo(() => {
    if (editing) return copy?.messages;
    if (!source) return undefined;
    const compiled = compileCached(source.script.source, librariesStore.compileOptions());
    return compiled.ok
      ? (compiled.program.alertConditions as readonly { message: string }[])
      : undefined;
  }, [editing, copy, source]);
  const [key, setKey] = useState(() =>
    editing && !editedPrice ? conditionKey(editing.condition) : '',
  );
  const condition = onPrice
    ? null
    : (conditions.find((c) => conditionKey(c) === key) ?? conditions[0] ?? null);

  // A price alert's operator and value; the value starts at the current price.
  const [operator, setOperator] = useState<PriceOperator>(editedPrice?.operator ?? 'crossing');
  const [price, setPrice] = useState<number | null>(null);
  useEffect(() => {
    if (editing) return;
    return gateway.subscribeQuotes(symbol, {
      onQuote: (last) => setPrice((known) => known ?? last),
      onState: () => {},
      onError: () => {},
    });
  }, [gateway, symbol, editing]);
  const precision =
    editedPrice?.precision ?? own?.pricePrecision ?? (price === null ? 2 : decimalsOf(price));
  /** What was typed in Value; null while it shows the current price. */
  const [valueText, setValueText] = useState<string | null>(
    editedPrice ? editedPrice.value.toFixed(editedPrice.precision) : null,
  );
  const shownValue = valueText ?? (price === null ? '' : price.toFixed(precision));
  const value = Number(shownValue.trim().replace(',', '.'));
  const valueOk = shownValue.trim() !== '' && Number.isFinite(value);
  const priceCondition: PriceCondition | null = valueOk
    ? { kind: 'price', operator, value: roundTo(value, precision), precision }
    : null;

  const [trigger, setTrigger] = useState<AlertTrigger>(editing?.trigger ?? 'once');
  const [name, setName] = useState(editing?.name ?? '');
  /**
   * What was typed in Message; null while it follows the condition, as an edited price alert's
   * still does when its message is the condition's own text.
   */
  const [message, setMessage] = useState<string | null>(() => {
    if (!editing) return null;
    if (editedPrice && editing.message === priceAlertText(editing.symbol, editedPrice)) return null;
    return editing.message;
  });
  const [popup, setPopup] = useState(editing?.popup ?? true);
  const [sound, setSound] = useState(editing?.sound ?? true);
  const ticker = symbolName(alertSymbol);
  const shownInterval = editing?.interval ?? interval;
  const resolution = parseResolution(shownInterval);
  const ownText = priceCondition ? priceAlertText(alertSymbol, priceCondition) : '';
  const shownMessage =
    message ?? (onPrice ? ownText : condition ? messageFor(condition, source, messages) : '');

  const chooseCondition = (next: string) => {
    setKey(next);
    setMessage(null);
  };
  const chooseSource = (next: string) => {
    setSourceId(next);
    setMessage(null);
    const chosen = sources.find((s) => s.id === next);
    // Each kind has its own triggers; one the other lacks goes back to Only once.
    if (next === PRICE_SOURCE) {
      if (!PRICE_TRIGGERS.some((t) => t.value === trigger)) setTrigger('once');
      return;
    }
    if (!TRIGGERS.some((t) => t.value === trigger)) setTrigger('once');
    const first = chosen?.conditions[0];
    if (first) setKey(conditionKey(first));
  };

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    dialog.current?.querySelector<HTMLElement>('button[aria-haspopup], input')?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      onCloseRef.current();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const callsOnly =
    condition !== null && (condition.kind === 'calls' || condition.kind === 'calls-only');
  const canSave = onPrice
    ? priceCondition !== null
    : condition !== null && (editing !== null || source !== null);

  const save = () => {
    const common = {
      name: name.trim(),
      symbol: alertSymbol,
      interval: shownInterval,
      popup,
      sound,
    };
    let alert: NewAlert;
    if (onPrice) {
      if (!priceCondition) return;
      // A stock's hours as its chart shows them; crypto trades around the clock.
      const session = editing
        ? editing.session
        : own?.schedule
          ? chartSettings.get().session
          : undefined;
      alert = {
        ...common,
        script: null,
        condition: priceCondition,
        trigger: trigger === 'every' ? 'every' : 'once',
        ...(session ? { session } : {}),
        message: shownMessage,
      };
    } else {
      const script = editing ? editing.script : source?.script;
      if (!condition || !script) return;
      alert = {
        ...common,
        script,
        condition,
        trigger,
        message: callsOnly ? '' : shownMessage,
      };
    }
    if (editing) alertStore.update(editing.id, alert);
    else alertStore.create(alert);
    onClose();
  };

  const sourceOptions = [
    { value: PRICE_SOURCE, label: symbolName(symbol) },
    ...sources.map((s) => ({ value: s.id, label: s.title })),
  ];
  const conditionText = onPrice
    ? ownText
    : condition
      ? `${editing?.script?.title ?? source?.title ?? ''}: ${conditionLabel(condition)}`
      : '';

  return createPortal(
    <div className={styles.backdrop}>
      <div
        ref={dialog}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className={styles.header}>
          <h2 id={titleId} className={styles.title}>
            {editing ? `Edit alert on ${ticker}` : `Create alert on ${ticker}`}
          </h2>
          <button type="button" className={styles.close} aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>
        <div className={styles.body}>
          <div className={styles.field}>
            <span className={styles.label}>Condition</span>
            <div className={styles.controls}>
              {editing ? (
                <div className={styles.fixed}>{editing.script?.title ?? ticker}</div>
              ) : (
                <Dropdown
                  label="Source"
                  value={sourceId}
                  options={sourceOptions}
                  onChange={chooseSource}
                />
              )}
              {onPrice ? (
                <Dropdown
                  label="Condition"
                  value={operator}
                  options={PRICE_OPERATORS}
                  onChange={(next) => setOperator(next as PriceOperator)}
                />
              ) : (
                <Dropdown
                  label="Condition"
                  value={condition ? conditionKey(condition) : ''}
                  options={conditionOptions(conditions)}
                  onChange={chooseCondition}
                />
              )}
            </div>
          </div>
          {onPrice ? (
            <div className={styles.field}>
              <label className={styles.label} htmlFor={valueId}>
                Value
              </label>
              <input
                id={valueId}
                className={styles.text}
                inputMode="decimal"
                autoComplete="off"
                spellCheck={false}
                value={shownValue}
                aria-invalid={!valueOk || undefined}
                onChange={(event) => setValueText(event.target.value)}
                onKeyDown={(event) => {
                  // The arrow keys step it by the symbol's tick, as a number field does.
                  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
                  if (!valueOk) return;
                  event.preventDefault();
                  const tick = own?.tickSize ?? 10 ** -precision;
                  const next = value + (event.key === 'ArrowUp' ? tick : -tick);
                  setValueText(next.toFixed(precision));
                }}
              />
            </div>
          ) : (
            <div className={styles.field}>
              <span className={styles.label}>Symbol</span>
              <div className={styles.fixed}>
                {ticker}
                {resolution ? `, ${resolutionLabel(resolution)}` : ''}
              </div>
            </div>
          )}
          <div className={styles.field}>
            <span className={styles.label}>Trigger</span>
            {onPrice || condition?.kind === 'condition' ? (
              <div className={styles.controls}>
                <Dropdown
                  label="Trigger"
                  value={trigger}
                  options={onPrice ? PRICE_TRIGGERS : TRIGGERS}
                  onChange={(next) => setTrigger(next as AlertTrigger)}
                />
              </div>
            ) : (
              <p className={styles.note}>
                {condition && takesFills(condition)
                  ? 'On each order fill, and as the script’s alert() calls set'
                  : 'As the script’s alert() calls set'}
              </p>
            )}
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={nameId}>
              Alert name
            </label>
            <input
              id={nameId}
              className={styles.text}
              value={name}
              placeholder={conditionText}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={messageId}>
              Message
            </label>
            {callsOnly ? (
              <p className={styles.note}>Each alert() call sends its own message</p>
            ) : (
              <textarea
                id={messageId}
                className={styles.textArea}
                rows={4}
                value={shownMessage}
                onChange={(event) => setMessage(event.target.value)}
              />
            )}
          </div>
          <fieldset className={styles.field}>
            <legend className={styles.label}>Notifications</legend>
            <div className={styles.checks}>
              <label className={styles.check}>
                <input
                  type="checkbox"
                  checked={popup}
                  onChange={(event) => setPopup(event.target.checked)}
                />
                Show pop-up
              </label>
              <label className={styles.check}>
                <input
                  type="checkbox"
                  checked={sound}
                  onChange={(event) => setSound(event.target.checked)}
                />
                Play sound
              </label>
            </div>
          </fieldset>
          <p className={styles.footnote}>
            {onPrice
              ? `Price alerts run in tradingNerd while it’s open, on ${ticker}’s live price whatever the chart shows.`
              : `Alerts run in tradingNerd while it’s open, on ${ticker}${
                  resolution ? ` ${resolutionLabel(resolution)}` : ''
                } whatever the chart shows.`}
          </p>
        </div>
        <footer className={styles.footer}>
          <button type="button" className={styles.secondary} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={styles.primary} disabled={!canSave} onClick={save}>
            {editing ? 'Save' : 'Create'}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
