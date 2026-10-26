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
import { CloseIcon, StarIcon } from '../toolbar/icons';
import styles from './IndicatorsDialog.module.css';
import { SearchIcon } from './icons';
import { favoriteIndicators, useFavoriteIndicators } from './indicatorStore';

/** The side list: TradingView's Favorites, and its built-ins under Technicals → Indicators. */
type Section = 'favorites' | 'technicals';

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

  const rows = useMemo((): readonly IndicatorDefinition[] => {
    if (query.trim() !== '') return searchIndicators(query);
    if (section === 'favorites') {
      return INDICATORS.filter((definition) => favorites.includes(definition.kind));
    }
    return INDICATORS;
  }, [query, section, favorites]);

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

  const add = (definition: IndicatorDefinition) => {
    onAdd(definition.kind);
    // A short note that it was added, as the dialog stays open for more.
    setAdded(definition.name);
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
              {rows.map((definition, i) => {
                const starred = favorites.includes(definition.kind);
                return (
                  <div
                    key={definition.kind}
                    id={`${id}-row-${i}`}
                    className={styles.row}
                    role="option"
                    aria-selected={i === active}
                    tabIndex={-1}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => add(definition)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') add(definition);
                    }}
                  >
                    <button
                      type="button"
                      className={styles.star}
                      data-starred={starred || undefined}
                      aria-label={starred ? 'Remove from favorites' : 'Add to favorites'}
                      aria-pressed={starred}
                      onClick={(event) => {
                        event.stopPropagation();
                        favoriteIndicators.toggle(definition.kind);
                        input.current?.focus();
                      }}
                    >
                      <StarIcon filled={starred} />
                    </button>
                    <span className={styles.name}>{definition.name}</span>
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
