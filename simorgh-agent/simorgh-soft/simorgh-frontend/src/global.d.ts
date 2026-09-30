declare module '*.jpg';
declare module '*.jpeg';
declare module '*.png';
declare module '*.gif';
declare module '*.svg';

// Vite turns a `?worker` import into a constructor for that module running in
// a Worker. It is a build-time transform, so TypeScript needs telling.
declare module '*?worker' {
  const WorkerConstructor: { new (): Worker };
  export default WorkerConstructor;
}

// Monaco's editor is pulled in by its ESM paths rather than through the
// package root, so only the editor comes with it — not the eighty language
// definitions, the TypeScript service and the JSON schema engine, none of
// which a PLC page has any use for. Those deep paths are plain JavaScript with
// no declarations of their own; `editor.api` carries the types and is imported
// normally.
declare module 'monaco-editor/esm/vs/editor/editor.all.js';
declare module 'monaco-editor/esm/vs/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess.js';
declare module 'monaco-editor/esm/vs/editor/standalone/browser/quickAccess/standaloneCommandsQuickAccess.js';
