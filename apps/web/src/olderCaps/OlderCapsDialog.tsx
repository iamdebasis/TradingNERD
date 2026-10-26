import type { OlderCapsStatus } from '@tradingnerd/core';
import { type FormEvent, useCallback, useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError, type OlderCapsApi, olderCapsApi } from '../data/api';
import styles from '../logos/LogoDialog.module.css';
import { CloseIcon } from '../toolbar/icons';

/** Where Live Coin Watch hands out free API keys. */
export const LIVECOINWATCH_KEYS_URL = 'https://www.livecoinwatch.com/tools/api';
/** How often the download's progress is asked for while it runs. */
const POLL_MS = 1_000;

type Check = { kind: 'idle' } | { kind: 'checking' } | { kind: 'error'; message: string };

/** "1 May 2013" from "2013-05-01". */
const dayName = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

/** The download in a line, and how the status line shows it. */
function progressOf(status: OlderCapsStatus | null): { text: string; kind: string } {
  if (status?.state === 'error') {
    return { text: status.message ?? 'The download stopped', kind: 'error' };
  }
  if (status?.state === 'loading') {
    const percent = `${Math.floor(status.progress * 100)}%`;
    if (status.message) return { text: `${status.message} · ${percent}`, kind: 'idle' };
    const back = status.from ? ` · back to ${dayName(status.from)}` : '';
    return { text: `Downloading… ${percent}${back}`, kind: 'idle' };
  }
  if (status?.state === 'done' && status.from) {
    return { text: `✓ Daily from ${dayName(status.from)}`, kind: 'saved' };
  }
  return { text: ' ', kind: 'idle' };
}

/**
 * "Older market caps": the Live Coin Watch key that TOTAL, TOTAL2, TOTAL3 and BTC.D need for
 * the years before our own history (docs/SPEC.md §5.13), in the coin logo dialog's style. A
 * key is checked with Live Coin Watch before it is kept; the browser only ever sees it masked.
 * While the download runs, its progress is shown.
 */
export function OlderCapsDialog({
  api = olderCapsApi,
  onStatus,
  onClose,
}: {
  api?: OlderCapsApi;
  /** Told each status that comes in. */
  onStatus?(status: OlderCapsStatus): void;
  onClose(): void;
}) {
  const id = useId();
  const [status, setStatus] = useState<OlderCapsStatus | null>(null);
  const key = status?.key ?? null;
  const [replacing, setReplacing] = useState(false);
  const editing = status !== null && (key === null || replacing);
  const [value, setValue] = useState('');
  const [check, setCheck] = useState<Check>({ kind: 'idle' });

  const apply = useCallback(
    (next: OlderCapsStatus) => {
      setStatus(next);
      onStatus?.(next);
    },
    [onStatus],
  );

  useEffect(() => {
    let alive = true;
    api.status().then(
      (loaded) => {
        if (alive) apply(loaded);
      },
      (error: unknown) => {
        if (alive) {
          setCheck({
            kind: 'error',
            message: error instanceof ApiError ? error.message : 'The gateway could not be reached',
          });
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [api, apply]);

  // While the download runs, its progress.
  const loading = status?.state === 'loading';
  useEffect(() => {
    if (!loading) return;
    let alive = true;
    const timer = setInterval(() => {
      api.status().then(
        (next) => {
          if (alive) apply(next);
        },
        () => {
          // Asked again next time.
        },
      );
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [api, apply, loading]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const ready = value.trim() !== '' && check.kind !== 'checking';

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setCheck({ kind: 'checking' });
    try {
      apply(await api.saveKey(value));
      setValue('');
      setReplacing(false);
      setCheck({ kind: 'idle' });
    } catch (error) {
      setCheck({
        kind: 'error',
        message: error instanceof ApiError ? error.message : 'The key could not be checked',
      });
    }
  };

  const remove = async () => {
    try {
      apply(await api.removeKey());
      setReplacing(false);
      setCheck({ kind: 'idle' });
    } catch (error) {
      setCheck({ kind: 'error', message: error instanceof ApiError ? error.message : 'Failed' });
    }
  };

  const progress = progressOf(status);

  return createPortal(
    <div className={styles.backdrop}>
      <form
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        onSubmit={save}
      >
        <div className={styles.titleRow}>
          <h2 id={`${id}-title`} className={styles.title}>
            Older market caps
          </h2>
          <button type="button" className={styles.close} aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <p className={styles.text}>
          TOTAL, TOTAL2, TOTAL3 and BTC.D reach back to May 2013 with Live Coin Watch's market caps,
          which need a free Live Coin Watch API key. They're downloaded once, in about two hours,
          and kept on this computer, like the key.
        </p>

        {key && !editing && (
          <div className={styles.keyRow}>
            <span>
              API key <span className={styles.masked}>{key.masked}</span>
            </span>
            {key.source === 'env' ? (
              <span className={styles.note}>Set by LIVECOINWATCH_API_KEY</span>
            ) : (
              <span className={styles.keyActions}>
                <button
                  type="button"
                  className={styles.secondary}
                  onClick={() => setReplacing(true)}
                >
                  Replace
                </button>
                <button type="button" className={styles.secondary} onClick={() => void remove()}>
                  Remove
                </button>
              </span>
            )}
          </div>
        )}

        {editing && (
          <label className={styles.field}>
            <span className={styles.label}>API key</span>
            <input
              className={styles.input}
              type="password"
              autoComplete="off"
              spellCheck={false}
              // biome-ignore lint/a11y/noAutofocus: the dialog exists to paste this key
              autoFocus
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                if (check.kind === 'error') setCheck({ kind: 'idle' });
              }}
            />
          </label>
        )}

        <p
          className={styles.status}
          data-kind={check.kind === 'idle' ? progress.kind : check.kind}
          aria-live="polite"
        >
          {check.kind === 'checking' && 'Checking the key with Live Coin Watch…'}
          {check.kind === 'error' && check.message}
          {check.kind === 'idle' && progress.text}
        </p>

        <div className={styles.footer}>
          <a
            className={styles.link}
            href={LIVECOINWATCH_KEYS_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            Get a free key ↗
          </a>
          <span className={styles.actions}>
            {editing ? (
              <>
                <button
                  type="button"
                  className={styles.secondary}
                  onClick={() => (key ? setReplacing(false) : onClose())}
                >
                  Cancel
                </button>
                <button type="submit" className={styles.primary} disabled={!ready}>
                  Save
                </button>
              </>
            ) : (
              <button type="button" className={styles.primary} onClick={onClose}>
                Done
              </button>
            )}
          </span>
        </div>
        <p className={styles.attribution}>
          Market data by{' '}
          <a href="https://www.livecoinwatch.com" target="_blank" rel="noopener noreferrer">
            Live Coin Watch
          </a>
        </p>
      </form>
    </div>,
    document.body,
  );
}
