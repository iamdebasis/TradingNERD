import { isSessionHours } from '@tradingnerd/core';
import { useSyncExternalStore } from 'react';
import { readJson, writeJson } from '../lib/storage';
import {
  type AlertCondition,
  type AlertDef,
  type AlertLogEntry,
  type AlertScript,
  type AlertStatus,
  type AlertTrigger,
  alertTitle,
  isPriceAlert,
  isPriceOperator,
  type PriceCondition,
} from './alertModel';

/** Where the alerts and their log are kept: this browser's storage, as the app's own settings. */
export const ALERTS_KEY = 'tn.alerts';
export const ALERTS_LOG_KEY = 'tn.alerts.log';
/** The log keeps the latest of these (provisional: TradingView's own length isn't documented). */
export const LOG_LIMIT = 500;
/** Pop-ups shown at once; older ones close as new ones come. */
export const TOAST_LIMIT = 5;

/** A pop-up for an alert that triggered (the dialog's "Show pop-up"). */
export interface AlertToast {
  id: string;
  alert: string;
  title: string;
  symbol: string;
  message: string;
  time: number;
}

export type AlertsTab = 'alerts' | 'log';

export interface AlertsState {
  alerts: readonly AlertDef[];
  /** Newest first. */
  log: readonly AlertLogEntry[];
  toasts: readonly AlertToast[];
  /** The Alerts panel's tab. */
  tab: AlertsTab;
  /** The Create Alert dialog: open, and the alert it edits (null: a new one). */
  dialog: { editing: string | null } | null;
  /** Why an alert can't run, by its id (its script's error, an unknown symbol): not kept. */
  errors: Readonly<Record<string, string>>;
}

/** An alert as made in the dialog, before it has an id. */
export type NewAlert = Omit<AlertDef, 'id' | 'status' | 'created'>;

const TRIGGERS: readonly AlertTrigger[] = ['once', 'bar', 'close', 'minute'];

/** A price alert's condition read back: a known operator and a finite value. */
function readPriceCondition(raw: Partial<PriceCondition>): PriceCondition | null {
  if (!isPriceOperator(raw.operator)) return null;
  if (typeof raw.value !== 'number' || !Number.isFinite(raw.value)) return null;
  const precision =
    typeof raw.precision === 'number' && Number.isInteger(raw.precision)
      ? Math.min(10, Math.max(0, raw.precision))
      : 2;
  return { kind: 'price', operator: raw.operator, value: raw.value, precision };
}

/** An alert read back from storage: only well-formed ones are kept. */
function readAlert(raw: unknown): AlertDef | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Partial<AlertDef>;
  const script = a.script as Partial<AlertScript> | null | undefined;
  const condition = a.condition as Partial<AlertCondition> | undefined;
  const kinds = ['calls', 'fills-calls', 'fills', 'calls-only', 'condition'];
  if (typeof a.id !== 'string' || typeof a.symbol !== 'string' || typeof a.interval !== 'string') {
    return null;
  }
  const common = {
    id: a.id,
    name: typeof a.name === 'string' ? a.name : '',
    symbol: a.symbol,
    interval: a.interval,
    message: typeof a.message === 'string' ? a.message : '',
    popup: a.popup !== false,
    sound: a.sound !== false,
    status:
      a.status === 'stopped' || a.status === 'triggered' ? a.status : ('active' as AlertStatus),
    created: typeof a.created === 'number' ? a.created : 0,
  };
  if (condition?.kind === 'price') {
    const price = readPriceCondition(condition as Partial<PriceCondition>);
    if (!price) return null;
    return {
      ...common,
      script: null,
      condition: price,
      trigger: a.trigger === 'every' ? 'every' : 'once',
      ...(isSessionHours(a.session) ? { session: a.session } : {}),
    };
  }
  if (
    !script ||
    typeof script.source !== 'string' ||
    !condition ||
    !kinds.includes(String(condition.kind))
  ) {
    return null;
  }
  return {
    ...common,
    script: {
      title: typeof script.title === 'string' ? script.title : 'Script',
      source: script.source,
      inputs: script.inputs && typeof script.inputs === 'object' ? script.inputs : {},
    },
    condition: condition as AlertCondition,
    trigger: TRIGGERS.includes(a.trigger as AlertTrigger) ? (a.trigger as AlertTrigger) : 'bar',
  };
}

function readLog(raw: unknown): AlertLogEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (e): e is AlertLogEntry =>
        !!e &&
        typeof e === 'object' &&
        typeof (e as AlertLogEntry).id === 'string' &&
        typeof (e as AlertLogEntry).message === 'string' &&
        typeof (e as AlertLogEntry).time === 'number',
    )
    .slice(0, LOG_LIMIT);
}

let counter = 0;
const newId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${(++counter).toString(36)}`;

/**
 * The alerts (the Alerts panel's list), their log, the pop-ups showing, and the Create Alert
 * dialog's state. The list and the log survive a reload; the runner (AlertRunner) reads the list
 * and reports here what triggered.
 */
export class AlertStore {
  private value: AlertsState;
  private readonly listeners = new Set<() => void>();
  private readonly persist: boolean;

  constructor(persist = true) {
    this.persist = persist;
    const stored = persist ? readJson(ALERTS_KEY) : null;
    this.value = {
      alerts: Array.isArray(stored)
        ? stored.map(readAlert).filter((a): a is AlertDef => a !== null)
        : [],
      log: persist ? readLog(readJson(ALERTS_LOG_KEY)) : [],
      toasts: [],
      tab: 'alerts',
      dialog: null,
      errors: {},
    };
  }

  get = (): AlertsState => this.value;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  find(id: string): AlertDef | undefined {
    return this.value.alerts.find((alert) => alert.id === id);
  }

  openDialog(editing: string | null = null): void {
    this.commit({ ...this.value, dialog: { editing } });
  }

  closeDialog(): void {
    if (this.value.dialog) this.commit({ ...this.value, dialog: null });
  }

  setTab(tab: AlertsTab): void {
    if (tab !== this.value.tab) this.commit({ ...this.value, tab });
  }

  create(alert: NewAlert, now = Date.now()): AlertDef {
    const made: AlertDef = { ...alert, id: newId('alert'), status: 'active', created: now };
    this.commitAlerts([...this.value.alerts, made]);
    return made;
  }

  /** An edited alert starts again, active, with its new settings. */
  update(id: string, alert: NewAlert): void {
    this.commitAlerts(
      this.value.alerts.map((a) => (a.id === id ? { ...a, ...alert, status: 'active' } : a)),
    );
  }

  remove(id: string): void {
    this.commitAlerts(this.value.alerts.filter((a) => a.id !== id));
  }

  stop(id: string): void {
    this.setStatus(id, 'stopped');
  }

  restart(id: string): void {
    this.setStatus(id, 'active');
  }

  /**
   * An alert triggered: a log entry, a pop-up when it asks for one, and "Only once" stops it
   * ("Stopped — Triggered"). Returns the log entry; a price alert's has no timeframe, as it
   * triggers regardless of the interval.
   */
  fire(alert: AlertDef, message: string, time: number): AlertLogEntry {
    const title = alertTitle(alert);
    const price = isPriceAlert(alert);
    const entry: AlertLogEntry = {
      id: newId('log'),
      alert: alert.id,
      name: title,
      symbol: alert.symbol,
      interval: price ? '' : alert.interval,
      message,
      time,
    };
    const log = [entry, ...this.value.log].slice(0, LOG_LIMIT);
    const toasts = alert.popup
      ? [
          ...this.value.toasts,
          { id: entry.id, alert: alert.id, title, symbol: alert.symbol, message, time },
        ].slice(-TOAST_LIMIT)
      : this.value.toasts;
    // alert() calls and order fills set no trigger of their own here.
    const once = (alert.condition.kind === 'condition' || price) && alert.trigger === 'once';
    const alerts = once
      ? this.value.alerts.map((a) =>
          a.id === alert.id ? { ...a, status: 'triggered' as const } : a,
        )
      : this.value.alerts;
    this.commit({ ...this.value, log, toasts, alerts });
    if (this.persist) {
      writeJson(ALERTS_LOG_KEY, log);
      if (once) writeJson(ALERTS_KEY, alerts);
    }
    return entry;
  }

  /** The runner's word on an alert: why it can't run, or null once it runs. */
  setError(id: string, message: string | null): void {
    const known = this.value.errors[id];
    if ((known ?? null) === message) return;
    const errors = { ...this.value.errors };
    if (message === null) delete errors[id];
    else errors[id] = message;
    this.commit({ ...this.value, errors });
  }

  dismissToast(id: string): void {
    this.commit({ ...this.value, toasts: this.value.toasts.filter((t) => t.id !== id) });
  }

  clearLog(): void {
    this.commit({ ...this.value, log: [] });
    if (this.persist) writeJson(ALERTS_LOG_KEY, []);
  }

  private setStatus(id: string, status: AlertDef['status']): void {
    this.commitAlerts(this.value.alerts.map((a) => (a.id === id ? { ...a, status } : a)));
  }

  private commitAlerts(alerts: readonly AlertDef[]): void {
    this.commit({ ...this.value, alerts });
    if (this.persist) writeJson(ALERTS_KEY, alerts);
  }

  private commit(next: AlertsState): void {
    this.value = next;
    for (const listener of this.listeners) listener();
  }
}

export const alertStore = new AlertStore();

export function useAlerts(): AlertsState {
  return useSyncExternalStore(alertStore.subscribe, alertStore.get, alertStore.get);
}
