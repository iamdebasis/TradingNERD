// The Pine corpus check (docs/SPEC.md §9, §4.17): real Pine scripts, from simple to very
// complex, through our engine. It downloads TradingView's Pine manual (its examples, from the
// manual's GitHub mirrors) and community collections of open-source indicators from GitHub
// into tools/pine-corpus/.cache (git ignores it: their licences don't let us publish them),
// then compiles each script and runs it over 600 bars, and reports what runs and what stops
// them. It never contacts tradingview.com.
//
//   node tools/pine-corpus/corpus.ts          fetch if needed, then run and report
//   node tools/pine-corpus/corpus.ts fetch    download or refresh the sources only
//   node tools/pine-corpus/corpus.ts convert  Convert code to v6 on every v5 script that runs
//   node tools/pine-corpus/corpus.ts show <id> one script, with the manual's words before it
//
// Opt-in, like the live tests: `pnpm test:corpus`.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Bar,
  parseResolution,
  resampleBars,
  resolutionDurationMs,
} from '../../packages/core/src/index.ts';
import {
  type ContextData,
  compileScript,
  convertToV6,
  DEFAULT_SYMBOL,
  type FromWorker,
  RemoteRun,
  type RequestFeed,
  ScriptHost,
  type ScriptProgram,
  ScriptRun,
  type ScriptSymbol,
  type ToWorker,
} from '../../packages/pine/src/index.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, '.cache');

/** Where the scripts come from (all public GitHub repositories). */
const SOURCES = [
  { name: 'manual-v6', repo: 'AndreHeinecke/pinescript_user_manual', kind: 'manual' },
  { name: 'manual-v6-split', repo: 'codenamedevan/pinescriptv6', kind: 'manual' },
  { name: 'everget', repo: 'everget/tradingview-pinescript-indicators', kind: 'community' },
  { name: 'quant-pine', repo: 'LouisLetcher/quant-pine', kind: 'community' },
  { name: 'pine-repo', repo: 'salbert11/pine_repo', kind: 'community' },
  { name: 'sbtnc', repo: 'sbtnc/tradingview-pinescript', kind: 'community' },
  { name: 'cryptorife', repo: 'cryptorife/pine-scripts', kind: 'community' },
  { name: 'codybbrown', repo: 'codybbrown/pinescript', kind: 'community' },
  { name: 'arunkbhaskar', repo: 'arunkbhaskar/pinescript', kind: 'community' },
  { name: 'tradefab', repo: 'TradeFab/Tradingview.public', kind: 'community' },
  // Added 2026-11-08, after a v4 script (VuManChu B) failed on a rule none of the above used:
  // more v3, v4 and v5 community scripts, and a large set of v6 indicators.
  { name: 'f13end', repo: 'f13end/tradingview-custom-indicators', kind: 'community' },
  { name: '800cherries', repo: '800cherries/Tradingview-Indicators', kind: 'community' },
  {
    name: 'harryguiacorn',
    repo: 'harryguiacorn/TradingView-Proprietary-Indicators',
    kind: 'community',
  },
  { name: 'mihakralj', repo: 'mihakralj/pinescript', kind: 'community' },
] as const;

/** Features by pattern, to tell which milestone a script needs (approximate, for planning). */
const FEATURES: Readonly<Record<string, RegExp>> = {
  drawings: /\b(label|line|box|table|polyline|linefill)\.|\bchart\.point/,
  // Other symbols, and an indicator on another timeframe (v5's timeframe =, v4's resolution =).
  request:
    /\brequest\.|\bsecurity\s*\(|\bfinancial\s*\(|\b(?:indicator|study)\s*\((?:[^()]|\([^()]*\))*?\b(?:timeframe|resolution)\s*=\s*(?!["']{2})/,
  strategies: /^\s*strategy\s*\(|\bstrategy\./m,
};

interface Script {
  id: string;
  corpus: 'manual' | 'community';
  source: string;
  path: string;
  text: string;
  /** Introduced in the manual as an error (the text before it, or its own comments, say so). */
  deliberate: boolean;
  /** The words that say so. */
  errorWords: string | null;
  /** Why it isn't a script TradingView could run as written, if it isn't one (see NOT_RUNNABLE). */
  notRunnable: string | null;
  /** For the manual's: its text just before the code. */
  before: string;
}

function fetchAll(): void {
  mkdirSync(join(CACHE, 'repos'), { recursive: true });
  for (const source of SOURCES) {
    const dir = join(CACHE, 'repos', source.name);
    if (existsSync(dir)) continue;
    console.log(`Downloading ${source.repo}…`);
    execFileSync(
      'git',
      ['clone', '--quiet', '--depth', '1', `https://github.com/${source.repo}.git`, dir],
      {
        stdio: 'inherit',
      },
    );
  }
}

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...files(path));
    else out.push(path);
  }
  return out;
}

const DECLARATION = /^\s*(indicator|study|strategy|library)\s*\(/m;
/**
 * The manual's words before an example that it gives as an error. Beyond the plain ones, its own
 * phrases: "will fail to compile", "generates the error", "will raise this error", 'gives an
 * "Undeclared identifier" error', and the error messages its Error messages page is headed by.
 */
const ERROR_INTRO =
  /(compil\w+ error|cause[sd]? an? error|raise[sd]? an? error|will (not|n't) compile|does(n't| not) compile|won't compile|not allowed|is invalid|error:|throws? an? error|runtime error|fails? to compile|generates? (the|an?|this) error|raises? (this|the) error|gives? an? [^.]{0,40}\berror\b|no viable alternative|mismatched input|could not be translated)/;
/**
 * Words that name an error without giving one: "does not raise an error" (its emphasis too: "it
 * *does not* raise an error"), "the risk of errors", what another version would do ("In Pine
 * v5, this script would cause a compilation error unless…"), and a script's own guard ("The
 * script triggers a runtime error if the chart's timeframe exceeds…").
 */
const NOT_AN_ERROR =
  /\b(does not|doesn't|do not|don't|will not|won't|without|never|no longer|avoid\w*|prevent\w*|risk of|reduc\w*)\**\s+(\w+\s+){0,3}?(an?\s+)?(compilation |runtime )?errors?\b|\bin pine v\d\b[^.]*|\b(triggers?|raises?) an? (custom )?(\[)?runtime error(\]\([^)]*\))? (if|when)\b[^.]*/g;

/**
 * The paragraph that introduces a code block: the last one before it, past any image. A fix
 * ("**Fix:** …") introduces a script that works.
 */
function introOf(text: string): string {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph && !/^!\[[^\]]*\]\([^)]*\)$/.test(paragraph));
  const last = (paragraphs.at(-1) ?? '').toLowerCase();
  const fix = /^\*{0,2}fix\b|\bto make this (example |script |code )?work\b/;
  return fix.test(last) ? '' : last.replace(NOT_AN_ERROR, '');
}

/** An example's own comment saying a line of it is the error, unless it says it no longer is. */
const errorComment = (script: string): string | undefined => {
  for (const line of script.split('\n')) {
    const at = line.indexOf('//');
    if (at < 0) continue;
    const words = ERROR_COMMENT.exec(line.slice(at).replace(NOT_AN_ERROR, ''))?.[0];
    if (words) return words.trim();
  }
  return undefined;
};

/** An example's own comment saying a line of it is the error ("// Raises an error."). */
const ERROR_COMMENT =
  /\/\/(?!.*\bif uncommented\b).*\b(compilation error\.|raises an error|causes? an? (compilation |runtime )?error|will cause an error|(will not|won't|does not|doesn't) compile)/i;
/**
 * Code that isn't a script TradingView could run as written, by what it is: indicator() read as
 * v1, a template with <placeholders>, the profiler's pseudo-code (System.timeNow()), or an
 * indicator that calls no output, which the manual says every indicator must ("Indicators must
 * call at least one function that creates a script output, such as plot(), … log.info(),
 * alert(), etc.").
 */
const NOT_RUNNABLE: readonly [string, (code: string, text: string) => boolean][] = [
  [
    // A mirror that dropped the //@version line: read as v1, which has no indicator() (the v6
    // reference, //@version=).
    'indicator() with no //@version line',
    (code, text) => /^\s*indicator\s*\(/m.test(code) && !/^\s*\/\/\s*@version\s*=/m.test(text),
  ],
  [
    'a template with <placeholders>',
    (code) => /(^|[\s(=,])<[A-Za-z_]+>/m.test(code.replace(/"[^"\n]*"|'[^'\n]*'/g, '""')),
  ],
  ['pseudo-code (System.timeNow())', (code) => /\bSystem\.\w+\s*\(/.test(code)],
  [
    'an indicator with no output, which TradingView refuses',
    (code) =>
      !/^\s*library\s*\(/m.test(code) &&
      !/\b(plot\w*|barcolor|bgcolor|hline|fill|alert|alertcondition|log\.(info|warning|error)|(label|line|box|table|polyline|linefill)\.new|strategy\.\w+)\s*\(/.test(
        code,
      ),
  ],
];
const SKIP = /\.(js|ts|mjs|cjs|json|py|md|png|jpe?g|gif|svg|html|css|ya?ml|lock|pdf)$/i;

/** The code without its comments, for the patterns above. */
const codeOf = (text: string) =>
  text
    .split('\n')
    .map((line) => (line.trim().startsWith('//') ? '' : line.split('//')[0]))
    .join('\n');

/**
 * A code block's scripts: the reference pages hold several in one block, each from its own
 * //@version line, or its declaration with the comments just above it. The mirror's leftover
 * reStructuredText (".. image::") isn't code.
 */
function scriptsIn(block: string): string[] {
  const lines = block.replace(/^\.\. image::.*$/gm, '').split('\n');
  const starts: number[] = [];
  let seenDeclaration = false;
  lines.forEach((line, i) => {
    const version = /^\/\/\s*@version\s*=\s*\d+/.test(line);
    const declaration = DECLARATION.test(line);
    if (!version && !(declaration && seenDeclaration)) {
      if (declaration) seenDeclaration = true;
      return;
    }
    // The script starts at its comments just above, unless a version line already started it.
    let start = i;
    while (start > 0 && /^\s*\/\//.test(lines[start - 1] as string)) start--;
    if (starts.at(-1) !== undefined && start <= (starts.at(-1) as number)) {
      seenDeclaration = declaration;
      return;
    }
    starts.push(start);
    seenDeclaration = declaration;
  });
  if (starts[0] !== 0) starts.unshift(0);
  return starts.map((start, i) => lines.slice(start, starts[i + 1] ?? lines.length).join('\n'));
}

function collect(): Script[] {
  const seen = new Set<string>();
  const scripts: Script[] = [];
  const add = (
    corpus: Script['corpus'],
    source: string,
    path: string,
    text: string,
    errorWords: string | null,
    before = '',
  ) => {
    const key = createHash('sha1').update(text.trim()).digest('hex');
    if (seen.has(key)) return;
    seen.add(key);
    scripts.push({
      id: `${corpus}-${scripts.length}`,
      corpus,
      source,
      path,
      text,
      deliberate: errorWords !== null,
      errorWords,
      notRunnable: null,
      before,
    });
  };
  for (const source of SOURCES) {
    const dir = join(CACHE, 'repos', source.name);
    if (!existsSync(dir)) continue;
    for (const path of files(dir)) {
      if (source.kind === 'manual') {
        if (!path.endsWith('.md')) continue;
        const text = readFileSync(path, 'utf8');
        let previousEnd = 0;
        for (const match of text.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)) {
          const at = match.index ?? 0;
          // The words that introduce this block: back to the block before it, at most 800
          // characters, so an example's fix isn't taken for the error shown before it.
          const before = text.slice(Math.max(previousEnd, at - 800), at);
          previousEnd = at + match[0].length;
          const block = (match[1] as string).replace(/\r\n/g, '\n');
          let first = true;
          for (const script of scriptsIn(block)) {
            if (!DECLARATION.test(script)) continue;
            const words =
              (first ? ERROR_INTRO.exec(introOf(before))?.[0] : undefined) ??
              errorComment(script) ??
              null;
            first = false;
            add('manual', source.name, relative(dir, path), script, words, before);
          }
        }
      } else {
        if (SKIP.test(path) || statSync(path).size > 400_000) continue;
        const text = readFileSync(path, 'utf8');
        if (DECLARATION.test(text))
          add('community', source.name, relative(dir, path), text.replace(/\r\n/g, '\n'), null);
      }
    }
  }
  return scripts;
}

/**
 * The libraries the corpus holds (the manual's own examples, such as its Point and Signal), by
 * name: scripts importing one get its code, as a user pastes it into My libraries.
 */
function librariesOf(scripts: readonly Script[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const script of scripts) {
    const name = /^\s*library\s*\(\s*(?:title\s*=\s*)?"([^"]+)"/m.exec(script.text)?.[1];
    if (name && !out.has(name) && !script.deliberate) out.set(name, script.text);
  }
  return out;
}

const IMPORT = /^\s*import\s+([\w-]+)\/(\w+)\/(\d+)/gm;

/** The libraries a script imports that the corpus doesn't hold: published on TradingView. */
function missingLibraries(text: string, libraries: ReadonlyMap<string, string>): string[] {
  return [...codeOf(text).matchAll(IMPORT)]
    .filter((m) => !libraries.has(m[2] as string))
    .map((m) => `${m[1]}/${m[2]}/${m[3]}`);
}

/** A script's code with the code of the corpus's libraries it imports, which run with it. */
function withLibraries(text: string, libraries: ReadonlyMap<string, string>): string {
  const imported = [...codeOf(text).matchAll(IMPORT)]
    .map((m) => libraries.get(m[2] as string))
    .filter((code): code is string => code !== undefined);
  return [text, ...imported].map(codeOf).join('\n');
}

/**
 * Marks the scripts TradingView couldn't run as written (NOT_RUNNABLE). A library's own plots
 * don't run in a script that imports it, but a call of its functions on a line of its own may
 * draw (the manual's PivotLabels), so such a script counts as having an output.
 */
function classify(scripts: Script[]): Map<string, string> {
  const libraries = librariesOf(scripts);
  for (const script of scripts) {
    const code = codeOf(script.text);
    const aliases = [...code.matchAll(/^\s*import\s+[\w-]+\/(\w+)\/\d+(?:\s+as\s+(\w+))?/gm)].map(
      (m) => (m[2] ?? m[1]) as string,
    );
    const callsLibrary = aliases.some((alias) =>
      new RegExp(`^\\s*${alias}\\.[\\w.]+\\s*\\(`, 'm').test(code),
    );
    script.notRunnable =
      NOT_RUNNABLE.find(
        ([why, test]) => test(code, script.text) && !(callsLibrary && why.includes('output')),
      )?.[0] ?? null;
  }
  return libraries;
}

const BARS = Array.from({ length: 600 }, (_, i) => {
  const open = 100 * (1 + 0.2 * Math.sin(i * 0.05) + 0.03 * Math.sin(i * 0.9));
  const close = 100 * (1 + 0.2 * Math.sin((i + 1) * 0.05) + 0.03 * Math.cos(i * 1.7));
  return {
    time: 1_600_000_000 + i * 86_400,
    open,
    high: Math.max(open, close) * 1.01,
    low: Math.min(open, close) * 0.99,
    close,
    volume: 1000 + ((i * 37) % 500),
  };
});

/**
 * Other symbols' and timeframes' bars for the scripts' requests (P4), made from BARS: a symbol's
 * prices scaled by a factor from its name, so two symbols differ; longer bars resampled from the
 * days; shorter ones split from the last days' (a smooth path through each day's open, high, low
 * and close), at most 20,000 of them. Every symbol exists; its history starts at its listing.
 */
const contexts = new Map<string, ContextData | null>();
const CORPUS_FEED: RequestFeed = {
  data(key) {
    const text = `${key.symbol}@${key.timeframe}`;
    if (contexts.has(text)) return contexts.get(text) ?? null;
    const resolution = parseResolution(key.timeframe);
    let data: ContextData | null = null;
    if (resolution && resolution.unit !== 'tick') {
      let hash = 0;
      for (const ch of key.symbol) hash = (hash * 31 + ch.charCodeAt(0)) % 1000;
      const k = key.symbol === '' ? 1 : 0.5 + hash / 666;
      const days = BARS.map((b) => ({
        ...b,
        open: b.open * k,
        high: b.high * k,
        low: b.low * k,
        close: b.close * k,
      }));
      const span = resolutionDurationMs(resolution);
      const bars =
        span !== null && span < 86_400_000 ? split(days, span) : resampleBars(days, resolution);
      const ticker = key.symbol.includes(':') ? (key.symbol.split(':')[1] as string) : key.symbol;
      data = {
        symbol: { ...DEFAULT_SYMBOL, ticker, tickerid: key.symbol, timeframe: key.timeframe },
        bars,
        live: true,
        fromListing: true,
        version: 1,
        history: 1,
      };
    }
    contexts.set(text, data);
    return data ?? 'invalid';
  },
  // Any currency into any other through one pair of their own (made, as the symbols are).
  rates: (from, to) => [{ symbol: `FX:${from}${to}`, invert: false }],
};

/**
 * An hourly chart over the last 25 days, cut from the same days the requests' bars are made
 * from: for scripts that refuse a daily chart (their own "the timeframe is smaller than the
 * chart's" error, as on TradingView with their default inputs).
 */
const HOURS = split(BARS, 3_600_000).slice(-600);
const HOURLY = { ...DEFAULT_SYMBOL, timeframe: '60' };

/** Shorter bars from the last days: each day's split into equal parts along a smooth path. */
function split(days: readonly Bar[], span: number): Bar[] {
  const per = Math.max(1, Math.round(86_400_000 / span));
  const take = Math.max(1, Math.min(days.length, Math.ceil(20_000 / per)));
  const out: Bar[] = [];
  for (const day of days.slice(-take)) {
    for (let j = 0; j < per; j++) {
      const at = (j: number) => {
        const t = j / per;
        // Open, then the high, the low, and the close at the day's end.
        const path = [day.open, day.high, day.low, day.close];
        const x = t * 3;
        const i = Math.min(2, Math.floor(x));
        const a = path[i] as number;
        const b = path[i + 1] as number;
        return a + (b - a) * (x - i);
      };
      const open = at(j);
      const close = at(j + 1);
      out.push({
        time: day.time + (j * span) / 1000,
        open,
        high: Math.max(open, close),
        low: Math.min(open, close),
        close,
        volume: day.volume / per,
      });
    }
  }
  return out.slice(-20_000);
}

function runOne(
  text: string,
  libraries: ReadonlyMap<string, string> = new Map(),
): { ok: boolean; stage: string; message: string } {
  try {
    const result = compileScript(text, {
      resolveLibrary: (_publisher, name) => libraries.get(name) ?? null,
    });
    if (!result.ok)
      return { ok: false, stage: 'compile', message: result.errors[0]?.message ?? '?' };
    let symbol: ScriptSymbol = DEFAULT_SYMBOL;
    let bars: readonly Bar[] = BARS;
    let run = new ScriptRun(result.program, result.program.defaults(), symbol, CORPUS_FEED);
    run.setBars(bars, true);
    if (run.error && /timeframe/i.test(run.error.message) && /chart/i.test(run.error.message)) {
      symbol = HOURLY;
      bars = HOURS;
      run = new ScriptRun(result.program, result.program.defaults(), symbol, CORPUS_FEED);
      run.setBars(bars, true);
    }
    // In the app each script runs in a worker of its own: through it, the same results. A script
    // that differs between two runs here (math.random()'s seed and timenow are each load's own)
    // can't be compared: it's counted apart.
    const rerun = () => {
      const next = new ScriptRun(result.program, result.program.defaults(), symbol, CORPUS_FEED);
      next.setBars(bars, true);
      return next;
    };
    if (resultsDiffer(run, rerun())) varying.push(text);
    else {
      const differs = workerDiffers(
        run,
        result.program,
        symbol,
        bars,
        importPaths(text, libraries),
      );
      // A script that follows the clock (timenow to a tenth of a second) can agree with itself
      // twice in a row and differ a moment later: run here again, after the worker's run, and it
      // differs from its first run too (manual-409, 2026-11-16). Only a worker that differs from
      // a run that keeps its results is a mismatch.
      if (differs && resultsDiffer(run, rerun())) varying.push(text);
      else if (differs) return { ok: false, stage: 'worker', message: differs };
      else {
        // A reload of the same run keeps the contexts a fresh run would give again (step 3):
        // it must show what the fresh run does. One that differs only as the clock does is
        // counted apart, as above.
        const reloaded = reloadDiffers(run, result.program, symbol, bars);
        if (reloaded && resultsDiffer(run, rerun())) varying.push(text);
        else if (reloaded) return { ok: false, stage: 'reload', message: reloaded };
      }
    }
    if (run.error) return { ok: false, stage: 'runtime', message: run.error.message };
    if (run.waiting) {
      return { ok: false, stage: 'data', message: `waiting for ${run.missing.length} contexts` };
    }
    return { ok: true, stage: 'ok', message: '' };
  } catch (error) {
    return {
      ok: false,
      stage: 'crash',
      message: String((error as Error).message ?? error).slice(0, 200),
    };
  }
}

/** The scripts whose two runs in the page differ (math.random(), timenow): not compared. */
const varying: string[] = [];

/** The code of each library a script imports, by its path as the app keeps them ("user/name/1"). */
function importPaths(text: string, libraries: ReadonlyMap<string, string>): Record<string, string> {
  const paths: Record<string, string> = {};
  for (const [, publisher, name, version] of withLibraries(text, libraries).matchAll(IMPORT)) {
    const code = libraries.get(name as string);
    if (code !== undefined) paths[`${publisher}/${name}/${version}`] = code;
  }
  return paths;
}

/**
 * The script again through a worker's two ends (docs/SPEC.md §6.23), each message copied as a
 * worker's are (structuredClone: V8's serializer, as Chrome's workers use): what differs from the
 * run in the page, or null. Its contexts reach the worker as the app sends them, so it loads
 * again while its requests name more (as the app runs a script again once their data is in).
 */
function workerDiffers(
  local: ScriptRun,
  program: ScriptProgram,
  symbol: ScriptSymbol,
  bars: readonly Bar[],
  libraries: Record<string, string>,
): string | null {
  let remote: RemoteRun | null = null;
  const host = new ScriptHost(
    (message, transfer) => remote?.receive(structuredClone(message, { transfer }) as FromWorker),
    { rates: CORPUS_FEED.rates },
  );
  remote = new RemoteRun(
    {
      post: (message, transfer) => host.receive(structuredClone(message, { transfer }) as ToWorker),
      close: () => {},
    },
    // As an alert's copy, so its alertcondition() values come back to compare too (step 2b).
    { program, inputs: program.defaults(), symbol, feed: CORPUS_FEED, libraries, alerts: true },
  );
  try {
    let asked = -1;
    for (let load = 0; load < 6 && remote.requested.length !== asked; load++) {
      asked = remote.requested.length;
      remote.setBars(bars, true);
    }
    return resultsDiffer(local, remote);
  } finally {
    remote.dispose();
  }
}

/**
 * Whether reloads in one run show what a fresh run does (step 3, docs/SPEC.md §6.18), its
 * requests' data changing as it does in the app or not at all. As the chart opens: its latest
 * half, and each context's latest half. Then the older pages are in: all the bars, every
 * context's history changed, so every context runs afresh. Then the same again: nothing changed,
 * so each context whose run a fresh run would give again is kept (requests.ts,
 * ContextStore.begin). And in another run, older chart bars while the contexts stay as they are.
 * What differs, or null.
 */
function reloadDiffers(
  fresh: ScriptRun,
  program: ScriptProgram,
  symbol: ScriptSymbol,
  bars: readonly Bar[],
): string | null {
  const half = <T>(list: readonly T[]): readonly T[] => list.slice(Math.floor(list.length / 2));
  let opening = true;
  const halves = new Map<ContextData, ContextData>();
  const feed: RequestFeed = {
    rates: CORPUS_FEED.rates,
    data: (key) => {
      const data = CORPUS_FEED.data(key);
      if (!opening || data === null || data === 'invalid') return data;
      let latest = halves.get(data);
      if (!latest) {
        latest = { ...data, bars: half(data.bars), history: 0 };
        halves.set(data, latest);
      }
      return latest;
    },
  };
  const run = new ScriptRun(program, program.defaults(), symbol, feed);
  run.setBars(half(bars), true);
  opening = false;
  run.setBars(bars, true);
  const paged = resultsDiffer(fresh, run);
  if (paged) return `after the older pages: ${paged}`;
  run.setBars(bars, true);
  const again = resultsDiffer(fresh, run);
  if (again) return `loaded again: ${again}`;
  const chartOnly = new ScriptRun(program, program.defaults(), symbol, CORPUS_FEED);
  chartOnly.setBars(half(bars), true);
  chartOnly.setBars(bars, true);
  const older = resultsDiffer(fresh, chartOnly);
  return older ? `after older chart bars: ${older}` : null;
}

/** The first way two runs' results differ, or null (NaN equal to NaN): the page's and another. */
function resultsDiffer(local: ScriptRun, remote: RemoteRun | ScriptRun): string | null {
  if (remote.length !== local.length) return `length ${remote.length} vs ${local.length}`;
  const outputs: [string, readonly (Float64Array | null)[], readonly (Float64Array | null)[]][] = [
    ['plot', local.values, remote.values],
    ['plot color', local.plotColors, remote.plotColors],
    ['background', local.backgrounds, remote.backgrounds],
    ['fill color', local.fillColors, remote.fillColors],
    ['alertcondition', local.conditions, remote.conditions],
  ];
  for (const [what, mine, theirs] of outputs) {
    if (mine.length !== theirs.length) return `${what}s: ${theirs.length} vs ${mine.length}`;
    for (let i = 0; i < mine.length; i++) {
      const a = mine[i];
      const b = theirs[i];
      if (!a || !b) {
        if (a !== b && (a ?? b)?.length) return `${what} ${i}: one has none`;
        continue;
      }
      for (let bar = 0; bar < local.length; bar++) {
        const x = a[bar] as number;
        const y = b[bar] as number;
        if (!(x === y || (Number.isNaN(x) && Number.isNaN(y)))) {
          return `${what} ${i} on bar ${bar}: ${y} vs ${x}`;
        }
      }
    }
  }
  const json = (value: unknown) => JSON.stringify(value);
  const untimed = (logs: ScriptRun['logs']) =>
    logs.map((entry) => (entry.realtime ? { ...entry, time: 0 } : entry));
  const bare = (objects: readonly object[]) =>
    objects.map((object) => ({ ...object, id: 0 }) as object);
  const drawings = (d: ScriptRun['drawings']) => [
    bare(d.labels),
    bare(d.lines),
    bare(d.boxes),
    bare(d.tables),
    bare(d.polylines),
    d.linefills.map((fill) => [fill.color, bare([fill.line1, fill.line2])]),
  ];
  const parts: [string, unknown, unknown][] = [
    [
      'starts',
      [local.plotStarts, local.backgroundStarts, local.fillStarts],
      [remote.plotStarts, remote.backgroundStarts, remote.fillStarts],
    ],
    ['offsets', local.offsets, remote.offsets],
    ['error', local.error?.message ?? null, remote.error?.message ?? null],
    ['missing', local.missing, remote.missing],
    ['requested', local.requested, remote.requested],
    ['drawings', drawings(local.drawings), drawings(remote.drawings)],
    ['strategy', local.strategy, remote.strategy],
    ['logs', untimed(local.logs), untimed(remote.logs)],
  ];
  for (const [what, mine, theirs] of parts) {
    if (json(mine) !== json(theirs)) return `${what} differ`;
  }
  return null;
}

/**
 * What a script needs beyond P2: drawings (P3), other symbols and timeframes (P4), strategies
 * (P5), or a library published on TradingView, whose code a user would paste into My libraries.
 */
function later(text: string, libraries: ReadonlyMap<string, string>): string[] {
  const code = withLibraries(text, libraries);
  const needs = Object.entries(FEATURES)
    .filter(([, pattern]) => pattern.test(code))
    .map(([name]) => name);
  if (missingLibraries(text, libraries).length > 0) needs.push('published library');
  return needs;
}

function report(scripts: Script[]): void {
  const libraries = classify(scripts);
  const results = scripts.map((script) => ({
    script,
    needs: later(script.text, libraries),
    ...runOne(script.text, libraries),
  }));
  const kinds = new Map<string, number>();
  const p4kinds = new Map<string, number>();
  for (const corpus of ['manual', 'community'] as const) {
    const mine = results.filter(
      (r) => r.script.corpus === corpus && !r.script.deliberate && !r.script.notRunnable,
    );
    const p2 = mine.filter((r) => r.needs.length === 0);
    const p4 = mine.filter((r) => r.needs.length === 1 && r.needs[0] === 'request');
    const ok = mine.filter((r) => r.ok).length;
    const p2ok = p2.filter((r) => r.ok).length;
    const p4ok = p4.filter((r) => r.ok).length;
    const share = (n: number, of: number) => `${((100 * n) / Math.max(1, of)).toFixed(1)}%`;
    console.log(
      `${corpus}: ${ok} of ${mine.length} run (${share(ok, mine.length)}); ` +
        `of the ${p2.length} that need only P2's features, ${p2ok} (${share(p2ok, p2.length)}); ` +
        `of the ${p4.length} that need P4's requests too, ${p4ok} (${share(p4ok, p4.length)})`,
    );
    for (const r of p4) {
      if (r.ok) continue;
      const kind = `P4 ${r.stage}: ${r.message
        .replace(/"[^"]*"/g, '"…"')
        .replace(/'[^']*'/g, "'…'")
        .replace(/\d+/g, 'N')}`.slice(0, 110);
      p4kinds.set(kind, (p4kinds.get(kind) ?? 0) + 1);
    }
    for (const r of p2) {
      if (r.ok) continue;
      const kind = `${r.stage}: ${r.message
        .replace(/"[^"]*"/g, '"…"')
        .replace(/'[^']*'/g, "'…'")
        .replace(/\d+/g, 'N')}`.slice(0, 110);
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    }
  }
  console.log(
    `Through a worker as in the app, and reloaded with older bars in the same run: every script that runs gives the same results, but the ${varying.length} that differ from run to run in the page too (math.random(), timenow), which aren't compared`,
  );
  // The manual's error examples should stop here as they do on TradingView.
  const errors = results.filter((r) => r.script.deliberate);
  const accepted = errors.filter((r) => r.ok);
  console.log(
    `\nThe manual's ${errors.length} error examples: ${errors.length - accepted.length} stop here too` +
      (accepted.length ? `; these run anyway: ${accepted.map((r) => r.script.id).join(', ')}` : ''),
  );
  const notRunnable = new Map<string, string[]>();
  for (const r of results) {
    if (!r.script.notRunnable || r.script.deliberate) continue;
    notRunnable.set(r.script.notRunnable, [
      ...(notRunnable.get(r.script.notRunnable) ?? []),
      r.script.id,
    ]);
  }
  for (const [why, ids] of notRunnable) console.log(`Not counted, ${why}: ${ids.join(', ')}`);
  console.log('\nWhat stops the scripts that need only P2:');
  for (const [kind, n] of [...kinds].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
    console.log(`${String(n).padStart(5)}  ${kind}`);
  }
  console.log("\nWhat stops the scripts that need P4's requests:");
  for (const [kind, n] of [...p4kinds].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
    console.log(`${String(n).padStart(5)}  ${kind}`);
  }
  const commits = Object.fromEntries(
    SOURCES.filter((s) => existsSync(join(CACHE, 'repos', s.name))).map((s) => [
      s.repo,
      execFileSync('git', ['-C', join(CACHE, 'repos', s.name), 'rev-parse', 'HEAD'])
        .toString()
        .trim(),
    ]),
  );
  writeFileSync(
    join(CACHE, 'report.json'),
    JSON.stringify(
      {
        commits,
        results: results.map((r) => ({
          id: r.script.id,
          source: r.script.source,
          path: r.script.path,
          deliberate: r.script.deliberate,
          errorWords: r.script.errorWords,
          notRunnable: r.script.notRunnable,
          needs: r.needs,
          stage: r.stage,
          message: r.message,
        })),
      },
      null,
      1,
    ),
  );
  console.log(`\nEvery script's result: ${relative(process.cwd(), join(CACHE, 'report.json'))}`);
}

/**
 * Convert code to v6 on every v5 script that runs here: each must compile as v6 and give the
 * same values on every bar, but where the guide says v6 changes what code does (lazy and/or,
 * "1D" for "D", the colors v6 changed, a literal's history on the first bar).
 */
function convertAll(scripts: Script[]): void {
  const libraries = classify(scripts);
  const resolveLibrary = (_publisher: string, name: string) => libraries.get(name) ?? null;
  const values = (text: string) => {
    const result = compileScript(text, { resolveLibrary });
    if (!result.ok) return null;
    const run = new ScriptRun(result.program, result.program.defaults());
    run.setBars(BARS, true);
    if (run.error) return null;
    return run.values.map((v) => Array.from(v.subarray(0, BARS.length)));
  };
  let tried = 0;
  let same = 0;
  const failed: string[] = [];
  const differ: string[] = [];
  for (const script of scripts) {
    if (!/^\s*\/\/\s*@version\s*=\s*5\b/m.test(script.text)) continue;
    const before = values(script.text);
    if (!before) continue;
    tried++;
    const converted = convertToV6(script.text, { resolveLibrary });
    if (!converted.ok || converted.errors.length > 0) {
      failed.push(
        `${script.id}: ${converted.errors[0]?.message ?? (converted.ok ? '' : converted.reason)}`,
      );
      continue;
    }
    const after = values(converted.source);
    const equal =
      after !== null &&
      after.length === before.length &&
      before.every((plot, i) =>
        plot.every((x, k) => {
          const y = after[i]?.[k] as number;
          return Number.isNaN(x)
            ? Number.isNaN(y)
            : Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x));
        }),
      );
    if (equal) same++;
    else differ.push(script.id);
  }
  console.log(`v5 scripts that run: ${tried}; converted with the same values: ${same}`);
  if (failed.length) console.log(`Converted with errors left:\n  ${failed.join('\n  ')}`);
  if (differ.length) console.log(`Converted, values differ: ${differ.join(', ')}`);
}

fetchAll();
if (process.argv[2] === 'convert') {
  convertAll(collect());
} else if (process.argv[2] === 'show') {
  // One script with the manual's words before it: `node tools/pine-corpus/corpus.ts show manual-61`.
  const scripts = collect();
  const libraries = classify(scripts);
  const script = scripts.find((item) => item.id === process.argv[3]);
  if (!script) throw new Error(`No script ${process.argv[3]}`);
  const marks = [
    script.errorWords ? `an error example ("${script.errorWords}")` : '',
    script.notRunnable ?? '',
  ];
  console.log(
    `${script.id} · ${script.source} · ${script.path} ${marks.filter(Boolean).join(', ')}\n`,
  );
  if (script.before) console.log(`${script.before.trim()}\n\n----`);
  console.log(script.text);
  console.log(`----\n${JSON.stringify(runOne(script.text, libraries))}`);
} else if (process.argv[2] !== 'fetch') {
  report(collect());
}
