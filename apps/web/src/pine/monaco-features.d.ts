// Monaco's feature modules ship without type declarations: features.ts imports them only for
// what they register. editor/editor.api.js has its own and isn't covered by these.
declare module 'monaco-editor/editor/contrib/*';
declare module 'monaco-editor/editor/browser/*';
declare module 'monaco-editor/editor/standalone/*';
declare module 'monaco-editor/editor/common/*';
declare module 'monaco-editor/features/*';
