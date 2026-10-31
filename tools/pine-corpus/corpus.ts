// The Pine corpus check (docs/SPEC.md §9, §4.17): real Pine scripts, from simple to very
// complex, through our engine. It downloads TradingView's Pine manual (its examples, from the
// manual's GitHub mirrors) and community collections of open-source indicators from GitHub
// into tools/pine-corpus/.cache (git ignores it: their licences don't let us publish them),
// then compiles each script and runs it over 600 bars, and reports what runs and what stops
// them. It never contacts tradingview.com.
//
//   node tools/pine-corpus/corpus.ts          fetch if needed, then run and report
//   node tools/pine-corpus/corpus.ts fetch    download or refresh the sources only
//
// Opt-in, like the live tests: `pnpm test:corpus`.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileScript, ScriptRun } from '../../packages/pine/src/index.ts';

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
] as const;

/** Features by pattern, to tell which milestone a script needs (approximate, for planning). */
const FEATURES: Readonly<Record<string, RegExp>> = {
  drawings: /\b(label|line|box|table|polyline|linefill)\.|\bchart\.point/,
  request: /\brequest\.|\bsecurity\s*\(|\bfinancial\s*\(/,
  strategies: /^\s*strategy\s*\(|\bstrategy\./m,
};

interface Script {
  id: string;
  corpus: 'manual' | 'community';
  source: string;
  path: string;
  text: string;
  /** Introduced in the manual as an error (the code before it says so). */
  deliberate: boolean;
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
const ERROR_INTRO =
  /(compil\w+ error|cause[sd]? an? error|raise[sd]? an? error|will (not|n't) compile|does(n't| not) compile|won't compile|not allowed|is invalid|error:|throws? an? error|runtime error)/;
const SKIP = /\.(js|ts|mjs|cjs|json|py|md|png|jpe?g|gif|svg|html|css|ya?ml|lock|pdf)$/i;

function collect(): Script[] {
  const seen = new Set<string>();
  const scripts: Script[] = [];
  const add = (
    corpus: Script['corpus'],
    source: string,
    path: string,
    text: string,
    deliberate: boolean,
  ) => {
    const key = createHash('sha1').update(text.trim()).digest('hex');
    if (seen.has(key)) return;
    seen.add(key);
    scripts.push({ id: `${corpus}-${scripts.length}`, corpus, source, path, text, deliberate });
  };
  for (const source of SOURCES) {
    const dir = join(CACHE, 'repos', source.name);
    if (!existsSync(dir)) continue;
    for (const path of files(dir)) {
      if (source.kind === 'manual') {
        if (!path.endsWith('.md')) continue;
        const text = readFileSync(path, 'utf8');
        for (const match of text.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)) {
          const block = (match[1] as string).replace(/\r\n/g, '\n');
          if (!DECLARATION.test(block)) continue;
          const before = text
            .slice(Math.max(0, (match.index ?? 0) - 500), match.index)
            .toLowerCase();
          add('manual', source.name, relative(dir, path), block, ERROR_INTRO.test(before));
        }
      } else {
        if (SKIP.test(path) || statSync(path).size > 400_000) continue;
        const text = readFileSync(path, 'utf8');
        if (DECLARATION.test(text))
          add('community', source.name, relative(dir, path), text.replace(/\r\n/g, '\n'), false);
      }
    }
  }
  return scripts;
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

function runOne(text: string): { ok: boolean; stage: string; message: string } {
  try {
    const result = compileScript(text);
    if (!result.ok)
      return { ok: false, stage: 'compile', message: result.errors[0]?.message ?? '?' };
    const run = new ScriptRun(result.program, result.program.defaults());
    run.setBars(BARS, true);
    if (run.error) return { ok: false, stage: 'runtime', message: run.error.message };
    return { ok: true, stage: 'ok', message: '' };
  } catch (error) {
    return {
      ok: false,
      stage: 'crash',
      message: String((error as Error).message ?? error).slice(0, 200),
    };
  }
}

/** What a script needs beyond P2: drawings (P3), other symbols (P4), strategies (P5). */
function later(text: string): string[] {
  const code = text
    .split('\n')
    .map((line) => (line.trim().startsWith('//') ? '' : line.split('//')[0]))
    .join('\n');
  return Object.entries(FEATURES)
    .filter(([, pattern]) => pattern.test(code))
    .map(([name]) => name);
}

function report(scripts: Script[]): void {
  const results = scripts.map((script) => ({
    script,
    needs: later(script.text),
    ...runOne(script.text),
  }));
  const kinds = new Map<string, number>();
  for (const corpus of ['manual', 'community'] as const) {
    const mine = results.filter((r) => r.script.corpus === corpus && !r.script.deliberate);
    const p2 = mine.filter((r) => r.needs.length === 0);
    const ok = mine.filter((r) => r.ok).length;
    const p2ok = p2.filter((r) => r.ok).length;
    console.log(
      `${corpus}: ${ok} of ${mine.length} run (${((100 * ok) / Math.max(1, mine.length)).toFixed(1)}%); ` +
        `of the ${p2.length} that need only P2's features, ${p2ok} (${((100 * p2ok) / Math.max(1, p2.length)).toFixed(1)}%)`,
    );
    for (const r of p2) {
      if (r.ok) continue;
      const kind = `${r.stage}: ${r.message
        .replace(/"[^"]*"/g, '"…"')
        .replace(/'[^']*'/g, "'…'")
        .replace(/\d+/g, 'N')}`.slice(0, 110);
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    }
  }
  console.log('\nWhat stops the scripts that need only P2:');
  for (const [kind, n] of [...kinds].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
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

fetchAll();
if (process.argv[2] !== 'fetch') report(collect());
