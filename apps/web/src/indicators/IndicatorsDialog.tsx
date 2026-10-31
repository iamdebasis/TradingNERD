import type { ScriptSummary } from '@tradingnerd/core';
import {
  INDICATORS,
  type IndicatorDefinition,
  type IndicatorKind,
  searchIndicators,
} from '@tradingnerd/indicators';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { scriptsApi } from '../data/api';
import { CloseIcon, StarIcon } from '../toolbar/icons';
import styles from './IndicatorsDialog.module.css';
import { SearchIcon } from './icons';
import { favoriteIndicators, indicatorStore, useFavoriteIndicators } from './indicatorStore';

/**
 * The side list: TradingView's Favorites, My scripts under Personal, and its built-ins under
 * Technicals → Indicators.
 */
type Section = 'favorites' | 'mine' | 'technicals';

/** A row: a built-in, or one of My scripts. */
type Row =
  | { kind: 'builtin'; definition: IndicatorDefinition }
  | { kind: 'script'; script: ScriptSummary };

const kindOf = (definition: IndicatorDefinition) => definition.kind as IndicatorKind;

/** Puts one of My scripts on the chart, its latest saved code. */
async function addSaved(script: ScriptSummary): Promise<void> {
  const saved = await scriptsApi.get(script.id);
  indicatorStore.addScript({ source: saved.source, scriptId: saved.id, from: saved.from });
}

/**
 * TradingView's "Indicators, metrics, and strategies" dialog (Pine docs, First steps): a search
 * field, a side list (Favorites; Technicals with its Indicators tab) and the scripts. A click or
 * Enter adds one and the dialog stays open for more; ☆ stars it; ↑/↓ move, Escape closes.
 * Its look is provisional until measured from a screenshot (docs/SPEC.md §11).
 */
export function IndicatorsDialog({
  onAdd,
  onClose,
}: {
  onAdd(kind: IndicatorKind): void;
  onClose(): void;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const favorites = useFavoriteIndicators();
  const [query, setQuery] = useState('');
  const [section, setSection] = useState<Section>(
    favorites.length > 0 ? 'favorites' : 'technicals',
  );
  const [active, setActive] = useState(0);
  const [added, setAdded] = useState<string | null>(null);
  /** My scripts, from the gateway; null until they come. */
  const [mine, setMine] = useState<readonly ScriptSummary[] | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    scriptsApi.index(abort.signal).then(
      (index) => setMine(index.scripts),
      () => setMine([]),
    );
    return () => abort.abort();
  }, []);

  const rows = useMemo((): readonly Row[] => {
    const builtins = (list: readonly IndicatorDefinition[]): Row[] =>
      list.map((definition) => ({ kind: 'builtin', definition }));
    const scripts = (list: readonly ScriptSummary[]): Row[] =>
      list.map((script) => ({ kind: 'script', script }));
    const text = query.trim().toLowerCase();
    if (text !== '') {
      const matching = (mine ?? []).filter((script) => script.name.toLowerCase().includes(text));
      return [...builtins(searchIndicators(query)), ...scripts(matching)];
    }
    if (section === 'favorites') {
      return builtins(INDICATORS.filter((definition) => favorites.includes(kindOf(definition))));
    }
    if (section === 'mine') return scripts(mine ?? []);
    return builtins(INDICATORS);
  }, [query, section, favorites, mine]);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    input.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      onCloseRef.current();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const add = (row: Row) => {
    if (row.kind === 'builtin') {
      onAdd(kindOf(row.definition));
      // A short note that it was added, as the dialog stays open for more.
      setAdded(row.definition.name);
      return;
    }
    addSaved(row.script).then(
      () => setAdded(row.script.name),
      () => setAdded(null),
    );
  };

  const onInputKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (rows.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((current) => (current + step + rows.length) % rows.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const row = rows[Math.min(active, rows.length - 1)];
      if (row) add(row);
    }
  };

  const showing = query.trim() !== '' ? 'search' : section;
  const empty =
    showing === 'favorites'
      ? 'Star an indicator to see it here'
      : showing === 'search'
        ? 'No indicators match your criteria'
        : showing === 'mine'
          ? mine === null
            ? 'Loading…'
            : 'Save a script in the Pine Editor to see it here'
          : '';

  return createPortal(
    <div className={styles.backdrop}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
      >
        <div className={styles.titleRow}>
          <h2 id={`${id}-title`} className={styles.title}>
            Indicators, metrics, and strategies
          </h2>
          <button type="button" className={styles.close} aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <label className={styles.searchField}>
          <span className={styles.searchIcon}>
            <SearchIcon />
          </span>
          <input
            ref={input}
            className={styles.input}
            type="text"
            placeholder="Search"
            aria-label="Search indicators"
            aria-controls={`${id}-list`}
            aria-activedescendant={rows.length > 0 ? `${id}-row-${active}` : undefined}
            spellCheck={false}
            autoComplete="off"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={onInputKey}
          />
        </label>
        <div className={styles.body}>
          <nav className={styles.side} aria-label="Scripts">
            <button
              type="button"
              className={styles.sideItem}
              aria-current={showing === 'favorites' ? 'page' : undefined}
              onClick={() => {
                setQuery('');
                setSection('favorites');
                setActive(0);
                input.current?.focus();
              }}
            >
              <StarIcon filled={false} />
              Favorites
            </button>
            <h3 className={styles.sideHeading}>Personal</h3>
            <button
              type="button"
              className={styles.sideItem}
              aria-current={showing === 'mine' ? 'page' : undefined}
              onClick={() => {
                setQuery('');
                setSection('mine');
                setActive(0);
                input.current?.focus();
              }}
            >
              <ScriptIcon />
              My scripts
            </button>
            <h3 className={styles.sideHeading}>Built-in</h3>
            <button
              type="button"
              className={styles.sideItem}
              aria-current={showing === 'technicals' ? 'page' : undefined}
              onClick={() => {
                setQuery('');
                setSection('technicals');
                setActive(0);
                input.current?.focus();
              }}
            >
              <TechnicalsIcon />
              Technicals
            </button>
          </nav>
          <section className={styles.main} aria-label="Indicators">
            {showing === 'technicals' && (
              <div className={styles.chips}>
                <span className={styles.chip} aria-current="page">
                  Indicators
                </span>
              </div>
            )}
            <div className={styles.header}>Script name</div>
            <div id={`${id}-list`} className={styles.list} role="listbox" aria-label="Indicators">
              {rows.map((row, i) => {
                const builtin = row.kind === 'builtin' ? kindOf(row.definition) : null;
                const starred = builtin !== null && favorites.includes(builtin);
                const name = row.kind === 'builtin' ? row.definition.name : row.script.name;
                return (
                  <div
                    key={builtin ?? (row.kind === 'script' ? row.script.id : name)}
                    id={`${id}-row-${i}`}
                    className={styles.row}
                    role="option"
                    aria-selected={i === active}
                    tabIndex={-1}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => add(row)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') add(row);
                    }}
                  >
                    {builtin ? (
                      <button
                        type="button"
                        className={styles.star}
                        data-starred={starred || undefined}
                        aria-label={starred ? 'Remove from favorites' : 'Add to favorites'}
                        aria-pressed={starred}
                        onClick={(event) => {
                          event.stopPropagation();
                          favoriteIndicators.toggle(builtin);
                          input.current?.focus();
                        }}
                      >
                        <StarIcon filled={starred} />
                      </button>
                    ) : (
                      <span className={styles.star} aria-hidden />
                    )}
                    <span className={styles.name}>{name}</span>
                  </div>
                );
              })}
              {rows.length === 0 && empty && <div className={styles.empty}>{empty}</div>}
            </div>
            <output className={styles.added} aria-live="polite">
              {added ? `${added} added to the chart` : ''}
            </output>
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** My scripts: a page of code. */
function ScriptIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4.5 1.5h6l3 3v12h-9zM10.5 1.5v3h3M7.5 8.5 6 10l1.5 1.5M10.5 8.5 12 10l-1.5 1.5" />
    </svg>
  );
}

/** Technicals: a small line chart. */
function TechnicalsIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M1.5 15.5h15M2.5 12l4-5 3.5 3 5.5-7" />
    </svg>
  );
}
