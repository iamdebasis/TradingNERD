import {
  compileCached,
  convertToV6,
  PINE_VERSION,
  type PineDiagnostic,
  versionIn,
} from '@tradingnerd/pine';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useIndicators } from '../indicators/indicatorStore';
import { CloseIcon } from '../toolbar/icons';
import { type CodeEdit, CodeEditor, type CodeEditorEvents, type CodeReveal } from './CodeEditor';
import {
  ChevronIcon,
  ConsoleIcon,
  MoreIcon,
  NoticeIcon,
  PanelIcon,
  PlayIcon,
  SaveIcon,
  WaveIcon,
} from './icons';
import { LibrariesDialog } from './LibrariesDialog';
import { librariesStore, useLibraries } from './librariesStore';
import { logsStore } from './logsStore';
import { OpenScriptDialog } from './OpenScriptDialog';
import styles from './PineEditor.module.css';
import {
  documentName,
  type PineDocument,
  pineStore,
  type RecentScript,
  usePine,
} from './pineStore';
import { SaveScriptDialog } from './SaveScriptDialog';
import { VersionHistoryDialog } from './VersionHistoryDialog';

/**
 * The compiler's messages for the code, worked out a moment after typing stops, and again when a
 * library is added or removed (`revision`).
 */
function useDiagnostics(text: string, revision: number): readonly PineDiagnostic[] {
  const [diagnostics, setDiagnostics] = useState<readonly PineDiagnostic[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the libraries' revision recompiles
  useEffect(() => {
    const timer = setTimeout(() => {
      const result = compileCached(text, librariesStore.compileOptions());
      setDiagnostics(result.ok ? result.warnings : [...result.errors, ...result.warnings]);
    }, 250);
    return () => clearTimeout(timer);
  }, [text, revision]);
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
  const result = compileCached(document.text, librariesStore.compileOptions());
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
  /** Where to put the cursor, for the code it was asked for (its document's key). */
  const [reveal, setReveal] = useState<(CodeReveal & { key: string }) | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  /** The dialog showing: naming a save, a copy or a rename, Open script, Version history. */
  const [dialog, setDialog] = useState<'save' | 'copy' | 'rename' | 'open' | 'history' | null>(
    null,
  );
  const [consoleOpen, setConsoleOpen] = useState(false);
  /** The Libraries dialog: closed (false), from the menu (null), or for an import's path. */
  const [librariesFor, setLibrariesFor] = useState<string | null | false>(false);
  const { revision } = useLibraries();
  const diagnostics = useDiagnostics(document?.text ?? '', revision);
  const errors = diagnostics.filter((item) => item.severity === 'error').length;

  // The editor opens on a new indicator when it has nothing open, as TradingView's does.
  useEffect(() => {
    if (!document && !state.busy) pineStore.openNew();
  }, [document, state.busy]);

  // A Pine Logs entry's Source code: once its script's code is open, its line is selected, once
  // (typing changes the document, and mustn't select it again).
  const lineRequest = state.line;
  const lineShown = useRef(0);
  const documentKey = document?.key;
  const documentChart = document?.chartId;
  useEffect(() => {
    if (!lineRequest || lineRequest.serial === lineShown.current) return;
    if (!documentKey || documentChart !== lineRequest.chartId) return;
    lineShown.current = lineRequest.serial;
    setReveal({
      line: lineRequest.line,
      column: 1,
      select: true,
      serial: lineRequest.serial,
      key: documentKey,
    });
  }, [lineRequest, documentKey, documentChart]);

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
    else setDialog('save');
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
      onOpen: () => setDialog('open'),
    }),
    [],
  );

  const edited = document !== null && document.text !== document.original;
  // Convert code to v6: for v5 code, once it compiles (v6 migration guide).
  const convert =
    document && versionIn(document.text) === 5 ? (errors > 0 ? 'blocked' : 'ready') : null;
  const convertCode = () => {
    if (!document) return;
    const result = convertToV6(document.text, librariesStore.compileOptions());
    // One edit of the whole code, so Undo brings the v5 code back; errors left show as usual.
    if (result.ok) setEdit({ text: result.source, serial: Date.now() });
  };
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
                saved={document.origin.kind === 'saved'}
                convert={convert}
                dock={state.dock}
                recent={state.recent}
                onPick={(pick) => {
                  setMenuOpen(false);
                  if (pick === 'save') save();
                  else if (pick === 'convert') convertCode();
                  else if (pick === 'dock') {
                    // Back on the right, the editor takes the panel from Pine Logs.
                    const next = state.dock === 'right' ? 'bottom' : 'right';
                    pineStore.setDock(next);
                    if (next === 'right') logsStore.close();
                  } else if (pick === 'indicator' || pick === 'library') pineStore.openNew(pick);
                  else if (pick === 'libraries') setLibrariesFor(null);
                  else setDialog(pick);
                }}
                onRecent={(item) => {
                  setMenuOpen(false);
                  pineStore.openRecent(item);
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
          <div className={styles.menuWrap}>
            <button
              type="button"
              className={styles.iconButton}
              aria-label="More"
              title="More"
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((open) => !open)}
            >
              <MoreIcon />
            </button>
            {moreOpen && (
              <MoreMenu
                onPineLogs={() => {
                  setMoreOpen(false);
                  logsStore.open(onChart && document.chartId ? document.chartId : null);
                }}
                onDismiss={() => setMoreOpen(false)}
              />
            )}
          </div>
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
          reveal={reveal?.key === document.key ? reveal : null}
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
              <div
                key={`${item.line}:${item.column}:${item.message}`}
                className={styles.consoleRow}
              >
                <button
                  type="button"
                  className={styles.consoleLine}
                  data-severity={item.severity}
                  onClick={() =>
                    document &&
                    setReveal({
                      line: item.line,
                      column: item.column,
                      serial: Date.now(),
                      key: document.key,
                    })
                  }
                >
                  {item.severity === 'error' ? 'Error' : 'Warning'} at {item.line}:{item.column}{' '}
                  {item.message}
                </button>
                {item.library && (
                  <button
                    type="button"
                    className={styles.consoleAction}
                    onClick={() => setLibrariesFor(item.library?.path ?? null)}
                  >
                    {item.library.problem === 'missing' ? 'Add library…' : 'Replace library…'}
                  </button>
                )}
              </div>
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
      {librariesFor !== false && (
        <LibrariesDialog initialPath={librariesFor} onClose={() => setLibrariesFor(false)} />
      )}
      {(dialog === 'save' || dialog === 'copy' || dialog === 'rename') && document && (
        <SaveScriptDialog
          title={
            dialog === 'copy'
              ? 'Make a copy'
              : dialog === 'rename'
                ? 'Rename script'
                : 'Save script'
          }
          action={dialog === 'copy' ? 'Make a copy' : dialog === 'rename' ? 'Rename' : 'Save'}
          initialName={dialog === 'save' ? suggestedName(document) : documentName(document)}
          busy={state.busy}
          onSave={(name) => {
            const done =
              dialog === 'copy'
                ? pineStore.makeCopy(name)
                : dialog === 'rename'
                  ? pineStore.rename(name)
                  : pineStore.save(name);
            void done.then((ok) => {
              if (ok) setDialog(null);
            });
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'open' && (
        <OpenScriptDialog
          onOpen={(id) => {
            setDialog(null);
            void pineStore.openSaved(id);
          }}
          onBuiltin={(builtin) => {
            setDialog(null);
            pineStore.openBuiltin(builtin);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'history' && document?.origin.kind === 'saved' && (
        <VersionHistoryDialog
          scriptId={document.origin.scriptId}
          name={document.origin.name}
          onAddToChart={(source) => pineStore.addVersionToChart(source)}
          onClose={() => setDialog(null)}
        />
      )}
    </section>
  );
}

/** What the script name's menu picks. */
type MenuPick =
  | 'save'
  | 'copy'
  | 'rename'
  | 'history'
  | 'dock'
  | 'convert'
  | 'indicator'
  | 'library'
  | 'open'
  | 'libraries';

/**
 * The script name's menu, as TradingView's (the user's screenshot of 31 October; Help Center,
 * "How to work with Pine Editor"): Save script, Make a copy…, Rename…, Version history…, Create
 * new (Indicator, Strategy, Library, Built-in…), Recently used, Open script…; and My libraries,
 * which TradingView doesn't need (§5.17). Make a copy, Rename and Version history are for one of
 * My scripts. A strategy comes later (P5). Convert code to v6 shows for v5 code, which must compile
 * (v6 migration guide); its place in the menu is provisional (§11).
 */
function ScriptMenu({
  saved,
  convert,
  dock,
  recent,
  onPick,
  onRecent,
  onDismiss,
}: {
  saved: boolean;
  convert: 'ready' | 'blocked' | null;
  dock: 'right' | 'bottom';
  recent: readonly RecentScript[];
  onPick(pick: MenuPick): void;
  onRecent(item: RecentScript): void;
  onDismiss(): void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [createOpen, setCreateOpen] = useState(false);
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
  const item = (
    pick: MenuPick,
    label: string,
    shortcut?: string,
    disabled = false,
    title?: string,
  ) => (
    <button
      type="button"
      role="menuitem"
      className={styles.menuItem}
      disabled={disabled}
      title={title}
      onClick={() => onPick(pick)}
    >
      {label}
      {shortcut && <span className={styles.shortcut}>{shortcut}</span>}
    </button>
  );
  const builtinName = (builtin: string) =>
    builtin === 'rsi' ? 'Relative Strength Index' : 'Volume';
  return (
    <div ref={menu} className={styles.menu} role="menu">
      {item('save', 'Save script', 'Ctrl + S')}
      {item('copy', 'Make a copy…', undefined, !saved)}
      {item('rename', 'Rename…', undefined, !saved)}
      {item('history', 'Version history…', undefined, !saved)}
      {item('dock', dock === 'right' ? 'Move script to bottom' : 'Move script to right')}
      {convert &&
        item(
          'convert',
          'Convert code to v6…',
          undefined,
          convert === 'blocked',
          convert === 'blocked' ? 'A script converts once its v5 code compiles' : undefined,
        )}
      <div className={styles.submenuWrap}>
        <button
          type="button"
          role="menuitem"
          className={styles.menuItem}
          aria-haspopup="menu"
          aria-expanded={createOpen}
          onClick={() => setCreateOpen(true)}
          onMouseEnter={() => setCreateOpen(true)}
        >
          Create new
          <span className={styles.shortcut}>›</span>
        </button>
        {createOpen && (
          <div className={styles.submenu} role="menu" aria-label="Create new">
            {item('indicator', 'Indicator')}
            <button
              type="button"
              role="menuitem"
              className={styles.menuItem}
              disabled
              title="Strategies come later, with the Strategy Tester"
            >
              Strategy
            </button>
            {item('library', 'Library')}
            {item('open', 'Built-in…')}
          </div>
        )}
      </div>
      {recent.length > 0 && <div className={styles.menuHeading}>Recently used</div>}
      {recent.map((script) => (
        <button
          key={script.kind === 'saved' ? script.scriptId : script.builtin}
          type="button"
          role="menuitem"
          className={styles.menuItem}
          onClick={() => onRecent(script)}
        >
          {script.kind === 'saved' ? script.name : builtinName(script.builtin)}
        </button>
      ))}
      <div className={styles.menuSeparator} />
      {item('open', 'Open script…', 'Ctrl + O')}
      {item('libraries', 'My libraries…')}
    </div>
  );
}

/**
 * The editor's More menu (⋯; TradingView's Help Center, "How to work with Pine Editor"): Pine
 * Logs… here; its other items (new window or tab, editor settings, Profiler mode) come later.
 */
function MoreMenu({ onPineLogs, onDismiss }: { onPineLogs(): void; onDismiss(): void }) {
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
    <div ref={menu} className={`${styles.menu} ${styles.menuRight}`} role="menu" aria-label="More">
      <button type="button" role="menuitem" className={styles.menuItem} onClick={onPineLogs}>
        Pine Logs…
      </button>
    </div>
  );
}
