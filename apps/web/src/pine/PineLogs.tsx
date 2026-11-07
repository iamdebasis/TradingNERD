import { TimeZone } from '@tradingnerd/core';
import type { LogEntry } from '@tradingnerd/pine';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { definitionOf } from '../indicators/definitions';
import { useIndicators } from '../indicators/indicatorStore';
import { CloseIcon } from '../toolbar/icons';
import {
  ChevronIcon,
  ClockIcon,
  CodeBracesIcon,
  MoreIcon,
  OptionsIcon,
  PauseIcon,
  ResumeIcon,
  SearchIcon,
  TargetIcon,
} from './icons';
import {
  type LogLevels,
  type LogQuery,
  logMatcher,
  logTime,
  setStartLabel,
  shownLogs,
  startLabel,
  zonedInstant,
} from './logFormat';
import { logsStore, useLogs } from './logsStore';
import styles from './PineLogs.module.css';

const LEVELS: readonly { level: LogEntry['level']; label: string }[] = [
  { level: 'info', label: 'Info' },
  { level: 'warning', label: 'Warning' },
  { level: 'error', label: 'Error' },
];

/**
 * The Pine Logs pane, as TradingView's (Pine docs, Debugging: Pine Logs, Figures 346 to 358):
 * the logging script's title as a dropdown of the chart's scripts with logs, and Close; Pause;
 * Search with Match case, Whole Word and Regex, its matches in blue; Start date, shown as a tag
 * above the entries; and Filter levels. Each entry is its timestamp and message, gray, orange or
 * red by level, with Source code and Scroll to bar on hover. Its sizes and colors are
 * provisional until measured (docs/SPEC.md §11).
 */
export function PineLogs({
  onClose,
  onSource,
}: {
  onClose(): void;
  /** An entry's Source code: its script in the Pine Editor, at the entry's line. */
  onSource(id: string, line: number): void;
}) {
  const state = useLogs();
  const indicators = useIndicators();
  const shown = state.scripts.find((item) => item.id === state.selected) ?? state.scripts[0];
  const zone = useMemo(() => new TimeZone(state.zone), [state.zone]);
  const titleOf = (id: string) => {
    const indicator = indicators.list.find((item) => item.id === id);
    return indicator ? definitionOf(indicator).shortName : id;
  };

  const [pickerOpen, setPickerOpen] = useState(false);
  const [levelsOpen, setLevelsOpen] = useState(false);
  const [levels, setLevels] = useState<LogLevels>({ info: true, warning: true, error: true });
  const [searchOpen, setSearchOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [query, setQuery] = useState<LogQuery>({
    text: '',
    matchCase: false,
    wholeWord: false,
    regex: false,
  });
  const [startOpen, setStartOpen] = useState(false);
  const [start, setStart] = useState<number | null>(null);
  /** While paused, the count of messages written when it paused: later ones wait. */
  const [pausedAt, setPausedAt] = useState<number | null>(null);

  const matcher = useMemo(() => logMatcher(query), [query]);
  const written = shown?.written ?? 0;
  const logs = shown?.logs ?? [];
  const rows = useMemo(() => {
    // The entries up to the pause: each entry's number counts from the run's first message.
    const first = written - logs.length;
    const kept = pausedAt === null ? logs : logs.slice(0, Math.max(0, pausedAt - first));
    return shownLogs(kept, levels, start, typeof matcher === 'function' ? matcher : null).map(
      (row) => ({ ...row, key: first + row.index }),
    );
  }, [logs, written, levels, start, matcher, pausedAt]);

  // The newest entry stays in view while the list is scrolled to its end.
  const list = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: new rows are the change
  useLayoutEffect(() => {
    const element = list.current;
    if (element && atEnd.current) element.scrollTop = element.scrollHeight;
  }, [rows]);

  const closeMenus = () => {
    setPickerOpen(false);
    setLevelsOpen(false);
    setOptionsOpen(false);
  };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPickerOpen(false);
        setLevelsOpen(false);
        setOptionsOpen(false);
        setStartOpen(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <section className={styles.pane} aria-label="Pine Logs" data-testid="pine-logs">
      <header className={styles.top}>
        <div className={styles.pickerWrap}>
          <button
            type="button"
            className={styles.title}
            aria-haspopup="listbox"
            aria-expanded={pickerOpen}
            disabled={state.scripts.length === 0}
            onClick={() => {
              closeMenus();
              setPickerOpen(!pickerOpen);
            }}
            data-testid="pine-logs-title"
          >
            {shown ? titleOf(shown.id) : 'Pine Logs'}
            {state.scripts.length > 0 && <ChevronIcon />}
          </button>
          {pickerOpen && (
            <div className={styles.popup} role="listbox" aria-label="Scripts with logs">
              <div className={styles.heading}>Scripts with logs</div>
              {state.scripts.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={item.id === shown?.id}
                  className={styles.option}
                  onClick={() => {
                    logsStore.select(item.id);
                    setPickerOpen(false);
                  }}
                >
                  {titleOf(item.id)}
                </button>
              ))}
            </div>
          )}
        </div>
        <span className={styles.spacer} />
        <button
          type="button"
          className={styles.iconButton}
          aria-label="Close Pine Logs"
          title="Close"
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </header>
      <div className={styles.tools}>
        <button
          type="button"
          className={styles.iconButton}
          aria-label={pausedAt === null ? 'Pause' : 'Resume'}
          title={pausedAt === null ? 'Pause' : 'Resume'}
          aria-pressed={pausedAt !== null}
          onClick={() => setPausedAt(pausedAt === null ? written : null)}
        >
          {pausedAt === null ? <PauseIcon /> : <ResumeIcon />}
        </button>
        <span className={styles.spacer} />
        <button
          type="button"
          className={styles.iconButton}
          aria-label="Search"
          title="Search"
          aria-pressed={searchOpen}
          onClick={() => {
            closeMenus();
            setSearchOpen(!searchOpen);
          }}
        >
          <SearchIcon />
        </button>
        <button
          type="button"
          className={styles.iconButton}
          aria-label="Start date"
          title="Start date"
          aria-pressed={startOpen}
          onClick={() => {
            closeMenus();
            setStartOpen(!startOpen);
          }}
        >
          <ClockIcon />
        </button>
        <div className={styles.menuWrap}>
          <button
            type="button"
            className={styles.iconButton}
            aria-label="Filter levels"
            title="Filter levels"
            aria-haspopup="menu"
            aria-expanded={levelsOpen}
            onClick={() => {
              closeMenus();
              setLevelsOpen(!levelsOpen);
            }}
          >
            <MoreIcon />
          </button>
          {levelsOpen && (
            <div
              className={`${styles.popup} ${styles.right}`}
              role="menu"
              aria-label="Filter levels"
            >
              <div className={styles.heading}>Filter levels</div>
              {LEVELS.map(({ level, label }) => (
                <label key={level} className={styles.check}>
                  <input
                    type="checkbox"
                    checked={levels[level]}
                    onChange={(event) => setLevels({ ...levels, [level]: event.target.checked })}
                  />
                  {label}
                </label>
              ))}
            </div>
          )}
        </div>
        {startOpen && (
          <StartDate
            zone={zone}
            initial={start ?? logs.at(-1)?.time ?? Date.now()}
            onSet={(time) => {
              setStart(time);
              setStartOpen(false);
            }}
            onClose={() => setStartOpen(false)}
          />
        )}
      </div>
      {searchOpen && (
        <div className={styles.search}>
          <SearchIcon />
          <input
            className={styles.searchInput}
            aria-label="Search logs"
            aria-invalid={matcher === 'invalid'}
            // biome-ignore lint/a11y/noAutofocus: opening the search is asking to type
            autoFocus
            value={query.text}
            onChange={(event) => setQuery({ ...query, text: event.target.value })}
          />
          {query.text && (
            <button
              type="button"
              className={styles.iconButton}
              aria-label="Clear search"
              title="Clear"
              onClick={() => setQuery({ ...query, text: '' })}
            >
              <CloseIcon />
            </button>
          )}
          <div className={styles.menuWrap}>
            <button
              type="button"
              className={styles.iconButton}
              aria-label="Search options"
              title="Search options"
              aria-haspopup="menu"
              aria-expanded={optionsOpen}
              onClick={() => setOptionsOpen(!optionsOpen)}
            >
              <OptionsIcon />
            </button>
            {optionsOpen && (
              <div
                className={`${styles.popup} ${styles.right}`}
                role="menu"
                aria-label="Search options"
              >
                {(
                  [
                    ['matchCase', 'Match case'],
                    ['wholeWord', 'Whole Word'],
                    ['regex', 'Regex'],
                  ] as const
                ).map(([option, label]) => (
                  <label key={option} className={styles.check}>
                    <input
                      type="checkbox"
                      checked={query[option]}
                      onChange={(event) => setQuery({ ...query, [option]: event.target.checked })}
                    />
                    {label}
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      {start !== null && (
        <div className={styles.tags}>
          <span className={styles.tag} data-testid="pine-logs-start">
            <ClockIcon />
            {startLabel(start, zone)}
            <button
              type="button"
              className={styles.tagClear}
              aria-label="Clear start date"
              onClick={() => setStart(null)}
            >
              <CloseIcon />
            </button>
          </span>
        </div>
      )}
      <div
        ref={list}
        className={styles.entries}
        role="log"
        aria-label="Logs"
        onScroll={(event) => {
          const element = event.currentTarget;
          atEnd.current = element.scrollTop + element.clientHeight >= element.scrollHeight - 4;
        }}
      >
        {!shown ? (
          <p className={styles.note}>
            Scripts on the chart that call log.info(), log.warning() or log.error() show their logs
            here.
          </p>
        ) : rows.length === 0 ? (
          <p className={styles.note}>{logs.length === 0 ? 'No logs yet' : 'No logs match'}</p>
        ) : (
          rows.map((row) => (
            <LogRow
              key={row.key}
              entry={row.entry}
              matches={row.matches}
              zone={zone}
              onSource={(line) => onSource(shown.id, line)}
            />
          ))
        )}
      </div>
    </section>
  );
}

/** One entry: "[timestamp]: message", its matches in blue; Source code and Scroll to bar. */
const LogRow = memo(function LogRow({
  entry,
  matches,
  zone,
  onSource,
}: {
  entry: LogEntry;
  matches: [number, number][] | null;
  zone: TimeZone;
  onSource(line: number): void;
}) {
  const parts: (string | { text: string })[] = [];
  let at = 0;
  for (const [from, to] of matches ?? []) {
    if (from > at) parts.push(entry.message.slice(at, from));
    parts.push({ text: entry.message.slice(from, to) });
    at = to;
  }
  if (at < entry.message.length) parts.push(entry.message.slice(at));
  return (
    <div className={styles.entry} data-level={entry.level} data-testid="pine-log">
      <span className={styles.text}>
        [{logTime(entry.time, zone)}]:{' '}
        {parts.map((part, i) =>
          typeof part === 'string' ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: a message's parts never move
            <span key={i}>{part}</span>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: a message's parts never move
            <mark key={i} className={styles.match}>
              {part.text}
            </mark>
          ),
        )}
      </span>
      <span className={styles.actions}>
        {entry.line !== null && (
          <button
            type="button"
            className={styles.rowButton}
            aria-label="Source code"
            title="Source code"
            onClick={() => onSource(entry.line as number)}
          >
            <CodeBracesIcon />
          </button>
        )}
        <button
          type="button"
          className={styles.rowButton}
          aria-label="Scroll to bar"
          title="Scroll to bar"
          onClick={() => logsStore.scrollToBar(entry)}
        >
          <TargetIcon />
        </button>
      </span>
    </div>
  );
});

/**
 * Start date (Figure 356): the date and time of the first entry shown, in the chart symbol's
 * time zone. The browser's own date picker stands in for TradingView's calendar (provisional).
 */
function StartDate({
  zone,
  initial,
  onSet,
  onClose,
}: {
  zone: TimeZone;
  initial: number;
  onSet(time: number): void;
  onClose(): void;
}) {
  const local = new Date(initial + zone.offset(initial));
  const pad = (value: number) => String(value).padStart(2, '0');
  const [date, setDate] = useState(
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`,
  );
  const [time, setTime] = useState('00:00');
  const instant = zonedInstant(date, time, zone);
  return (
    <div className={styles.startDate} role="dialog" aria-label="Start date">
      <div className={styles.startTop}>
        <span>Start date</span>
        <button type="button" className={styles.iconButton} aria-label="Close" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      <div className={styles.startFields}>
        <input
          type="date"
          className={styles.field}
          aria-label="Date"
          value={date}
          onChange={(event) => setDate(event.target.value)}
        />
        <input
          type="time"
          className={styles.field}
          aria-label="Time"
          value={time}
          onChange={(event) => setTime(event.target.value)}
        />
      </div>
      <button
        type="button"
        className={styles.setButton}
        disabled={instant === null}
        onClick={() => instant !== null && onSet(instant)}
      >
        {instant === null ? 'Set' : setStartLabel(instant, zone)}
      </button>
    </div>
  );
}
