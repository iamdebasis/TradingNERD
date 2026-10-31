import type * as Monaco from 'monaco-editor';

/** The Pine Editor's language id in Monaco. */
export const PINE = 'pine';

/** Pine's keywords (the v6 reference's Keywords), the ones that start or shape statements. */
const KEYWORDS = [
  'and',
  'or',
  'not',
  'if',
  'else',
  'switch',
  'for',
  'to',
  'by',
  'in',
  'while',
  'break',
  'continue',
  'var',
  'varip',
  'import',
  'export',
  'method',
  'type',
  'enum',
  'const',
  'simple',
  'series',
];

/** Pine's types: written in the code's own color, as TradingView's editor shows them. */
const TYPES = [
  'int',
  'float',
  'bool',
  'color',
  'string',
  'line',
  'label',
  'box',
  'table',
  'array',
  'matrix',
  'map',
];

/** Constants and the bar's built-in variables, in the constants' color. */
const CONSTANTS = [
  'true',
  'false',
  'na',
  'open',
  'high',
  'low',
  'close',
  'volume',
  'time',
  'time_close',
  'bar_index',
  'last_bar_index',
  'hl2',
  'hlc3',
  'ohlc4',
  'hlcc4',
];

/** Built-in functions called without a namespace. */
const FUNCTIONS = [
  'indicator',
  'strategy',
  'library',
  'plot',
  'plotshape',
  'plotchar',
  'plotarrow',
  'plotbar',
  'plotcandle',
  'hline',
  'fill',
  'bgcolor',
  'barcolor',
  'alertcondition',
  'alert',
  'input',
  'nz',
  'fixnan',
  'max_bars_back',
  'timestamp',
];

/** Namespaces whose members are values (color.red, display.none) rather than functions. */
const VALUE_NAMESPACES = [
  'color',
  'display',
  'format',
  'plot',
  'hline',
  'barstate',
  'syminfo',
  'timeframe',
  'math',
  'shape',
  'location',
  'size',
  'position',
  'xloc',
  'yloc',
  'extend',
  'text',
  'font',
  'scale',
  'barmerge',
  'currency',
  'dayofweek',
  'session',
  'adjustment',
  'order',
];

/**
 * Pine Script® v6 for Monaco's Monarch tokenizer: comments and annotations, strings, numbers,
 * #RRGGBB colors, keywords, operators, built-in functions (ta.sma, plot) and constants (na,
 * color.red, close). Its rules are ours, from the v6 reference's lexical structure.
 */
export const pineTokens: Monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  keywords: KEYWORDS,
  types: TYPES,
  constants: CONSTANTS,
  functions: FUNCTIONS,
  operators: [
    ':=',
    '+=',
    '-=',
    '*=',
    '/=',
    '%=',
    '==',
    '!=',
    '<=',
    '>=',
    '=',
    '<',
    '>',
    '+',
    '-',
    '*',
    '/',
    '%',
    '?',
    ':',
  ],
  symbols: /[=><!~?:&|+\-*/^%]+/,
  tokenizer: {
    root: [
      [/\/\/@[a-zA-Z_]+.*$/, 'comment.annotation'],
      [/\/\/.*$/, 'comment'],
      [/#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b/, 'constant.color'],
      [/"/, 'string', '@stringDouble'],
      [/'/, 'string', '@stringSingle'],
      [/\d*\.\d+([eE][-+]?\d+)?|\d+\.?\d*([eE][-+]?\d+)?/, 'number'],
      // A namespace's member: a function when called (ta.sma, color.new), a constant when one
      // of the value namespaces' (color.red, display.none), otherwise a field.
      [/[a-zA-Z_]\w*\.[a-zA-Z_]\w*(?=\s*\()/, 'support.function'],
      [new RegExp(`\\b(?:${VALUE_NAMESPACES.join('|')})\\.[a-zA-Z_]\\w*`), 'constant'],
      [/([a-zA-Z_]\w*)(\.)([a-zA-Z_]\w*)/, ['identifier', 'delimiter', 'identifier']],
      [
        /[a-zA-Z_]\w*(?=\s*\()/,
        {
          cases: {
            '@functions': 'support.function',
            '@types': 'support.function',
            '@default': 'identifier',
          },
        },
      ],
      [
        /[a-zA-Z_]\w*/,
        {
          cases: {
            '@keywords': 'keyword',
            '@types': 'type',
            '@constants': 'constant',
            '@default': 'identifier',
          },
        },
      ],
      [/=>/, 'delimiter'],
      [/[{}()[\]]/, '@brackets'],
      [/[,.]/, 'delimiter'],
      [/@symbols/, { cases: { '@operators': 'operator', '@default': '' } }],
      [/\s+/, 'white'],
    ],
    stringDouble: [
      [/[^\\"]+/, 'string'],
      [/\\./, 'string.escape'],
      [/"/, 'string', '@pop'],
    ],
    stringSingle: [
      [/[^\\']+/, 'string'],
      [/\\./, 'string.escape'],
      [/'/, 'string', '@pop'],
    ],
  },
};

/** Comments, brackets, and indenting a block after a line that opens one. */
export const pineConfiguration: Monaco.languages.LanguageConfiguration = {
  comments: { lineComment: '//' },
  brackets: [
    ['(', ')'],
    ['[', ']'],
  ],
  autoClosingPairs: [
    { open: '(', close: ')' },
    { open: '[', close: ']' },
    { open: '"', close: '"', notIn: ['string', 'comment'] },
    { open: "'", close: "'", notIn: ['string', 'comment'] },
  ],
  surroundingPairs: [
    { open: '(', close: ')' },
    { open: '[', close: ']' },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
  // A local block is four spaces in (Pine docs, Script structure).
  indentationRules: {
    increaseIndentPattern: /^\s*(if|else|for|while|switch)\b.*$|=>\s*$/,
    decreaseIndentPattern: /^\s*else\b/,
  },
  wordPattern: /(-?\d*\.\d\w*)|([^`~!@#%^&*()\-=+[{\]}\\|;:'",.<>/?\s]+)/g,
};

/**
 * The editor's dark theme, measured from the user's screenshot of TradingView's Pine Editor (27
 * October 2026): black, with its line numbers, current line and token colors. That code was a
 * read-only built-in's, which TradingView greys, so the colors are provisional until measured
 * on code being edited (docs/SPEC.md §7, §11).
 */
export const PINE_DARK_THEME: Monaco.editor.IStandaloneThemeData = {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: '', foreground: 'D1D1D1' },
    { token: 'identifier', foreground: 'D1D1D1' },
    { token: 'type', foreground: 'D1D1D1' },
    { token: 'comment', foreground: '797979' },
    { token: 'comment.annotation', foreground: '797979' },
    { token: 'string', foreground: '567257' },
    { token: 'string.escape', foreground: '567257' },
    { token: 'number', foreground: 'C9AE97' },
    { token: 'keyword', foreground: '6E9A8E' },
    { token: 'operator', foreground: '628177' },
    { token: 'delimiter', foreground: 'B4B4B4' },
    { token: 'support.function', foreground: '7189B0' },
    { token: 'constant', foreground: 'B08386' },
    { token: 'constant.color', foreground: 'B08386' },
  ],
  colors: {
    'editor.background': '#000000',
    'editor.foreground': '#D1D1D1',
    'editorLineNumber.foreground': '#6B6B6B',
    'editorLineNumber.activeForeground': '#ACACAC',
    'editor.lineHighlightBackground': '#142043',
    'editor.lineHighlightBorder': '#142043',
    'editorCursor.foreground': '#D1D1D1',
    'editorGutter.background': '#000000',
    'minimap.background': '#000000',
    'editorIndentGuide.background1': '#2A2A2A',
    'editorWidget.background': '#1E1E1E',
    'scrollbarSlider.background': '#FFFFFF1F',
  },
};

/** Registers Pine and the theme with Monaco (once). */
export function registerPine(monaco: typeof Monaco): void {
  if (monaco.languages.getLanguages().some((language) => language.id === PINE)) return;
  monaco.languages.register({ id: PINE, extensions: ['.pine'], aliases: ['Pine Script', 'pine'] });
  monaco.languages.setMonarchTokensProvider(PINE, pineTokens);
  monaco.languages.setLanguageConfiguration(PINE, pineConfiguration);
  monaco.editor.defineTheme('tn-pine-dark', PINE_DARK_THEME);
}
