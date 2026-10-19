import { type FormEvent, useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError } from '../data/api';
import { CloseIcon } from '../toolbar/icons';
import { useLogos } from './LogoContext';
import styles from './LogoDialog.module.css';

/** Where CoinGecko hands out free (Demo) API keys. */
export const COINGECKO_KEYS_URL = 'https://www.coingecko.com/en/developers/dashboard';

type Check =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'error'; message: string }
  | { kind: 'saved'; plan: string };

const planName = (plan: string | null) => (plan === 'pro' ? 'Pro plan' : 'Demo plan');

/**
 * "Coin logos": the CoinGecko key that coin logos need (docs/SPEC.md §5.5). Shown once at first
 * launch, where "Skip for now" works and doesn't ask again, and from the watchlist's ⋯ menu.
 * A key is checked with CoinGecko before it is kept; the browser only ever sees it masked.
 */
export function LogoDialog({ firstLaunch, onClose }: { firstLaunch: boolean; onClose(): void }) {
  const id = useId();
  const { status, api, update } = useLogos();
  const key = status?.key ?? null;
  const [editing, setEditing] = useState(key === null);
  const [value, setValue] = useState('');
  const [check, setCheck] = useState<Check>({ kind: 'idle' });

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

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (value.trim() === '' || check.kind === 'checking') return;
    setCheck({ kind: 'checking' });
    try {
      const saved = await api.saveKey(value);
      update(saved);
      setValue('');
      setEditing(false);
      setCheck({ kind: 'saved', plan: planName(saved.key?.plan ?? null) });
    } catch (error) {
      setCheck({
        kind: 'error',
        message: error instanceof ApiError ? error.message : 'The key could not be checked',
      });
    }
  };

  const remove = async () => {
    try {
      update(await api.removeKey());
      setEditing(true);
      setCheck({ kind: 'idle' });
    } catch (error) {
      setCheck({ kind: 'error', message: error instanceof ApiError ? error.message : 'Failed' });
    }
  };

  const skip = async () => {
    try {
      update(await api.dismissPrompt());
    } finally {
      onClose();
    }
  };

  let sync = '';
  if (status?.syncing) sync = 'Updating logos…';
  else if (status?.syncError) sync = status.syncError;
  else if (status?.syncedAt)
    sync = `Logos updated ${new Date(status.syncedAt).toLocaleDateString('en-GB')}`;

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
            Coin logos
          </h2>
          <button type="button" className={styles.close} aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <p className={styles.text}>
          Logos come from CoinGecko and need a free CoinGecko API key. The key stays on this
          computer; without one, coins show their first letter.
        </p>

        {key && !editing && (
          <div className={styles.keyRow}>
            <span>
              API key <span className={styles.masked}>{key.masked}</span> ·{' '}
              {key.plan ? planName(key.plan) : 'not checked yet'}
            </span>
            {key.source === 'env' ? (
              <span className={styles.note}>Set by COINGECKO_API_KEY</span>
            ) : (
              <span className={styles.keyActions}>
                <button type="button" className={styles.secondary} onClick={() => setEditing(true)}>
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
              placeholder="CG-…"
              onChange={(event) => {
                setValue(event.target.value);
                if (check.kind === 'error') setCheck({ kind: 'idle' });
              }}
            />
          </label>
        )}

        <p className={styles.status} data-kind={check.kind} aria-live="polite">
          {check.kind === 'checking' && 'Checking the key with CoinGecko…'}
          {check.kind === 'error' && check.message}
          {check.kind === 'saved' && `✓ Key works · ${check.plan}`}
          {check.kind === 'idle' && (sync || ' ')}
        </p>

        <div className={styles.footer}>
          <a
            className={styles.link}
            href={COINGECKO_KEYS_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            Get a free key ↗
          </a>
          <span className={styles.actions}>
            {editing ? (
              <>
                {firstLaunch && !key ? (
                  <button type="button" className={styles.secondary} onClick={() => void skip()}>
                    Skip for now
                  </button>
                ) : (
                  <button
                    type="button"
                    className={styles.secondary}
                    onClick={() => (key ? setEditing(false) : onClose())}
                  >
                    Cancel
                  </button>
                )}
                <button
                  type="submit"
                  className={styles.primary}
                  disabled={value.trim() === '' || check.kind === 'checking'}
                >
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
          Data provided by{' '}
          <a href="https://www.coingecko.com" target="_blank" rel="noopener noreferrer">
            CoinGecko
          </a>
        </p>
      </form>
    </div>,
    document.body,
  );
}
