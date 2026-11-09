import { parseResolution, resolutionLabel, symbolName } from '@tradingnerd/core';
import { compileCached } from '@tradingnerd/pine';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Dropdown } from '../chart/Dropdown';
import { librariesStore } from '../pine/librariesStore';
import { CloseIcon } from '../toolbar/icons';
import styles from './AlertDialog.module.css';
import {
  type AlertCondition,
  type AlertDef,
  type AlertTrigger,
  conditionLabel,
  ORDER_FILL_MESSAGE,
  TRIGGERS,
  takesFills,
} from './alertModel';
import { type AlertSource, conditionKey, conditionOptions, conditionsOf } from './alertSources';
import { alertStore, type NewAlert } from './alertStore';

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

/**
 * TradingView's Create Alert dialog for scripts (Help Center: How to set up alerts, Learn how to
 * configure alerts, Alerts on alert() function): the script and its condition, the trigger for an
 * alertcondition() alert, the alert's name, its message, and how it notifies. An alert keeps a
 * copy of the script and its inputs, and the chart's symbol and timeframe. Editing an alert
 * changes those settings, never its copy. The layout is provisional until measured (§11).
 */
export function CreateAlertDialog({
  symbol,
  interval,
  sources,
  editing,
  onClose,
}: {
  symbol: string;
  interval: string;
  /** The chart's scripts that make alert events (alertSources). */
  sources: readonly AlertSource[];
  /** The alert edited; null for a new one. */
  editing: AlertDef | null;
  onClose(): void;
}) {
  const titleId = useId();
  const nameId = useId();
  const messageId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  // An edited alert offers its own copy's conditions.
  const own = useMemo(() => {
    if (!editing) return null;
    const compiled = compileCached(editing.script.source, librariesStore.compileOptions());
    if (!compiled.ok) return null;
    return {
      conditions: conditionsOf(compiled.program),
      messages: compiled.program.alertConditions as readonly { message: string }[],
    };
  }, [editing]);
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? '');
  const source = editing ? null : (sources.find((s) => s.id === sourceId) ?? null);
  const conditions = editing
    ? (own?.conditions ?? [editing.condition])
    : (source?.conditions ?? []);
  const messages = useMemo(() => {
    if (editing) return own?.messages;
    if (!source) return undefined;
    const compiled = compileCached(source.script.source, librariesStore.compileOptions());
    return compiled.ok
      ? (compiled.program.alertConditions as readonly { message: string }[])
      : undefined;
  }, [editing, own, source]);
  const [key, setKey] = useState(() =>
    editing ? conditionKey(editing.condition) : conditionKey(conditions[0] ?? { kind: 'calls' }),
  );
  const condition = conditions.find((c) => conditionKey(c) === key) ?? conditions[0] ?? null;
  const [trigger, setTrigger] = useState<AlertTrigger>(editing?.trigger ?? 'once');
  const [name, setName] = useState(editing?.name ?? '');
  const [message, setMessage] = useState(() =>
    editing ? editing.message : condition ? messageFor(condition, source, messages) : '',
  );
  const [popup, setPopup] = useState(editing?.popup ?? true);
  const [sound, setSound] = useState(editing?.sound ?? true);
  const ticker = symbolName(editing?.symbol ?? symbol);
  const shownInterval = editing?.interval ?? interval;
  const resolution = parseResolution(shownInterval);

  const chooseCondition = (next: string) => {
    setKey(next);
    const chosen = conditions.find((c) => conditionKey(c) === next);
    if (chosen) setMessage(messageFor(chosen, source, messages));
  };
  const chooseSource = (next: string) => {
    setSourceId(next);
    const chosen = sources.find((s) => s.id === next);
    const first = chosen?.conditions[0];
    if (!chosen || !first) return;
    setKey(conditionKey(first));
    const compiled = compileCached(chosen.script.source, librariesStore.compileOptions());
    const list = compiled.ok
      ? (compiled.program.alertConditions as readonly { message: string }[])
      : [];
    setMessage(messageFor(first, chosen, list));
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
  const canSave = condition !== null && (editing !== null || source !== null);

  const save = () => {
    if (!condition) return;
    const script = editing ? editing.script : source?.script;
    if (!script) return;
    const alert: NewAlert = {
      name: name.trim(),
      symbol: editing?.symbol ?? symbol,
      interval: shownInterval,
      script,
      condition,
      trigger,
      message: callsOnly ? '' : message,
      popup,
      sound,
    };
    if (editing) alertStore.update(editing.id, alert);
    else alertStore.create(alert);
    onClose();
  };

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
          {conditions.length === 0 ? (
            <p className={styles.empty}>
              No script on the chart makes alert events. Add one that calls alert() or
              alertcondition(), or a strategy, to create an alert on it.
            </p>
          ) : (
            <>
              <div className={styles.field}>
                <span className={styles.label}>Condition</span>
                <div className={styles.controls}>
                  {editing ? (
                    <div className={styles.fixed}>{editing.script.title}</div>
                  ) : (
                    <Dropdown
                      label="Script"
                      value={sourceId}
                      options={sources.map((s) => ({ value: s.id, label: s.title }))}
                      onChange={chooseSource}
                    />
                  )}
                  <Dropdown
                    label="Condition"
                    value={condition ? conditionKey(condition) : ''}
                    options={conditionOptions(conditions)}
                    onChange={chooseCondition}
                  />
                </div>
              </div>
              <div className={styles.field}>
                <span className={styles.label}>Symbol</span>
                <div className={styles.fixed}>
                  {ticker}
                  {resolution ? `, ${resolutionLabel(resolution)}` : ''}
                </div>
              </div>
              <div className={styles.field}>
                <span className={styles.label}>Trigger</span>
                {condition?.kind === 'condition' ? (
                  <div className={styles.controls}>
                    <Dropdown
                      label="Trigger"
                      value={trigger}
                      options={TRIGGERS}
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
                  placeholder={
                    condition
                      ? `${editing?.script.title ?? source?.title ?? ''}: ${conditionLabel(condition)}`
                      : ''
                  }
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
                    value={message}
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
                Alerts run in tradingNerd while it’s open, on {ticker}
                {resolution ? ` ${resolutionLabel(resolution)}` : ''} whatever the chart shows.
              </p>
            </>
          )}
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
