import type { SavedScript, ScriptVersion } from '@tradingnerd/core';
import type * as Monaco from 'monaco-editor';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { scriptsApi } from '../data/api';
import dialog from '../toolbar/AddIntervalDialog.module.css';
import { CloseIcon } from '../toolbar/icons';
import { PINE } from './language';
import { loadMonaco } from './monaco';
import styles from './VersionHistoryDialog.module.css';

/** "Nov 1, 2026, 10:20", as a version is labeled: by when it was saved (Help Center). */
export const versionTime = (ms: number) => {
  const date = new Date(ms);
  const day = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const time = date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  return `${day}, ${time}`;
};

/** The versions a search keeps: by their time as written, or their number. */
export function matchingVersions(
  versions: readonly ScriptVersion[],
  query: string,
): ScriptVersion[] {
  const needle = query.trim().toLowerCase();
  const newestFirst = [...versions].sort((a, b) => b.version - a.version);
  if (!needle) return newestFirst;
  return newestFirst.filter(
    (item) =>
      versionTime(item.savedAt).toLowerCase().includes(needle) ||
      `version ${item.version}`.includes(needle),
  );
}

/**
 * Version history… (the script name's menu): every save of one of My scripts, newest first,
 * found by its date and time; the one picked beside the one before it, the differences marked,
 * side by side or inline; and its More menu's "Add version to chart", which puts that version on
 * the chart in a pane of its own (TradingView's Help Center, "How to apply an older version of an
 * indicator to the chart"). Provisional look, in the app's dialog idiom (docs/SPEC.md §11).
 */
export function VersionHistoryDialog({
  scriptId,
  name,
  onAddToChart,
  onClose,
}: {
  scriptId: string;
  name: string;
  onAddToChart(source: string): void;
  onClose(): void;
}) {
  const id = useId();
  const [script, setScript] = useState<SavedScript | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<number | null>(null);
  const [sideBySide, setSideBySide] = useState(true);
  const [menuFor, setMenuFor] = useState<number | null>(null);
  const [added, setAdded] = useState<number | null>(null);
  const [codes, setCodes] = useState<{ before: string; after: string } | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const diff = useRef<Monaco.editor.IStandaloneDiffEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    scriptsApi.get(scriptId, abort.signal).then(
      (loaded) => {
        setScript(loaded);
        setPicked(loaded.version);
      },
      (error: unknown) => {
        if (!abort.signal.aborted) setFailed(error instanceof Error ? error.message : 'Failed');
      },
    );
    return () => abort.abort();
  }, [scriptId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (menuFor !== null) setMenuFor(null);
        else onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [menuFor, onClose]);

  // The picked version's code and the one before it's (empty before the first).
  useEffect(() => {
    if (picked === null || !script) return;
    const abort = new AbortController();
    const earlier = script.versions
      .filter((item) => item.version < picked)
      .reduce<number | null>((best, item) => Math.max(best ?? 0, item.version), null);
    const code = (version: number | null) =>
      version === null
        ? Promise.resolve('')
        : scriptsApi.version(scriptId, version, abort.signal).then((item) => item.source);
    Promise.all([code(earlier), code(picked)]).then(
      ([before, after]) => setCodes({ before, after }),
      () => {
        if (!abort.signal.aborted) setFailed('The version could not be loaded');
      },
    );
    return () => abort.abort();
  }, [picked, script, scriptId]);

  // Monaco's diff editor, made once, its models changed with the picked version.
  useEffect(() => {
    let disposed = false;
    void loadMonaco().then((monaco) => {
      if (disposed || !host.current) return;
      monacoRef.current = monaco;
      diff.current = monaco.editor.createDiffEditor(host.current, {
        readOnly: true,
        originalEditable: false,
        automaticLayout: true,
        renderSideBySide: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontFamily: "'SF Mono', Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
        fontSize: 12,
        theme: 'tn-pine-dark',
      });
      setCodes((current) => (current ? { ...current } : current));
    });
    return () => {
      disposed = true;
      const models = diff.current?.getModel();
      diff.current?.dispose();
      models?.original.dispose();
      models?.modified.dispose();
      diff.current = null;
    };
  }, []);

  useEffect(() => {
    const monaco = monacoRef.current;
    const editor = diff.current;
    if (!monaco || !editor || !codes) return;
    const old = editor.getModel();
    editor.setModel({
      original: monaco.editor.createModel(codes.before, PINE),
      modified: monaco.editor.createModel(codes.after, PINE),
    });
    old?.original.dispose();
    old?.modified.dispose();
  }, [codes]);

  useEffect(() => {
    diff.current?.updateOptions({ renderSideBySide: sideBySide });
  }, [sideBySide]);

  const versions = script ? matchingVersions(script.versions, query) : [];

  return createPortal(
    <div className={dialog.backdrop}>
      <div
        className={`${dialog.dialog} ${styles.dialog}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
      >
        <div className={dialog.titleRow}>
          <h2 id={`${id}-title`} className={dialog.title}>
            Version history · {name}
          </h2>
          <button type="button" className={dialog.close} aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <div className={styles.body}>
          <div className={styles.side}>
            <input
              className={dialog.input}
              aria-label="Search by date and time"
              placeholder="Search by date and time"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <ul className={styles.versions} aria-label="Versions">
              {!script && !failed && <li className={styles.note}>Loading…</li>}
              {failed && <li className={styles.note}>{failed}</li>}
              {script && versions.length === 0 && (
                <li className={styles.note}>No version saved then</li>
              )}
              {versions.map((item) => (
                <li key={item.version} className={styles.version}>
                  <button
                    type="button"
                    className={styles.pick}
                    aria-pressed={picked === item.version}
                    onClick={() => setPicked(item.version)}
                  >
                    <span>{versionTime(item.savedAt)}</span>
                    <span className={styles.number}>
                      Version {item.version}
                      {item.version === script?.version ? ' · current' : ''}
                      {added === item.version ? ' · added to the chart' : ''}
                    </span>
                  </button>
                  <button
                    type="button"
                    className={styles.more}
                    aria-label={`More for version ${item.version}`}
                    aria-haspopup="menu"
                    aria-expanded={menuFor === item.version}
                    onClick={() => setMenuFor(menuFor === item.version ? null : item.version)}
                  >
                    ⋯
                  </button>
                  {menuFor === item.version && (
                    <div className={styles.menu} role="menu">
                      <button
                        type="button"
                        role="menuitem"
                        className={styles.menuItem}
                        onClick={() => {
                          setMenuFor(null);
                          void scriptsApi.version(scriptId, item.version).then((found) => {
                            onAddToChart(found.source);
                            setAdded(item.version);
                          });
                        }}
                      >
                        Add version to chart
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
          <div className={styles.preview}>
            <fieldset className={styles.toggle} aria-label="Differences">
              <button
                type="button"
                className={styles.toggleButton}
                aria-pressed={sideBySide}
                onClick={() => setSideBySide(true)}
              >
                Side by side
              </button>
              <button
                type="button"
                className={styles.toggleButton}
                aria-pressed={!sideBySide}
                onClick={() => setSideBySide(false)}
              >
                Inline
              </button>
            </fieldset>
            <div ref={host} className={styles.diff} data-testid="version-diff" />
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
