import { symbolName } from '@tradingnerd/core';
import { compileCached } from '@tradingnerd/pine';
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { toChartTheme } from '../chart/chartTheme';
import { RequestLoader } from '../chart/requestLoader';
import { marketApi } from '../data/api';
import { useGateway } from '../data/GatewayContext';
import { librariesStore } from '../pine/librariesStore';
import { darkTheme } from '../theme/tokens';
import { CloseIcon } from '../toolbar/icons';
import { AlertRunner } from './AlertRunner';
import styles from './AlertToasts.module.css';
import { playAlertSound } from './alertSound';
import { alertStore, useAlerts } from './alertStore';
import { AlarmIcon } from './icons';

/** The chart's background, as scripts' chart.bg_color reads it in an alert's copy. */
const BACKGROUND = toChartTheme(darkTheme).background;

/**
 * Runs the alerts while the app is open (AlertRunner, with a request loader of its own on the
 * gateway), and shows their pop-ups. When one triggers: a log entry, a pop-up and a sound as its
 * notifications ask. Scripts that import libraries compile again when the libraries change.
 */
export function AlertsHost() {
  const gateway = useGateway();

  useEffect(() => {
    const runner = new AlertRunner({
      makeFeed: ({ onHistory, onLive }) =>
        new RequestLoader({
          api: marketApi,
          feed: gateway,
          background: BACKGROUND,
          onHistory,
          onLive,
        }),
      compile: (source) => compileCached(source, librariesStore.compileOptions()),
      onFire: (alert, message, time) => {
        alertStore.fire(alert, message, time);
        if (alert.sound) playAlertSound();
      },
      onError: (alert, message) => alertStore.setError(alert.id, message),
    });
    let alerts = alertStore.get().alerts;
    runner.setAlerts(alerts);
    const stopAlerts = alertStore.subscribe(() => {
      const next = alertStore.get().alerts;
      if (next === alerts) return;
      alerts = next;
      runner.setAlerts(alerts);
    });
    let revision = librariesStore.get().revision;
    const stopLibraries = librariesStore.subscribe(() => {
      const next = librariesStore.get().revision;
      if (next === revision) return;
      revision = next;
      runner.reset(alertStore.get().alerts);
    });
    return () => {
      stopAlerts();
      stopLibraries();
      runner.dispose();
    };
  }, [gateway]);

  return <AlertToasts />;
}

const timeOf = (ms: number) =>
  new Date(ms).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

/**
 * An alert's pop-up (the dialog's "Show pop-up"): which symbol, which alert, its message and when;
 * it stays until closed (provisional: TradingView's own pop-up isn't measured, §11).
 */
function AlertToasts() {
  const { toasts } = useAlerts();
  if (toasts.length === 0) return null;
  return createPortal(
    <section className={styles.toasts} aria-label="Alert notifications" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={styles.toast} role="status">
          <span className={styles.icon}>
            <AlarmIcon />
          </span>
          <div className={styles.body}>
            <div className={styles.title}>Alert on {symbolName(toast.symbol)}</div>
            <div className={styles.name}>{toast.title}</div>
            <div className={styles.message}>{toast.message}</div>
            <time className={styles.time} dateTime={new Date(toast.time).toISOString()}>
              {timeOf(toast.time)}
            </time>
          </div>
          <button
            type="button"
            className={styles.close}
            aria-label="Close notification"
            onClick={() => alertStore.dismissToast(toast.id)}
          >
            <CloseIcon />
          </button>
        </div>
      ))}
    </section>,
    document.body,
  );
}
