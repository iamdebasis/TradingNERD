import type { PineDiagnostic } from '@tradingnerd/pine';
import type * as Monaco from 'monaco-editor';
import { useEffect, useRef, useState } from 'react';
import styles from './CodeEditor.module.css';
import { PINE } from './language';
import { loadMonaco } from './monaco';

/** What the editor tells the panel. */
export interface CodeEditorEvents {
  onChange(text: string): void;
  onCursor(line: number, column: number): void;
  /** Ctrl/Cmd + Enter: Add to chart, or Update on chart. */
  onRun(): void;
  /** Ctrl/Cmd + S: Save script. */
  onSave(): void;
  /** Ctrl/Cmd + O: Open script. */
  onOpen(): void;
}

/** A change the panel makes to the code (Reset to original), as an edit Undo can take back. */
export interface CodeEdit {
  text: string;
  /** Changes each time, so the same text can be put back twice. */
  serial: number;
}

/** Where a click in the console sends the cursor. */
export interface CodeReveal {
  line: number;
  column: number;
  serial: number;
}

/**
 * Monaco, VS Code's editor, as TradingView's Pine Editor uses it (TradingView's blog, "Pine
 * Script has a new VSC-style editor", 2022): Pine's colors, line numbers, the minimap, its
 * errors underlined in red and warnings in orange, and its own Undo history. Monaco loads the
 * first time it's shown.
 */
export function CodeEditor({
  text,
  diagnostics,
  edit,
  reveal,
  events,
}: {
  /** The code to start with; later changes come in as `edit`s. */
  text: string;
  diagnostics: readonly PineDiagnostic[];
  edit: CodeEdit | null;
  reveal: CodeReveal | null;
  events: CodeEditorEvents;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const initial = useRef(text);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let disposed = false;
    let created: Monaco.editor.IStandaloneCodeEditor | null = null;
    void loadMonaco().then((monaco) => {
      if (disposed || !host.current) return;
      monacoRef.current = monaco;
      created = monaco.editor.create(host.current, {
        value: initial.current,
        language: PINE,
        theme: 'tn-pine-dark',
        automaticLayout: true,
        // TradingView's editor: a monospace 13 px font, a minimap, no word wrap (Alt/Option + Z).
        fontFamily: "'SF Mono', Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
        fontSize: 13,
        lineHeight: 20,
        tabSize: 4,
        insertSpaces: true,
        detectIndentation: false,
        minimap: { enabled: true },
        scrollBeyondLastLine: false,
        renderLineHighlight: 'all',
        fixedOverflowWidgets: true,
        ariaLabel: 'Pine Script code',
      });
      editor.current = created;
      created.onDidChangeModelContent(() => eventsRef.current.onChange(created?.getValue() ?? ''));
      created.onDidChangeCursorPosition(({ position }) =>
        eventsRef.current.onCursor(position.lineNumber, position.column),
      );
      // The panel's commands, with their keys, also in the command palette (F1, or Ctrl/Cmd +
      // Shift + P: TradingView's Help Center, "Useful Pine Editor commands").
      const { KeyMod, KeyCode } = monaco;
      created.addAction({
        id: 'tn.addToChart',
        label: 'Add to chart',
        keybindings: [KeyMod.CtrlCmd | KeyCode.Enter],
        run: () => eventsRef.current.onRun(),
      });
      created.addAction({
        id: 'tn.saveScript',
        label: 'Save script',
        keybindings: [KeyMod.CtrlCmd | KeyCode.KeyS],
        run: () => eventsRef.current.onSave(),
      });
      created.addAction({
        id: 'tn.openScript',
        label: 'Open script…',
        keybindings: [KeyMod.CtrlCmd | KeyCode.KeyO],
        run: () => eventsRef.current.onOpen(),
      });
      created.addCommand(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyP, () =>
        created?.trigger('keyboard', 'editor.action.quickCommand', null),
      );
      // Alt/Option + Z: word wrap on and off (TradingView's Help Center).
      created.addAction({
        id: 'tn.toggleWordWrap',
        label: 'Toggle word wrap',
        keybindings: [KeyMod.Alt | KeyCode.KeyZ],
        run: (current) => {
          const wrap = current.getOption(monaco.editor.EditorOption.wordWrap);
          current.updateOptions({ wordWrap: wrap === 'off' ? 'on' : 'off' });
        },
      });
      setLoading(false);
      created.focus();
      if (import.meta.env.DEV) {
        const editorNow = created;
        window.__tradingNerd = {
          chart: window.__tradingNerd?.chart ?? null,
          ...window.__tradingNerd,
          code: {
            set: (next) => {
              const model = editorNow.getModel();
              if (!model) return;
              editorNow.pushUndoStop();
              editorNow.executeEdits('paste', [{ range: model.getFullModelRange(), text: next }]);
              editorNow.pushUndoStop();
            },
          },
        };
      }
    });
    return () => {
      disposed = true;
      if (import.meta.env.DEV && window.__tradingNerd) delete window.__tradingNerd.code;
      created?.getModel()?.dispose();
      created?.dispose();
      editor.current = null;
    };
  }, []);

  // The compiler's messages as markers: red for errors, orange for warnings; again once Monaco
  // has loaded, so the first ones show too.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `loading` re-runs it once the editor exists
  useEffect(() => {
    const monaco = monacoRef.current;
    const model = editor.current?.getModel();
    if (!monaco || !model) return;
    monaco.editor.setModelMarkers(
      model,
      'pine',
      diagnostics.map((d) => ({
        severity:
          d.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
        message: d.message,
        startLineNumber: d.line,
        startColumn: d.column,
        endLineNumber: d.endLine,
        endColumn: Math.max(d.endColumn, d.column + 1),
      })),
    );
  }, [diagnostics, loading]);

  // Reset to original and the like: one edit of the whole code, so Undo brings it back.
  useEffect(() => {
    const model = editor.current?.getModel();
    if (!edit || !model || model.getValue() === edit.text) return;
    editor.current?.pushUndoStop();
    editor.current?.executeEdits('pine', [{ range: model.getFullModelRange(), text: edit.text }]);
    editor.current?.pushUndoStop();
  }, [edit]);

  useEffect(() => {
    if (!reveal || !editor.current) return;
    editor.current.setPosition({ lineNumber: reveal.line, column: reveal.column });
    editor.current.revealLineInCenter(reveal.line);
    editor.current.focus();
  }, [reveal]);

  return (
    <div className={styles.frame}>
      <div ref={host} className={styles.host} data-testid="pine-code" />
      {loading && <div className={styles.loading}>Loading the editor…</div>}
    </div>
  );
}
