import { MAX_SCRIPT_NAME, parseScriptName } from '@tradingnerd/core';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import styles from '../toolbar/AddIntervalDialog.module.css';
import { CloseIcon } from '../toolbar/icons';

/**
 * "Save script" for a script that isn't one of My scripts yet: its name there, apart from its
 * indicator() title (TradingView's Pine docs; a third-party guide, TradingCode). Provisional
 * look, in the app's dialog idiom (docs/SPEC.md §11).
 */
export function SaveScriptDialog({
  initialName,
  busy,
  onSave,
  onClose,
}: {
  initialName: string;
  busy: boolean;
  onSave(name: string): void;
  onClose(): void;
}) {
  const id = useId();
  const [name, setName] = useState(initialName);
  const valid = parseScriptName(name) !== null;

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

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = parseScriptName(name);
    if (parsed && !busy) onSave(parsed);
  };

  return createPortal(
    <div className={styles.backdrop}>
      <form
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        onSubmit={submit}
      >
        <div className={styles.titleRow}>
          <h2 id={`${id}-title`} className={styles.title}>
            Save script
          </h2>
          <button type="button" className={styles.close} aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <label className={styles.field}>
          <span className={styles.label}>Script name</span>
          <input
            className={styles.input}
            // biome-ignore lint/a11y/noAutofocus: the dialog exists to type this name
            autoFocus
            maxLength={MAX_SCRIPT_NAME}
            value={name}
            aria-invalid={!valid}
            onChange={(event) => setName(event.target.value)}
            onFocus={(event) => event.target.select()}
          />
        </label>
        <p className={styles.hint} data-invalid={!valid}>
          {valid ? ' ' : 'Give the script a name'}
        </p>
        <div className={styles.actions}>
          <button type="button" className={styles.cancel} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={styles.submit} disabled={!valid || busy}>
            Save
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
