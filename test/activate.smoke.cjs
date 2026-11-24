// Loads the bundled extension with a stub `vscode` module and checks that
// activate() registers every command declared in package.json.
const Module = require('module');
const path = require('path');
const registered = new Set();
const noop = () => ({ dispose() {} });
const emitter = class { constructor() { this.event = () => noop(); } fire() {} dispose() {} };
const proxy = (name) => new Proxy(function () {}, {
  get: (_, k) => (k === 'then' ? undefined : proxy(name + '.' + String(k))),
  apply: () => proxy(name + '()'),
  construct: () => proxy('new ' + name),
});
const vscode = {
  EventEmitter: emitter,
  Disposable: class { constructor(f) { this.dispose = f; } },
  commands: { registerCommand: (id) => { registered.add(id); return noop(); }, executeCommand: async () => undefined },
  window: new Proxy({ createTreeView: () => ({ dispose() {} }), createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }), createTextEditorDecorationType: () => ({ dispose() {} }), activeTextEditor: undefined, onDidChangeActiveTextEditor: noop }, { get: (t, k) => (k in t ? t[k] : noop) }),
  workspace: { onDidCloseTextDocument: noop, onDidChangeConfiguration: noop, getConfiguration: () => ({ get: (_k, d) => d }) },
  languages: { registerCompletionItemProvider: noop },
  StatusBarAlignment: { Left: 1 }, ThemeColor: class {}, ThemeIcon: class {}, Uri: proxy('Uri'),
};
const orig = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? vscode : orig.call(this, req, ...rest); };
const ext = require(path.resolve(__dirname, '../dist/extension.js'));
const state = new Map();
const ctx = { subscriptions: [], extensionUri: {}, globalState: { get: (k, d) => state.get(k) ?? d, update: async (k, v) => state.set(k, v) }, workspaceState: { get: (k, d) => d, update: async () => {} }, secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} } };
ext.activate(ctx);
const pkg = require('../package.json');
const declared = pkg.contributes.commands.map((c) => c.command);
const missing = declared.filter((c) => !registered.has(c));
const menuCmds = Object.values(pkg.contributes.menus).flat().map((m) => m.command).concat(pkg.contributes.keybindings.map((k) => k.command));
const undeclared = [...new Set(menuCmds)].filter((c) => !declared.includes(c));
console.log(`registered ${registered.size}, declared ${declared.length}`);
if (missing.length || undeclared.length) { console.error('missing:', missing, 'menu refs not declared:', undeclared); process.exit(1); }
console.log('activate OK');
