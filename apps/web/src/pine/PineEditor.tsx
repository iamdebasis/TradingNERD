import type { ScriptSummary } from '@tradingnerd/core';
import { compileCached, PINE_VERSION, type PineDiagnostic } from '@tradingnerd/pine';
import { useEffect, useMemo, useRef, useState } from 'react';
import { scriptsApi } from '../data/api';
import { useIndicators } from '../indicators/indicatorStore';
import { CloseIcon } from '../toolbar/icons';
import { type CodeEdit, CodeEditor, type CodeEditorEvents, type CodeReveal } from './CodeEditor';
import {
  ChevronIcon,
  ConsoleIcon,
  NoticeIcon,
  PanelIcon,
  PlayIcon,
  SaveIcon,
  WaveIcon,
} from './icons';
import styles from './PineEditor.module.css';
import { documentName, type PineDocument, pineStore, usePine } from './pineStore';
import { SaveScriptDialog } from './SaveScriptDialog';

/** The compiler's messages for the code, worked out a moment after typing stops. */
function useDiagnostics(text: string): readonly PineDiagnostic[] {
  const [diagnostics, setDiagnostics] = useState<readonly PineDiagnostic[]>([]);
  useEffect(() => {
    const timer = setTimeout(() => {
      const result = compileCached(text);
      setDiagnostics(result.ok ? result.warnings : [...result.errors, ...result.warnings]);
    }, 250);
    return () => clearTimeout(timer);
  }, [text]);
  return diagnostics;
}

/** "Sep 29, 17:40", as the status bar shows a saved version's time (the user's screenshot). */
const savedTime = (ms: number) => {
  const date = new Date(ms);
  const day = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const time = date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  return `${day}, ${time}`;
};

/** The name Save script suggests: the script's indicator() title, else the header's name. */
function suggestedName(document: PineDocument): string {
  const result = compileCached(document.text);
  const title = result.ok ? result.program.describe(result.program.defaults()).title : '';
  return title || documentName(document);
}

/**
 * The Pine Editor (docs/SPEC.md §5.16), as TradingView's side panel (the user's screenshot of
 * 27 October 2026): "Pine Editor" and its close button; the script's name with its menu and
 * Add to chart (Update on chart once added); for a built-in's code, a banner saying edits make
 * a copy, with Reset to original; the code; the console; and the status bar with the saved
 * version, the cursor's line and column, and "Pine Script® v6".
 */
export function PineEditor({ onClose }: { onClose(): void }) {
  const state = usePine();
  const indicators = useIndicators();
  const { document } = state;
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [edit, setEdit] = useState<CodeEdit | null>(null);
  const [reveal, setReveal] = useState<CodeReveal | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [myScripts, setMyScripts] = useState<readonly ScriptSummary[] | null>(null);
  const diagnostics = useDiagnostics(document?.text ?? '');
  const errors = diagnostics.filter((item) => item.severity === 'error').length;

  // The editor opens on a new indicator when it has nothing open, as TradingView's does.
  useEffect(() => {
    if (!document && !state.busy) pineStore.openNew();
  }, [document, state.busy]);

  // The script's menu lists My scripts, fresh each time it opens.
  useEffect(() => {
    if (!menuOpen) return;
    const abort = new AbortController();
    scriptsApi.index(abort.signal).then(
      (index) => setMyScripts(index.scripts),
      () => setMyScripts([]),
    );
    return () => abort.abort();
  }, [menuOpen]);

  const onChart = useMemo(
    () => document?.chartId != null && indicators.list.some((item) => item.id === document.chartId),
    [document?.chartId, indicators.list],
  );

  const run = () => {
    if (!pineStore.addToChart()) setConsoleOpen(true);
  };
  const save = () => {
    if (!document || state.busy) return;
    if (document.origin.kind === 'saved') void pineStore.save();
    else setSaving(true);
  };
  const runRef = useRef(run);
  runRef.current = run;
  const saveRef = useRef(save);
  saveRef.current = save;

  const events = useMemo(
    (): CodeEditorEvents => ({
      onChange: (text) => pineStore.setText(text),
      onCursor: (line, column) => setCursor({ line, column }),
      onRun: () => runRef.current(),
      onSave: () => saveRef.current(),
    }),
    [],
  );

  const edited = document !== null && document.text !== document.original;
  const close = () => {
    setMenuOpen(false);
    onClose();
  };

  return (
    <section className={styles.panel} aria-label="Pine Editor" data-testid="pine-editor">
      <header className={styles.top}>
        <span className={styles.panelIcon}>
          <PanelIcon />
        </span>
        <h2 className={styles.panelTitle}>Pine Editor</h2>
        <button
          type="button"
          className={styles.iconButton}
          aria-label="Close Pine Editor"
          title="Close"
          onClick={close}
        >
          <CloseIcon />
        </button>
      </header>
      {document && (
        <div className={styles.scriptRow}>
          <span className={styles.wave}>
            <WaveIcon />
          </span>
          <div className={styles.menuWrap}>
            <button
              type="button"
              className={styles.name}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
              data-testid="pine-name"
            >
              {documentName(document)}
              {edited && (
                <span
                  className={styles.unsaved}
                  role="img"
                  aria-label="Unsaved changes"
                  title="Unsaved changes"
                />
              )}
              <ChevronIcon />
            </button>
            {menuOpen && (
              <ScriptMenu
                scripts={myScripts}
                onSave={() => {
                  setMenuOpen(false);
                  save();
                }}
                onNew={() => {
                  setMenuOpen(false);
                  pineStore.openNew();
                }}
                onBuiltin={() => {
                  setMenuOpen(false);
                  pineStore.openBuiltin('rsi');
                }}
                onOpen={(id) => {
                  setMenuOpen(false);
                  void pineStore.openSaved(id);
                }}
                onDismiss={() => setMenuOpen(false)}
              />
            )}
          </div>
          <button type="button" className={styles.outlined} onClick={run} title="Ctrl + Enter">
            <PlayIcon />
            {onChart ? 'Update on chart' : 'Add to chart'}
          </button>
          <span className={styles.spacer} />
          <button
            type="button"
            className={styles.outlined}
            onClick={save}
            disabled={state.busy}
            title="Ctrl + S"
          >
            <SaveIcon />
            Save script
          </button>
        </div>
      )}
      {document?.origin.kind === 'builtin' && (
        <div className={styles.banner} role="note" data-testid="pine-banner">
          <NoticeIcon />
          <span>
            <strong className={styles.bannerStrong}>Built-in script.</strong> Your edits make a
            copy; the original stays as it is.
          </span>
          {edited && (
            <button
              type="button"
              className={styles.link}
              onClick={() => setEdit({ text: document.original, serial: Date.now() })}
            >
              Reset to original
            </button>
          )}
        </div>
      )}
      {state.notice && (
        <div className={styles.notice} role="alert">
          {state.notice}
          <button type="button" className={styles.link} onClick={() => pineStore.dismissNotice()}>
            Dismiss
          </button>
        </div>
      )}
      {document ? (
        <CodeEditor
          key={document.key}
          text={document.text}
          diagnostics={diagnostics}
          edit={edit}
          reveal={reveal}
          events={events}
        />
      ) : (
        <div className={styles.empty}>{state.busy ? 'Opening the script…' : ''}</div>
      )}
      {consoleOpen && (
        <div
          className={styles.console}
          role="log"
          aria-label="Pine console"
          data-testid="pine-console"
        >
          {diagnostics.length === 0 ? (
            <div className={styles.consoleLine}>No errors</div>
          ) : (
            diagnostics.map((item) => (
              <button
                key={`${item.line}:${item.column}:${item.message}`}
                type="button"
                className={styles.consoleLine}
                data-severity={item.severity}
                onClick={() =>
                  setReveal({ line: item.line, column: item.column, serial: Date.now() })
                }
              >
                {item.severity === 'error' ? 'Error' : 'Warning'} at {item.line}:{item.column}{' '}
                {item.message}
              </button>
            ))
          )}
        </div>
      )}
      <footer className={styles.status}>
        <button
          type="button"
          className={styles.consoleToggle}
          aria-label="Pine console"
          aria-pressed={consoleOpen}
          title="Console"
          onClick={() => setConsoleOpen((open) => !open)}
        >
          <ConsoleIcon />
          {errors > 0 && <span className={styles.errorCount}>{errors}</span>}
        </button>
        <span className={styles.spacer} />
        {document?.origin.kind === 'saved' && (
          <span data-testid="pine-version">
            {document.origin.version} · {savedTime(document.origin.savedAt)}
          </span>
        )}
        <span>
          Line {cursor.line}, Col {cursor.column}
        </span>
        <span>Pine Script® v{PINE_VERSION}</span>
      </footer>
      {saving && document && (
        <SaveScriptDialog
          initialName={suggestedName(document)}
          busy={state.busy}
          onSave={(name) => {
            void pineStore.save(name).then((ok) => {
              if (ok) setSaving(false);
            });
          }}
          onClose={() => setSaving(false)}
        />
      )}
    </section>
  );
}

/** The script name's menu: Save script, Create new, a built-in's code, and My scripts to open. */
function ScriptMenu({
  scripts,
  onSave,
  onNew,
  onBuiltin,
  onOpen,
  onDismiss,
}: {
  scripts: readonly ScriptSummary[] | null;
  onSave(): void;
  onNew(): void;
  onBuiltin(): void;
  onOpen(id: string): void;
  onDismiss(): void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!menu.current?.parentElement?.contains(event.target as Node)) onDismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onDismiss]);
  return (
    <div ref={menu} className={styles.menu} role="menu">
      <button type="button" role="menuitem" className={styles.menuItem} onClick={onSave}>
        Save script <span className={styles.shortcut}>Ctrl + S</span>
      </button>
      <div className={styles.menuHeading}>Create new</div>
      <button type="button" role="menuitem" className={styles.menuItem} onClick={onNew}>
        Indicator
      </button>
      <button type="button" role="menuitem" className={styles.menuItem} onClick={onBuiltin}>
        Built-in: Relative Strength Index
      </button>
      <div className={styles.menuHeading}>Open script</div>
      {scripts === null && <div className={styles.menuNote}>Loading…</div>}
      {scripts?.length === 0 && <div className={styles.menuNote}>No saved scripts yet</div>}
      {scripts?.map((script) => (
        <button
          key={script.id}
          type="button"
          role="menuitem"
          className={styles.menuItem}
          onClick={() => onOpen(script.id)}
        >
          {script.name}
        </button>
      ))}
    </div>
  );
}
