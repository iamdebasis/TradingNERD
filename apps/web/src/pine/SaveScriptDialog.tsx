import { MAX_SCRIPT_NAME, parseScriptName } from '@tradingnerd/core';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import styles from '../toolbar/AddIntervalDialog.module.css';
import { CloseIcon } from '../toolbar/icons';

/**
 * A script's name in My scripts, apart from its indicator() title: "Save script" for one that
 * isn't saved yet (TradingView's Pine docs; a third-party guide, TradingCode), and the script
 * menu's "Make a copy…" and "Rename…" (Help Center, "How to work with Pine Editor"). Provisional
 * look, in the app's dialog idiom (docs/SPEC.md §11).
 */
export function SaveScriptDialog({
  initialName,
  busy,
  onSave,
  onClose,
  title = 'Save script',
  action = 'Save',
}: {
  initialName: string;
  busy: boolean;
  onSave(name: string): void;
  onClose(): void;
  title?: string;
  action?: string;
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
            {title}
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
            {action}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
