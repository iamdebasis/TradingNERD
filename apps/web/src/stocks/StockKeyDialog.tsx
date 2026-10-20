import { type FormEvent, useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError } from '../data/api';
import styles from '../logos/LogoDialog.module.css';
import { CloseIcon } from '../toolbar/icons';
import { useStockKeys } from './stockKeys';

/** Where Alpaca hands out free API keys (a paper-trading account is enough). */
export const ALPACA_KEYS_URL = 'https://app.alpaca.markets/signup';

type Check =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'error'; message: string }
  | { kind: 'saved'; access: string };

const accessName = (sip: string | null) =>
  sip === 'realtime' ? 'real-time' : 'free plan: 15 minutes delayed';

/**
 * "US stock data": the Alpaca key and secret that stock and ETF prices need (docs/SPEC.md
 * §5.7), in the coin logo dialog's style. A key is checked with Alpaca before it is kept;
 * the browser only ever sees its ID masked.
 */
export function StockKeyDialog({ onClose }: { onClose(): void }) {
  const id = useId();
  const { status, api, update } = useStockKeys();
  const configured = status?.configured ?? false;
  const [editing, setEditing] = useState(!configured);
  const [keyId, setKeyId] = useState('');
  const [secret, setSecret] = useState('');
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

  const ready = keyId.trim() !== '' && secret.trim() !== '' && check.kind !== 'checking';

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setCheck({ kind: 'checking' });
    try {
      const saved = await api.saveKey(keyId, secret);
      update(saved);
      setKeyId('');
      setSecret('');
      setEditing(false);
      setCheck({ kind: 'saved', access: accessName(saved.sip) });
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

  const clearError = () => {
    if (check.kind === 'error') setCheck({ kind: 'idle' });
  };

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
            US stock data
          </h2>
          <button type="button" className={styles.close} aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <p className={styles.text}>
          US stock and ETF prices come from Alpaca, with a free API key. The free plan shows the
          whole market 15 minutes late, pre- and after-market included. The key stays on this
          computer.
        </p>

        {configured && !editing && (
          <div className={styles.keyRow}>
            <span>
              Key ID <span className={styles.masked}>{status?.keyId}</span> ·{' '}
              {status?.sip ? accessName(status.sip) : 'not checked yet'}
            </span>
            {status?.source === 'env' ? (
              <span className={styles.note}>Set by APCA_API_KEY_ID</span>
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
          <>
            <label className={styles.field}>
              <span className={styles.label}>API key ID</span>
              <input
                className={styles.input}
                type="text"
                autoComplete="off"
                spellCheck={false}
                // biome-ignore lint/a11y/noAutofocus: the dialog exists to paste this key
                autoFocus
                value={keyId}
                placeholder="PK…"
                onChange={(event) => {
                  setKeyId(event.target.value);
                  clearError();
                }}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.label}>Secret key</span>
              <input
                className={styles.input}
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={secret}
                onChange={(event) => {
                  setSecret(event.target.value);
                  clearError();
                }}
              />
            </label>
          </>
        )}

        <p className={styles.status} data-kind={check.kind} aria-live="polite">
          {check.kind === 'checking' && 'Checking the key with Alpaca…'}
          {check.kind === 'error' && check.message}
          {check.kind === 'saved' && `✓ Key works · ${check.access}`}
          {check.kind === 'idle' && ' '}
        </p>

        <div className={styles.footer}>
          <a
            className={styles.link}
            href={ALPACA_KEYS_URL}
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
                  onClick={() => (configured ? setEditing(false) : onClose())}
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
          <a href="https://alpaca.markets" target="_blank" rel="noopener noreferrer">
            Alpaca
          </a>
        </p>
      </form>
    </div>,
    document.body,
  );
}
