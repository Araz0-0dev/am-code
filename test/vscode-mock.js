/**
 * Minimal but functional mock of the VS Code API, good enough to actually activate the
 * bundled extension and drive it (add a model, open the chat view, send a prompt).
 * Used by test/activation.test.js — nothing here is shipped to users.
 */
const path = require('path');

function createHost(options = {}) {
  const log = { info: [], warn: [], error: [], output: [] };
  const configuration = {};
  const configListeners = [];
  const commands = new Map();
  const views = [];
  const providers = new Map();
  const statusBars = [];
  const terminals = [];
  const selectionListeners = [];
  const activeEditorListeners = [];
  const secrets = new Map();
  const fileSystem = new Map(); // relPath -> content (only what we preload)

  const root = options.root || path.resolve('/tmp/agentcode-fixture');
  const workspaceFolders = options.workspace === false
    ? undefined
    : [{ uri: uriFor(root), name: path.basename(root), index: 0 }];

  function uriFor(fsPath) {
    return {
      scheme: 'file',
      path: fsPath,
      fsPath,
      toString: () => `file://${fsPath}`,
      with: (change) => uriFor(change.path || fsPath)
    };
  }

  const emitter = () => {
    const listeners = [];
    return {
      event: (cb) => {
        listeners.push(cb);
        return { dispose: () => {} };
      },
      fire: (value) => listeners.forEach((cb) => cb(value)),
      dispose: () => {}
    };
  };

  const cfg = {
    get(key, fallback) {
      return configuration[key] === undefined ? fallback : configuration[key];
    },
    async update(key, value) {
      configuration[key] = value;
      configListeners.forEach((cb) => cb({ affectsConfiguration: (section) => !section || section.startsWith('agentcode') }));
    }
  };

  const channels = [];
  const window_ = {
    activeTextEditor: options.editor,
    visibleTextEditors: options.editor ? [options.editor] : [],
    createOutputChannel(name) {
      const channel = {
        name,
        appendLine: (line) => log.output.push(line),
        append: (line) => log.output.push(line),
        show: () => {},
        dispose: () => {}
      };
      channels.push(channel);
      return channel;
    },
    createStatusBarItem(alignment, priority) {
      const item = { text: '', tooltip: '', command: '', alignment, priority, visible: false, show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} };
      statusBars.push(item);
      return item;
    },
    createTerminal() {
      const terminal = { name: 'AgentCode', exitStatus: undefined, show: () => {}, sendText: (t) => log.info.push(`terminal: ${t}`), dispose: () => {} };
      terminals.push(terminal);
      return terminal;
    },
    registerWebviewViewProvider(id, provider) {
      views.push({ id, provider });
      return { dispose: () => {} };
    },
    showInformationMessage(message, ...rest) {
      log.info.push(message);
      const actions = rest.filter((a) => typeof a === 'string');
      const scripted = options.answer && options.answer(message, actions);
      return Promise.resolve(scripted === undefined ? undefined : scripted);
    },
    showWarningMessage(message, ...rest) {
      log.warn.push(message);
      const actions = rest.filter((a) => typeof a === 'string');
      const scripted = options.answer && options.answer(message, actions);
      return Promise.resolve(scripted === undefined ? undefined : scripted);
    },
    showQuickPick(items, opts) {
      const scripted = options.quickPick && options.quickPick(items, opts);
      return Promise.resolve(scripted === undefined ? items[0] : scripted);
    },
    showInputBox(o) {
      const scripted = options.inputBox && options.inputBox(o);
      return Promise.resolve(scripted === undefined ? undefined : scripted);
    },
    async withProgress(_options, task) {
      return task({ report: () => {} });
    },
    showOpenDialog() {
      return Promise.resolve(options.openDialog || undefined);
    },
    showSaveDialog() {
      return Promise.resolve(options.saveDialog || undefined);
    },
    async showTextDocument(doc) {
      return { document: doc, selection: null, revealRange: () => {}, setDecorations: () => {} };
    },
    createTextEditorDecorationType() {
      return { key: 'mock-decoration', dispose: () => {} };
    },
    onDidChangeActiveTextEditor(cb) {
      const e = emitter();
      activeEditorListeners.push(cb);
      return e.event(cb);
    },
    onDidChangeTextEditorSelection(cb) {
      const e = emitter();
      selectionListeners.push(cb);
      return e.event(cb);
    },
    setStatusBarMessage: () => ({ dispose: () => {} })
  };

  const workspace = {
    name: options.workspace === false ? undefined : path.basename(root),
    workspaceFolders,
    getConfiguration: () => cfg,
    onDidChangeConfiguration(cb) {
      configListeners.push(cb);
      return { dispose: () => {} };
    },
    asRelativePath(uri) {
      const p = typeof uri === 'string' ? uri : uri.fsPath || uri.path || '';
      return p.startsWith(root) ? p.slice(root.length + 1) : p;
    },
    async findFiles() {
      return [];
    },
    async openTextDocument(uri) {
      const content = fileSystem.get(uri.fsPath) ?? '';
      return {
        uri,
        isUntitled: false,
        languageId: 'typescript',
        lineCount: content.split('\n').length,
        getText: () => content,
        positionAt: (offset) => position(offset, 0)
      };
    },
    registerTextDocumentContentProvider(scheme, provider) {
      providers.set(scheme, provider);
      return { dispose: () => {} };
    },
    fs: {
      async stat(uri) {
        const content = fileSystem.get(uri.fsPath);
        if (content === undefined) {
          throw new Error('ENOENT');
        }
        return { size: content.length, isDirectory: () => false };
      }
    }
  };

  function position(line, character) {
    return { line, character };
  }

  const vscode = {
    version: '1.90.0',
    Uri: {
      file: uriFor,
      parse: (value) => {
        const match = /^([a-z-]+):(.*)$/i.exec(value);
        const scheme = match ? match[1] : 'file';
        const rest = match ? decodeURIComponent(match[2]) : value;
        return { scheme, path: rest, fsPath: rest, toString: () => value };
      },
      joinPath: (base, ...segments) => uriFor(path.join(base.fsPath, ...segments))
    },
    Range: class Range {
      constructor(startLine, startChar, endLine, endChar) {
        this.start = position(startLine, startChar);
        this.end = position(endLine, endChar);
      }
    },
    Position: class Position {
      constructor(line, character) {
        this.line = line;
        this.character = character;
      }
    },
    Selection: class Selection {
      constructor(start, end) {
        this.start = start;
        this.end = end;
        this.active = end;
        this.isEmpty = start.line === end.line && start.character === end.character;
      }
    },
    RelativePattern: class RelativePattern {
      constructor(base, pattern) {
        this.base = base;
        this.pattern = pattern;
      }
    },
    ThemeColor: class ThemeColor {
      constructor(id) {
        this.id = id;
      }
    },
    EventEmitter: class EventEmitter {
      constructor() {
        this.listeners = [];
      }
      get event() {
        return (cb) => {
          this.listeners.push(cb);
          return { dispose: () => {} };
        };
      }
      fire(value) {
        this.listeners.forEach((cb) => cb(value));
      }
      dispose() {}
    },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    ViewColumn: { Active: -1, Beside: -2, One: 1 },
    TextEditorRevealType: { InCenter: 2 },
    OverviewRulerLane: { Left: 1 },
    ExtensionMode: { Test: 3 },
    window: window_,
    workspace,
    languages: { getDiagnostics: () => options.diagnostics || [] },
    commands: {
      registerCommand(id, handler) {
        commands.set(id, handler);
        return { dispose: () => {} };
      },
      async executeCommand(id, ...args) {
        const handler = commands.get(id);
        if (handler) {
          return handler(...args);
        }
        return undefined;
      }
    },
    env: {
      clipboard: { writeText: async (text) => log.info.push(`clipboard:${text.slice(0, 30)}`) },
      openExternal: async () => true
    }
  };

  const context = {
    subscriptions: [],
    extension: { packageJSON: { name: 'agentcode', version: '0.1.0' } },
    extensionUri: uriFor(options.extensionRoot || path.resolve(__dirname, '..')),
    extensionPath: options.extensionRoot || path.resolve(__dirname, '..'),
    globalState: makeMemento(),
    workspaceState: makeMemento(),
    secrets: {
      async get(key) {
        return secrets.get(key);
      },
      async store(key, value) {
        secrets.set(key, value);
      },
      async delete(key) {
        secrets.delete(key);
      },
      onDidChange: () => ({ dispose: () => {} })
    },
    asAbsolutePath: (relative) => path.join(options.extensionRoot || path.resolve(__dirname, '..'), relative)
  };

  return {
    vscode,
    context,
    state: {
      log,
      commands,
      views,
      statusBars,
      terminals,
      configuration,
      secrets,
      channels,
      get view() {
        return views[0];
      }
    },
    setConfig(key, value) {
      configuration[key] = value;
    }
  };
}

function makeMemento() {
  const store = new Map();
  return {
    get(key, fallback) {
      return store.has(key) ? store.get(key) : fallback;
    },
    async update(key, value) {
      store.set(key, value);
    },
    keys: () => [...store.keys()],
    setKeysForSync: () => {}
  };
}

module.exports = { createHost };
