import type { Arg, Block, Expr, Script, Stmt } from './ast.ts';
import { versionOf } from './ast.ts';
import { PineCompileError, type Span } from './diagnostics.ts';
import { type EditSink, repeatedArg } from './edits.ts';

/** Where Convert code to v6 hears the changes a v5 script needs, and how it reads the code. */
export interface Converting {
  edits: EditSink;
  text: (span: Span) => string;
}

/**
 * Older Pine versions in today's words (TradingView's Pine docs, migration guides "To Pine Script
 * version 3", "4", "5" and "6"): a v1 to v5 script's syntax tree with the built-ins it names
 * renamed to v6's, and the arguments that changed shape rewritten, so the compiler reads one
 * language. What changed in behaviour rather than in name (bool casting, eager and/or, integer
 * division of constants, a for loop's end read once, the old colours) the compiler applies by the
 * script's version. Names the script declares itself are never renamed.
 */
export function upgrade(script: Script, converting?: Converting): Script {
  const version = versionOf(script);
  if (version >= 6) return script;
  const declared = declaredNames(script.statements);
  const rewriter = new Rewriter(version, declared.variables, declared.functions, converting);
  let statements = script.statements.map((stmt) => rewriter.stmt(stmt));
  if (version <= 2) statements = selfReferences(statements);
  return { ...script, statements };
}

// ---- the guides' tables ----

/** v4 → v5: functions moved into namespaces ("All variable, function, and parameter name changes"). */
const V5_FUNCTIONS: Readonly<Record<string, string>> = {
  study: 'indicator',
  security: 'request.security',
  financial: 'request.financial',
  quandl: 'request.quandl',
  splits: 'request.splits',
  dividends: 'request.dividends',
  earnings: 'request.earnings',
  heikinashi: 'ticker.heikinashi',
  kagi: 'ticker.kagi',
  linebreak: 'ticker.linebreak',
  pointfigure: 'ticker.pointfigure',
  renko: 'ticker.renko',
  tickerid: 'ticker.new',
  tostring: 'str.tostring',
  tonumber: 'str.tonumber',
  ...namespace('ta', [
    'alma',
    'atr',
    'bb',
    'bbw',
    'cci',
    'cmo',
    'cog',
    'dmi',
    'ema',
    'hma',
    'kc',
    'kcw',
    'linreg',
    'macd',
    'mfi',
    'mom',
    'rma',
    'roc',
    'sar',
    'sma',
    'stoch',
    'supertrend',
    'swma',
    'tr',
    'tsi',
    'vwap',
    'vwma',
    'wma',
    'wpr',
    'barssince',
    'change',
    'correlation',
    'cross',
    'crossover',
    'crossunder',
    'cum',
    'dev',
    'falling',
    'highest',
    'highestbars',
    'lowest',
    'lowestbars',
    'median',
    'mode',
    'percentile_linear_interpolation',
    'percentile_nearest_rank',
    'percentrank',
    'pivothigh',
    'pivotlow',
    'range',
    'rising',
    'stdev',
    'valuewhen',
    'variance',
  ]),
  ...namespace('math', [
    'abs',
    'acos',
    'asin',
    'atan',
    'avg',
    'ceil',
    'cos',
    'exp',
    'floor',
    'log',
    'log10',
    'max',
    'min',
    'pow',
    'random',
    'round',
    'round_to_mintick',
    'sign',
    'sin',
    'sqrt',
    'sum',
    'tan',
    'todegrees',
    'toradians',
  ]),
  // v4's rsi() with a float second argument was MFI's formula; the compiler tells them apart.
  rsi: '__rsi_v4',
  iff: '__iff',
};

/** v4 → v5: variables moved into the ta namespace. */
const V5_VARIABLES: Readonly<Record<string, string>> = namespace('ta', [
  'accdist',
  'iii',
  'nvi',
  'obv',
  'pvi',
  'pvt',
  'tr',
  'vwap',
  'wad',
  'wvad',
]);

/** v4 → v5: parameters renamed, by function (v5 name). */
const V5_PARAMS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  indicator: { resolution: 'timeframe', resolution_gaps: 'timeframe_gaps' },
  'request.security': { resolution: 'timeframe' },
  time: { resolution: 'timeframe' },
  time_close: { resolution: 'timeframe' },
  'strategy.entry': { long: 'direction' },
  'strategy.order': { long: 'direction' },
  nz: { x: 'source', y: 'replacement' },
  'str.tostring': { x: 'value', y: 'format' },
  'ta.correlation': { source_a: 'source1', source_b: 'source2' },
  'ta.cross': { x: 'source1', y: 'source2' },
  'ta.crossover': { x: 'source1', y: 'source2' },
  'ta.crossunder': { x: 'source1', y: 'source2' },
  'ta.cum': { x: 'source' },
  'ta.swma': { x: 'source' },
  'ta.vwap': { x: 'source' },
};

/** v4's input types (`input(…, type = input.integer)`) → v5's input functions. */
const V5_INPUTS: Readonly<Record<string, string>> = {
  'input.integer': 'input.int',
  'input.float': 'input.float',
  'input.bool': 'input.bool',
  'input.color': 'input.color',
  'input.string': 'input.string',
  'input.source': 'input.source',
  'input.resolution': 'input.timeframe',
  'input.session': 'input.session',
  'input.symbol': 'input.symbol',
  'input.time': 'input.time',
};

const COLOR_NAMES = [
  'aqua',
  'black',
  'blue',
  'fuchsia',
  'gray',
  'green',
  'lime',
  'maroon',
  'navy',
  'olive',
  'orange',
  'purple',
  'red',
  'silver',
  'teal',
  'white',
  'yellow',
];

/** v3 → v4: constants and variables moved into namespaces ("To Pine Script version 4"). */
const V4_VARIABLES: Readonly<Record<string, string>> = {
  ...Object.fromEntries(COLOR_NAMES.map((name) => [name, `color.${name}`])),
  integer: 'input.integer',
  resolution: 'input.resolution',
  symbol: 'input.symbol',
  session: 'input.session',
  source: 'input.source',
  line: 'plot.style_line',
  linebr: 'plot.style_linebr',
  stepline: 'plot.style_stepline',
  histogram: 'plot.style_histogram',
  cross: 'plot.style_cross',
  area: 'plot.style_area',
  areabr: 'plot.style_areabr',
  columns: 'plot.style_columns',
  circles: 'plot.style_circles',
  dotted: 'hline.style_dotted',
  dashed: 'hline.style_dashed',
  solid: 'hline.style_solid',
  ...Object.fromEntries(
    ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].map((day) => [
      day,
      `dayofweek.${day}`,
    ]),
  ),
  period: 'timeframe.period',
  isintraday: 'timeframe.isintraday',
  isdaily: 'timeframe.isdaily',
  isweekly: 'timeframe.isweekly',
  ismonthly: 'timeframe.ismonthly',
  isdwm: 'timeframe.isdwm',
  interval: 'timeframe.multiplier',
  ticker: 'syminfo.ticker',
  tickerid: 'syminfo.tickerid',
  n: 'bar_index',
};

/** v3's input types as the type argument's value, before the input namespace. */
const V3_INPUT_TYPES: Readonly<Record<string, string>> = {
  integer: 'input.integer',
  float: 'input.float',
  bool: 'input.bool',
  string: 'input.string',
  source: 'input.source',
  resolution: 'input.resolution',
  symbol: 'input.symbol',
  session: 'input.session',
};

/** Calls that took `transp` before v6 (v5 deprecated it; v6 removed it). */
const TRANSP_CALLS: ReadonlySet<string> = new Set([
  'plot',
  'plotshape',
  'plotchar',
  'plotarrow',
  'plotcandle',
  'plotbar',
  'bgcolor',
  'fill',
  'barcolor',
  'hline',
]);

/** v4's input() parameters in order, `type` third. */
const V4_INPUT_PARAMS = [
  'defval',
  'title',
  'type',
  'minval',
  'maxval',
  'confirm',
  'step',
  'options',
  'tooltip',
  'inline',
  'group',
];

function namespace(space: string, names: readonly string[]): Record<string, string> {
  return Object.fromEntries(names.map((name) => [name, `${space}.${name}`]));
}

// ---- the rewrite ----

class Rewriter {
  private readonly version: number;
  /** Variables and functions the script declares: Pine keeps their names apart. */
  private readonly variables: ReadonlySet<string>;
  private readonly functions: ReadonlySet<string>;
  private readonly converting: Converting | null;

  constructor(
    version: number,
    variables: ReadonlySet<string>,
    functions: ReadonlySet<string>,
    converting?: Converting,
  ) {
    this.version = version;
    this.variables = variables;
    this.functions = functions;
    this.converting = converting ?? null;
  }

  stmt(stmt: Stmt): Stmt {
    switch (stmt.kind) {
      case 'decl':
        return { ...stmt, value: this.expr(stmt.value) };
      case 'tupleDecl':
        return { ...stmt, value: this.expr(stmt.value) };
      case 'assign':
        return { ...stmt, value: this.expr(stmt.value) };
      case 'func':
        return {
          ...stmt,
          params: stmt.params.map((param) => ({
            ...param,
            default: param.default && this.expr(param.default),
          })),
          body: this.block(stmt.body),
        };
      case 'expr':
        return { ...stmt, expr: this.expr(stmt.expr) };
      default:
        return stmt;
    }
  }

  private block(block: Block): Block {
    return { ...block, statements: block.statements.map((stmt) => this.stmt(stmt)) };
  }

  private expr(expr: Expr): Expr {
    switch (expr.kind) {
      case 'name':
        return this.name(expr);
      case 'call':
        return this.call(expr);
      case 'member':
        return { ...expr, target: this.expr(expr.target) };
      case 'unary':
        return { ...expr, operand: this.expr(expr.operand) };
      case 'binary':
        return { ...expr, left: this.expr(expr.left), right: this.expr(expr.right) };
      case 'ternary': {
        const then = this.expr(expr.then);
        return { ...expr, cond: this.expr(expr.cond), then, otherwise: this.expr(expr.otherwise) };
      }
      case 'history':
        return { ...expr, target: this.expr(expr.target), offset: this.expr(expr.offset) };
      case 'list':
        return { ...expr, items: expr.items.map((item) => this.expr(item)) };
      case 'if':
        return {
          ...expr,
          branches: expr.branches.map((branch) => ({
            cond: this.expr(branch.cond),
            body: this.block(branch.body),
          })),
          otherwise: expr.otherwise && this.block(expr.otherwise),
        };
      case 'switch':
        return {
          ...expr,
          subject: expr.subject && this.expr(expr.subject),
          cases: expr.cases.map((c) => ({
            match: c.match && this.expr(c.match),
            body: this.block(c.body),
          })),
        };
      case 'for':
        return {
          ...expr,
          from: this.expr(expr.from),
          to: this.expr(expr.to),
          step: expr.step && this.expr(expr.step),
          body: this.block(expr.body),
        };
      case 'forIn':
        return { ...expr, target: this.expr(expr.target), body: this.block(expr.body) };
      case 'while':
        return { ...expr, cond: this.expr(expr.cond), body: this.block(expr.body) };
      default:
        return expr;
    }
  }

  private name(expr: Extract<Expr, { kind: 'name' }>): Expr {
    const first = expr.name.split('.')[0] as string;
    if (this.variables.has(first)) return expr;
    let name = expr.name;
    if (this.version <= 3) name = V4_VARIABLES[name] ?? name;
    if (this.version <= 4) name = V5_VARIABLES[name] ?? name;
    return name === expr.name ? expr : { ...expr, name };
  }

  private call(expr: Extract<Expr, { kind: 'call' }>): Expr {
    let args = expr.args.map((arg) => ({ ...arg, value: this.expr(arg.value) }));
    const receiver = expr.receiver && this.expr(expr.receiver);
    if (
      receiver ||
      this.functions.has(expr.callee) ||
      (expr.callee.includes('.') && this.variables.has(expr.callee.split('.')[0] as string))
    ) {
      return { ...expr, receiver, args };
    }
    let callee = expr.callee;
    if (this.version <= 3 && callee === 'color') callee = 'color.new';
    if (this.version <= 4) {
      // indicator() came with v5, renamed from study(): "Pine Script v1 has no function named
      // indicator(), so the script will not compile" (the v6 reference, //@version=).
      if (callee === 'indicator') {
        throw new PineCompileError(
          "Could not find function or function reference 'indicator'",
          expr.calleeSpan,
        );
      }
      if (callee === 'input') return this.input(expr, args);
      if (callee === 'offset' && args.length === 2) {
        // offset(x, n) is x[n] (v5 guide: Removed iff() and offset()).
        const [x, n] = args as [Arg, Arg];
        return { kind: 'history', target: x.value, offset: n.value, span: expr.span };
      }
      callee = V5_FUNCTIONS[callee] ?? callee;
      const renames = V5_PARAMS[callee];
      if (renames) {
        args = args.map((arg) =>
          arg.name && renames[arg.name] ? { ...arg, name: renames[arg.name] as string } : arg,
        );
      }
    }
    if (TRANSP_CALLS.has(callee)) args = this.transp(callee, args, expr.span);
    return { ...expr, callee, args };
  }

  /** v4's input(): its `type` argument picks v5's input function (v5 guide: Split of input()). */
  private input(expr: Extract<Expr, { kind: 'call' }>, args: Arg[]): Expr {
    let typeName: string | null = null;
    const kept: Arg[] = [];
    args.forEach((arg, i) => {
      const isType = arg.name === 'type' || (arg.name === null && i === 2);
      if (isType && arg.value.kind === 'name') {
        const name = arg.value.name;
        typeName = name.startsWith('input.') ? name : (V3_INPUT_TYPES[name] ?? name);
        return;
      }
      kept.push(arg);
    });
    // Positional arguments after the type move to their names.
    const named = kept.map((arg, i) =>
      arg.name === null && i >= 2 ? { ...arg, name: V4_INPUT_PARAMS[i + 1] ?? null } : arg,
    );
    const callee = (typeName && V5_INPUTS[typeName]) ?? 'input';
    return {
      ...expr,
      callee,
      args: named.filter((arg) => arg.name !== 'confirm'),
    };
  }

  /**
   * `transp` joins the color it applied to (v5 guide: Deprecated the transp parameter). In v4
   * and older, bgcolor() and fill() took a transparency of 90 when none was given.
   */
  private transp(callee: string, args: Arg[], span: Span): Arg[] {
    const transp = args.find((arg) => arg.name === 'transp');
    const defaultTransp =
      !transp && this.version <= 4 && (callee === 'bgcolor' || callee === 'fill') ? 90 : null;
    if (!transp && defaultTransp === null) return args;
    const colorIndex = colorArgIndex(callee, args);
    const rest = args.filter((arg) => arg !== transp);
    if (transp && this.version === 5 && this.converting) {
      // TradingView's converter drops transp, its guide's fix being color.new(): we write that
      // fix, so the converted script draws the same (docs/SPEC.md §3).
      const { edits, text } = this.converting;
      edits.add(repeatedArg(args, args.indexOf(transp)));
      const colorArg = args[colorIndex];
      if (colorArg) {
        edits.add({
          span: colorArg.value.span,
          before: 'color.new(',
          after: `, ${text(transp.value.span)})`,
        });
      }
    }
    if (colorIndex < 0) return rest;
    const colorArg = args[colorIndex] as Arg;
    if (defaultTransp !== null && !isPlainColor(colorArg.value)) return rest;
    const amount: Expr = transp?.value ?? {
      kind: 'number',
      value: defaultTransp as number,
      float: false,
      span,
    };
    const wrapped: Expr = {
      kind: 'call',
      callee: 'color.new',
      calleeSpan: colorArg.value.span,
      receiver: null,
      typeArgs: null,
      args: [
        { name: null, value: colorArg.value, span: colorArg.span },
        { name: null, value: amount, span: amount.span },
      ],
      span: colorArg.value.span,
    };
    return rest.map((arg) => (arg === colorArg ? { ...arg, value: wrapped } : arg));
  }
}

/** Where a call's color argument is, by name or by position (the v5 reference's signatures). */
function colorArgIndex(callee: string, args: readonly Arg[]): number {
  const named = args.findIndex((arg) => arg.name === 'color');
  if (named >= 0) return named;
  const position: Readonly<Record<string, number>> = {
    plot: 2,
    bgcolor: 0,
    fill: 2,
    barcolor: 0,
    hline: 2,
    plotshape: -1,
    plotchar: -1,
  };
  const at = position[callee] ?? -1;
  if (at < 0) return -1;
  const arg = args[at];
  return arg && arg.name === null ? at : -1;
}

/** A color written as itself: a constant, a literal, or a name (not color.new or rgb). */
const isPlainColor = (expr: Expr): boolean =>
  expr.kind === 'color' || (expr.kind === 'name' && expr.name.startsWith('color.'));

// ---- names the script declares ----

function declaredNames(statements: readonly Stmt[]): {
  variables: Set<string>;
  functions: Set<string>;
} {
  const names = new Set<string>();
  const functions = new Set<string>();
  const visitBlock = (block: Block) => block.statements.forEach(visitStmt);
  const visitExpr = (expr: Expr | null): void => {
    if (!expr) return;
    switch (expr.kind) {
      case 'if':
        for (const branch of expr.branches) visitBlock(branch.body);
        if (expr.otherwise) visitBlock(expr.otherwise);
        return;
      case 'switch':
        for (const c of expr.cases) visitBlock(c.body);
        return;
      case 'for':
        names.add(expr.counter);
        visitBlock(expr.body);
        return;
      case 'forIn':
        for (const name of expr.names) names.add(name);
        visitBlock(expr.body);
        return;
      case 'while':
        visitBlock(expr.body);
        return;
      default:
        return;
    }
  };
  function visitStmt(stmt: Stmt): void {
    switch (stmt.kind) {
      case 'decl':
        names.add(stmt.name);
        visitExpr(stmt.value);
        return;
      case 'tupleDecl':
        for (const name of stmt.names) names.add(name);
        visitExpr(stmt.value);
        return;
      case 'assign':
        visitExpr(stmt.value);
        return;
      case 'func':
        functions.add(stmt.name);
        for (const param of stmt.params) names.add(param.name);
        visitBlock(stmt.body);
        return;
      case 'expr':
        visitExpr(stmt.expr);
        return;
      default:
        return;
    }
  }
  statements.forEach(visitStmt);
  return { variables: names, functions };
}

/**
 * v2's self-referencing variables (`s = nz(s[1]) + close`, "To Pine Script version 3"): declared
 * as a float first, then assigned, as v3 asks.
 */
function selfReferences(statements: readonly Stmt[]): Stmt[] {
  const out: Stmt[] = [];
  for (const stmt of statements) {
    if (stmt.kind === 'decl' && stmt.type === null && refersTo(stmt.value, stmt.name)) {
      out.push({ ...stmt, type: 'float', value: { kind: 'na', span: stmt.nameSpan } });
      out.push({
        kind: 'assign',
        op: ':=',
        target: { kind: 'name', name: stmt.name, span: stmt.nameSpan },
        value: stmt.value,
        span: stmt.span,
      });
      continue;
    }
    out.push(stmt);
  }
  return out;
}

function refersTo(expr: Expr, name: string): boolean {
  switch (expr.kind) {
    case 'name':
      return expr.name === name;
    case 'history':
      return refersTo(expr.target, name) || refersTo(expr.offset, name);
    case 'call':
      return expr.args.some((arg) => refersTo(arg.value, name));
    case 'unary':
      return refersTo(expr.operand, name);
    case 'binary':
      return refersTo(expr.left, name) || refersTo(expr.right, name);
    case 'ternary':
      return (
        refersTo(expr.cond, name) || refersTo(expr.then, name) || refersTo(expr.otherwise, name)
      );
    default:
      return false;
  }
}
