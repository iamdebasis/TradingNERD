import { parseResolution, resolutionLabel, symbolName } from '@tradingnerd/core';
import { TrashIcon } from '../indicators/icons';
import { PauseIcon, ResumeIcon } from '../pine/icons';
import { CloseIcon, PlusIcon } from '../toolbar/icons';
import styles from './AlertsPanel.module.css';
import { type AlertDef, alertTitle, conditionLabel, isPriceAlert } from './alertModel';
import { alertStore, useAlerts } from './alertStore';
import { EditIcon } from './icons';

/**
 * An alert's symbol and timeframe as the list writes them: "BTCUSDT, 1h". A price alert's is the
 * symbol alone (no timeframe given), as it triggers regardless of the interval.
 */
export function alertPlace(symbol: string, interval: string): string {
  if (!interval) return symbolName(symbol);
  const resolution = parseResolution(interval);
  return `${symbolName(symbol)}, ${resolution ? resolutionLabel(resolution) : interval}`;
}

/** Its status as TradingView's alert manager labels it (Help Center, Manage alerts). */
const STATUS: Record<AlertDef['status'], string> = {
  active: 'Active',
  triggered: 'Stopped — Triggered',
  stopped: 'Stopped manually',
};

const timeOf = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

/**
 * TradingView's alert manager on the right (Help Center, Manage alerts): Create alert, then two
 * tabs, Alerts (each alert with its status, and stop or restart, edit, remove) and Log (each time
 * one triggered, newest first). Layout and colors are provisional until measured (§11).
 */
export function AlertsPanel({
  errors,
  onCreate,
  onClose,
}: {
  /** Why an alert can't run, by its id (its script's error, an unknown symbol). */
  errors: Readonly<Record<string, string>>;
  onCreate(): void;
  onClose(): void;
}) {
  const { alerts, log, tab } = useAlerts();
  return (
    <section className={styles.panel} aria-label="Alerts">
      <header className={styles.top}>
        <h2 className={styles.heading}>Alerts</h2>
        <span className={styles.spacer} />
        <button
          type="button"
          className={styles.iconButton}
          aria-label="Create alert"
          title="Create alert (Alt+A)"
          onClick={onCreate}
        >
          <PlusIcon />
        </button>
        <button
          type="button"
          className={styles.iconButton}
          aria-label="Close alerts"
          title="Close"
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </header>
      <div className={styles.tabs} role="tablist" aria-label="Alerts and log">
        <button
          type="button"
          role="tab"
          className={styles.tab}
          aria-selected={tab === 'alerts'}
          onClick={() => alertStore.setTab('alerts')}
        >
          Alerts
        </button>
        <button
          type="button"
          role="tab"
          className={styles.tab}
          aria-selected={tab === 'log'}
          onClick={() => alertStore.setTab('log')}
        >
          Log
        </button>
        {tab === 'log' && log.length > 0 && (
          <button type="button" className={styles.clear} onClick={() => alertStore.clearLog()}>
            Clear log
          </button>
        )}
      </div>
      {tab === 'alerts' ? (
        <ul className={styles.list} aria-label="Alert list">
          {alerts.length === 0 && (
            <li className={styles.empty}>
              No alerts yet. Create one on a symbol’s price, on a script with alert() or
              alertcondition() calls, or on a strategy.
            </li>
          )}
          {alerts.map((alert) => (
            <li key={alert.id} className={styles.row} data-status={alert.status}>
              <div className={styles.main}>
                <div className={styles.name}>{alertTitle(alert)}</div>
                <div className={styles.meta}>
                  {alertPlace(alert.symbol, isPriceAlert(alert) ? '' : alert.interval)} ·{' '}
                  {conditionLabel(alert.condition)}
                </div>
                <div className={styles.status} data-status={alert.status}>
                  {STATUS[alert.status]}
                </div>
                {errors[alert.id] && alert.status === 'active' && (
                  <div className={styles.error}>{errors[alert.id]}</div>
                )}
              </div>
              <div className={styles.actions}>
                {alert.status === 'active' ? (
                  <button
                    type="button"
                    className={styles.iconButton}
                    aria-label="Stop"
                    title="Stop"
                    onClick={() => alertStore.stop(alert.id)}
                  >
                    <PauseIcon />
                  </button>
                ) : (
                  <button
                    type="button"
                    className={styles.iconButton}
                    aria-label="Restart"
                    title="Restart"
                    onClick={() => alertStore.restart(alert.id)}
                  >
                    <ResumeIcon />
                  </button>
                )}
                <button
                  type="button"
                  className={styles.iconButton}
                  aria-label="Edit"
                  title="Edit"
                  onClick={() => alertStore.openDialog(alert.id)}
                >
                  <EditIcon />
                </button>
                <button
                  type="button"
                  className={styles.iconButton}
                  aria-label="Remove"
                  title="Remove"
                  onClick={() => alertStore.remove(alert.id)}
                >
                  <TrashIcon />
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <ul className={styles.list} aria-label="Alert log">
          {log.length === 0 && <li className={styles.empty}>No alerts have triggered yet.</li>}
          {log.map((entry) => (
            <li key={entry.id} className={styles.entry}>
              <div className={styles.entryTop}>
                <span className={styles.name}>{entry.name}</span>
                <time className={styles.time} dateTime={new Date(entry.time).toISOString()}>
                  {timeOf(entry.time)}
                </time>
              </div>
              <div className={styles.meta}>{alertPlace(entry.symbol, entry.interval)}</div>
              <div className={styles.message}>{entry.message}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
