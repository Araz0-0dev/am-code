/**
 * A small `vscode` API shim so the AM Code extension can run unchanged inside the desktop app.
 *
 * The extension is bundled with esbuild and `vscode` is aliased to this file, which means the
 * desktop build reuses *exactly* the same agent loop, panel UI, tool runner and MCP client as
 * the VS Code extension — there is only one implementation to maintain.
 */

import { ChildProcess, spawn } from 'child_process';
import * as fsp from 'fs/promises';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BrowserWindow, clipboard, dialog, Notification, shell } from 'electron';

// --------------------------------------------------------------------------- utilities

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Glob → RegExp. Supports **, *, ?, {a,b} — enough for every pattern the extension uses. */
export function globToRegExp(pattern: string): RegExp {
  const src = toPosix(pattern);
  let out = '';
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (c === '*') {
      if (src[i + 1] === '*') {
        if (src[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '{') {
      const end = src.indexOf('}', i);
      if (end > 0) {
        const options = src
          .slice(i + 1, end)
          .split(',')
          .map((option) => option.replace(/[.+^${}()|[\]\\]/g, '\\$&'));
        out += `(?:${options.join('|')})`;
        i = end;
      } else {
        out += '\\{';
      }
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

export class Disposable {
  constructor(private readonly callOnDispose: () => void = () => undefined) {}
  dispose(): void {
    this.callOnDispose();
  }
  static from(...items: Array<{ dispose(): void }>): Disposable {
    return new Disposable(() => items.forEach((item) => item.dispose()));
  }
}

export class EventEmitter<T> {
  private readonly listeners = new Set<(value: T) => void>();
  readonly event = (listener: (value: T) => void): Disposable => {
    this.listeners.add(listener);
    return new Disposable(() => this.listeners.delete(listener));
  };
  fire(value: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(value);
      } catch {
        /* a broken listener must not break the emitter */
      }
    }
  }
  dispose(): void {
    this.listeners.clear();
  }
}

export class Position {
  constructor(readonly line: number, readonly character: number) {}
}

export class Range {
  readonly start: Position;
  readonly end: Position;
  constructor(startLine: number, startChar: number, endLine: number, endChar: number) {
    this.start = new Position(startLine, startChar);
    this.end = new Position(endLine, endChar);
  }
  get isEmpty(): boolean {
    return this.start.line === this.end.line && this.start.character === this.end.character;
  }
}

export class Selection extends Range {}

export class ThemeColor {
  constructor(readonly id: string) {}
}

export class Uri {
  private constructor(readonly scheme: string, readonly fsPath: string, readonly query = '', readonly fragment = '') {}

  static file(p: string): Uri {
    return new Uri('file', path.resolve(p));
  }
  static parse(value: string): Uri {
    const match = /^([a-zA-Z][\w+.-]*):(.*)$/.exec(value);
    if (!match) {
      return new Uri('file', path.resolve(value));
    }
    const rest = match[2];
    if (match[1] === 'file') {
      return new Uri('file', path.resolve(decodeURIComponent(rest.replace(/^\/+/, '') ? rest : rest)));
    }
    const [pathPart, fragment] = rest.split('#');
    return new Uri(match[1], decodeURIComponent(pathPart), '', fragment ?? '');
  }
  static joinPath(base: Uri, ...parts: string[]): Uri {
    return Uri.file(path.join(base.fsPath, ...parts));
  }
  get path(): string {
    return this.scheme === 'file' ? toPosix(this.fsPath) : this.fsPath;
  }
  toString(): string {
    return this.scheme === 'file' ? `file://${toPosix(this.fsPath)}` : `${this.scheme}:${this.fsPath}`;
  }
  with(change: { scheme?: string; fsPath?: string }): Uri {
    return new Uri(change.scheme ?? this.scheme, change.fsPath ?? this.fsPath, this.query, this.fragment);
  }
  toJSON(): string {
    return this.toString();
  }
}

export class RelativePattern {
  constructor(readonly base: Uri | { uri: Uri } | string, readonly pattern: string) {}
  get baseUri(): Uri {
    const base = this.base as Uri & { uri?: Uri };
    if (base && typeof base === 'object' && base.uri) {
      return base.uri;
    }
    if (typeof this.base === 'string') {
      return Uri.file(this.base);
    }
    return this.base as Uri;
  }
}

export class ThemeIcon {
  constructor(readonly id: string) {}
}

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2
}

export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
  Two = 2,
  Three = 3
}

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3
}

export enum OverviewRulerLane {
  Left = 1,
  Center = 2,
  Right = 4,
  Full = 7
}

export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15
}

export enum TextEditorRevealType {
  Default = 0,
  InCenter = 1,
  InCenterIfOutsideViewport = 2,
  AtTop = 3
}

export enum EndOfLine {
  LF = 1,
  CRLF = 2
}

// --------------------------------------------------------------------------- state

export interface ShimOptions {
  /** Workspace folder the tools operate on. */
  root: string;
  /** Path of the JSON settings file (userData/settings.json). */
  configPath: string;
  /** Secret storage implementation (safeStorage backed). */
  secrets: SecretStorageLike;
  /** Version reported to the panel. */
  version: string;
  /** PNG used for the brand icon in the panel (inlined as a data URI). */
  iconPath: string;
  /** Called whenever the panel HTML is (re)built. */
  onHtml?: (html: string) => void;
  /** Called when the status bar text changes. */
  onStatusBar?: (text: string, tooltip: string) => void;
  /** Appends a line to the desktop log. */
  log?: (line: string) => void;
}

/**
 * Live module bindings: `import * as vscode from 'vscode'` resolves these, and
 * `createVscodeShim()` fills them in before the extension is activated.
 */
export let workspace: any;
export let window: any;
export let env: any;
export let commands: any;
export let languages: any;

export interface SecretStorageLike {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

interface Memento {
  get<T>(key: string, defaultValue?: T): T | undefined;
  update(key: string, value: unknown): Promise<void>;
  keys(): readonly string[];
}

interface PendingWebviewView {
  webview: {
    html: string;
    options: unknown;
    asWebviewUri(uri: Uri): Uri;
    onDidReceiveMessage(cb: (message: unknown) => void): Disposable;
    postMessage(message: unknown): Promise<boolean>;
    cspSource: string;
  };
  visible: boolean;
  onDidChangeVisibility(cb: () => void): Disposable;
  onDidDispose(cb: () => void): Disposable;
}

export function createVscodeShim(options: ShimOptions) {
  // tells the panel it is running in the desktop app (labels change, no VS Code settings screen)
  (globalThis as unknown as { __AMCODE_DESKTOP__?: boolean }).__AMCODE_DESKTOP__ = true;
  const log = options.log ?? (() => undefined);
  let root = path.resolve(options.root);
  const settings = loadSettings(options.configPath);
  const onConfigChanged = new EventEmitter<{ affectsConfiguration(section: string): boolean }>();
  const statusBarEmitter = new EventEmitter<void>();
  const statusBarItems = new Set<{ text: string; tooltip: string }>();

  // ----- settings file
  function loadSettings(file: string): Record<string, unknown> {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  function saveSettings(): void {
    try {
      fs.mkdirSync(path.dirname(options.configPath), { recursive: true });
      fs.writeFileSync(options.configPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    } catch (err) {
      log(`failed to write settings: ${String(err)}`);
    }
  }

  function sectionValues(section: string): Record<string, unknown> {
    const parts = section.split('.');
    let current: any = settings;
    for (const part of parts) {
      if (current == null || typeof current !== 'object') {
        return {};
      }
      current = current[part];
    }
    return current && typeof current === 'object' && !Array.isArray(current) ? { ...current } : {};
  }

  function getConfiguration(section: string) {
    return {
      get<T>(key: string, defaultValue?: T): T {
        const values = sectionValues(section);
        const value = values[key];
        return (value === undefined ? defaultValue : (value as T)) as T;
      },
      has(key: string): boolean {
        return sectionValues(section)[key] !== undefined;
      },
      inspect(key: string) {
        return { key, globalValue: sectionValues(section)[key] };
      },
      async update(key: string, value: unknown): Promise<void> {
        const parts = section.split('.');
        let current: any = settings;
        for (const part of parts) {
          if (current[part] == null || typeof current[part] !== 'object') {
            current[part] = {};
          }
          current = current[part];
        }
        if (value === undefined) {
          delete current[key];
        } else {
          current[key] = value;
        }
        saveSettings();
        onConfigChanged.fire({
          affectsConfiguration: (wanted: string) => `${section}.${key}`.startsWith(wanted) || wanted.startsWith(section)
        });
      }
    };
  }

  // ----- workspace folders
  const folder = () => ({
    uri: Uri.file(root),
    name: path.basename(root) || root,
    index: 0
  });

  async function walk(dir: string, include: RegExp, exclude: RegExp[], max: number, out: string[]): Promise<void> {
    if (out.length >= max) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= max) {
        return;
      }
      const abs = path.join(dir, entry.name);
      const rel = toPosix(path.relative(root, abs));
      if (exclude.some((pattern) => pattern.test(rel) || pattern.test(`${rel}/`))) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(abs, include, exclude, max, out);
      } else if (include.test(rel)) {
        out.push(abs);
      }
    }
  }

  async function findFiles(
    include: string | RelativePattern,
    exclude?: string | null,
    maxResults = 256
  ): Promise<Uri[]> {
    let pattern: string;
    let base = root;
    if (include instanceof RelativePattern) {
      pattern = include.pattern;
      base = include.baseUri.fsPath;
    } else {
      pattern = include;
    }
    const includeRe = globToRegExp(pattern);
    const excludeRe = (typeof exclude === 'string' ? exclude.split(',') : [])
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => globToRegExp(toPosix(p)));
    const found: string[] = [];
    const originalRoot = root;
    root = base; // walk() computes paths relative to the search base
    try {
      await walk(base, includeRe, excludeRe, maxResults, found);
    } finally {
      root = originalRoot;
    }
    return found.map((file) => Uri.file(file));
  }

  // ----- documents & editors
  const textDocuments = new Map<string, FakeDocument>();

  class FakeDocument {
    readonly uri: Uri;
    readonly isUntitled = false;
    private text: string;
    constructor(uri: Uri, text: string) {
      this.uri = uri;
      this.text = text;
    }
    getText(range?: Range): string {
      if (!range) {
        return this.text;
      }
      const lines = this.text.split(/\r?\n/);
      return lines.slice(range.start.line, range.end.line + 1).join('\n');
    }
    get lineCount(): number {
      return this.text.split(/\r?\n/).length;
    }
    positionAt(offset: number): Position {
      const before = this.text.slice(0, offset).split('\n');
      return new Position(before.length - 1, before[before.length - 1].length);
    }
    lineAt(line: number): { text: string; range: Range } {
      const lines = this.text.split(/\r?\n/);
      const value = lines[Math.max(0, Math.min(lines.length - 1, line))] ?? '';
      return { text: value, range: new Range(line, 0, line, value.length) };
    }
    async save(): Promise<boolean> {
      if (this.uri.scheme === 'file') {
        await fsp.writeFile(this.uri.fsPath, this.text, 'utf8');
        return true;
      }
      return false;
    }
  }

  const contentProviders = new Map<string, { provideTextDocumentContent(uri: Uri): string }>();

  async function openTextDocument(uriOrPath: Uri | string): Promise<FakeDocument> {
    const uri = typeof uriOrPath === 'string' ? Uri.file(uriOrPath) : uriOrPath;
    const key = uri.toString();
    const cached = textDocuments.get(key);
    if (cached) {
      return cached;
    }
    let text = '';
    const provider = contentProviders.get(uri.scheme);
    if (provider) {
      text = provider.provideTextDocumentContent(uri);
    } else if (uri.scheme === 'file') {
      try {
        text = await fsp.readFile(uri.fsPath, 'utf8');
      } catch {
        text = '';
      }
    }
    const doc = new FakeDocument(uri, text);
    textDocuments.set(key, doc);
    return doc;
  }

  const viewers = new Set<BrowserWindow>();

  interface ViewerRequest {
    title: string;
    left?: { label: string; content: string };
    right: { label: string; content: string };
  }

  function showViewer(request: ViewerRequest, owner?: BrowserWindow | null): void {
    const win = new BrowserWindow({
      width: request.left ? 1200 : 900,
      height: 760,
      title: request.title,
      backgroundColor: '#1e1e1e',
      parent: owner && !owner.isDestroyed() ? owner : undefined,
      autoHideMenuBar: true,
      webPreferences: { sandbox: true, contextIsolation: true }
    });
    viewers.add(win);
    win.on('closed', () => viewers.delete(win));
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(viewerHtml(request))}`);
  }

  function terminalHtml(title: string, cwd: string): string {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
 :root{color-scheme:dark}
 body{margin:0;background:#101010;color:#d0d0d0;font:12.5px/1.55 ui-monospace,Consolas,monospace;height:100vh;display:flex;flex-direction:column}
 header{padding:7px 10px;background:#181818;color:#8f8f8f;border-bottom:1px solid #262626;font-size:11.5px}
 pre{flex:1;margin:0;padding:10px 12px;overflow:auto;white-space:pre-wrap;word-break:break-word}
 form{display:flex;border-top:1px solid #262626}
 input{flex:1;background:#161616;border:none;color:#e6e6e6;padding:9px 11px;font:12.5px ui-monospace,Consolas,monospace;outline:none}
 input:focus{background:#1c1c1c}
</style></head><body>
<header>${escapeHtml(title)} — ${escapeHtml(cwd)}</header>
<pre id="out"></pre>
<form id="f"><input id="cmd" placeholder="command…" autofocus autocomplete="off"></form>
<script>
 const out=document.getElementById('out'), cmd=document.getElementById('cmd');
 function line(t){ out.textContent += (out.textContent ? '\n' : '') + t; out.scrollTop = out.scrollHeight; }
 window.addEventListener('message',(e)=>{ if(e.data && e.data.line !== undefined) line(e.data.line); });
 document.getElementById('f').addEventListener('submit',(e)=>{ e.preventDefault(); const v=cmd.value.trim(); if(!v) return; window.terminalApi.run(v); cmd.value=''; });
</script></body></html>`;
  }

  function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function viewerHtml(request: ViewerRequest): string {
    const pane = (label: string, content: string, cls: string) =>
      `<section class="${cls}"><header>${escapeHtml(label)}</header><pre>${escapeHtml(content) || '<span class="dim">(empty)</span>'}</pre></section>`;
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(request.title)}</title>
<style>
 :root{color-scheme:dark}
 body{margin:0;background:#1e1e1e;color:#d4d4d4;font:13px/1.5 "Segoe UI",system-ui,sans-serif;height:100vh;display:flex;flex-direction:column}
 h1{font-size:13px;margin:0;padding:10px 14px;border-bottom:1px solid #333;font-weight:600}
 .panes{flex:1;display:flex;min-height:0}
 section{flex:1;min-width:0;display:flex;flex-direction:column;border-right:1px solid #333}
 section:last-child{border-right:none}
 section header{padding:7px 12px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#9d9d9d;background:#252526}
 pre{margin:0;flex:1;overflow:auto;padding:10px 12px;font:12px/1.55 ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-word}
 .del{background:rgba(248,81,73,.14)}
 .ins{background:rgba(63,185,80,.14)}
 .dim{color:#6b6b6b}
</style></head><body>
<h1>${escapeHtml(request.title)}</h1>
<div class="panes">
${request.left ? pane(request.left.label, request.left.content, 'left') : ''}
${pane(request.right.label, request.right.content, 'right')}
</div></body></html>`;
  }

  const commandHandlers = new Map<string, (...args: any[]) => unknown>();

  // ----- messages / pickers
  async function showMessage(kind: 'info' | 'warning' | 'error', message: string, items: string[]): Promise<string | undefined> {
    const text = message.replace(/[*_`]/g, '');
    log(`${kind}: ${text}`);
    if (items.length === 0) {
      // inside the app only — no OS notification windows
      sendToPanel({ type: 'toast', message: text, level: kind === 'error' ? 'warn' : kind === 'warning' ? 'warn' : 'ok' });
      focusMainWindow();
      return undefined;
    }
    // a question with buttons is asked inside the panel as well
    const picked = await askPanel({
      kind: 'pick',
      title: 'AM Code',
      prompt: text,
      items: items.map((item) => ({ label: item }))
    });
    return picked ?? undefined;
  }

  /* ------------------------------------------------------------------ in-app prompt bridge
   * The desktop app never opens VS Code style input boxes or quick picks: the panel renders them
   * (see webview.wvjs → showInlinePrompt) and answers with an `inlinePromptResult` message.
   */
  let promptSeq = 0;
  const pendingPrompts = new Map<number, (value: string | null) => void>();

  function askPanel(prompt: {
    kind: 'input' | 'pick';
    title?: string;
    prompt?: string;
    value?: string;
    placeholder?: string;
    password?: boolean;
    items?: Array<{ label: string; description?: string }>;
  }): Promise<string | null> {
    if (!webviewView) {
      // no panel yet (very early start-up) — never block the host on a window that does not exist
      log(`prompt without panel: ${prompt.title ?? prompt.prompt ?? ''}`);
      return Promise.resolve(null);
    }
    promptSeq += 1;
    const id = promptSeq;
    return new Promise((resolve) => {
      pendingPrompts.set(id, resolve);
      sendToPanel({ type: 'inlinePrompt', prompt: { id, ...prompt } });
      setTimeout(() => {
        if (pendingPrompts.delete(id)) {
          resolve(null);
        }
      }, 5 * 60 * 1000);
    });
  }

  /** Resolves a pending in-app prompt. Returns true when the message was consumed here. */
  function settlePrompt(message: { id?: unknown; value?: unknown }): boolean {
    const id = Number(message.id);
    const resolve = pendingPrompts.get(id);
    if (!resolve) {
      return false;
    }
    pendingPrompts.delete(id);
    resolve(message.value === undefined || message.value === null ? null : String(message.value));
    return true;
  }

  /* ------------------------------------------------------------------ child processes
   * Everything the agent spawns (MCP stdio servers, terminal commands) is tracked so the app can
   * kill it on quit — otherwise node.exe children keep running after the window is closed.
   */
  const liveChildren = new Set<ChildProcess>();
  function trackChild(child: ChildProcess): ChildProcess {
    liveChildren.add(child);
    child.once('exit', () => liveChildren.delete(child));
    child.once('error', () => liveChildren.delete(child));
    return child;
  }
  function killChildren(): void {
    for (const child of liveChildren) {
      try {
        if (process.platform === 'win32' && child.pid) {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        } else {
          child.kill('SIGTERM');
        }
      } catch {
        /* best effort */
      }
    }
    liveChildren.clear();
  }

  let mainWindowRef: BrowserWindow | undefined;
  function focusMainWindow(): void {
    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
      if (mainWindowRef.isMinimized()) {
        mainWindowRef.restore();
      }
      mainWindowRef.focus();
    }
  }

  interface QuickPickEntry {
    label: string;
    description?: string;
    detail?: string;
    [key: string]: unknown;
  }

  async function showQuickPick(
    items: QuickPickEntry[] | Promise<QuickPickEntry[]>,
    quickOptions?: { title?: string; placeHolder?: string }
  ): Promise<QuickPickEntry | undefined> {
    const list = await items;
    return pickFromList(list, quickOptions ?? {});
  }

  function pickFromList(
    items: QuickPickEntry[],
    quickOptions: { title?: string; placeHolder?: string }
  ): Promise<QuickPickEntry | undefined> {
    return askPanel({
      kind: 'pick',
      title: quickOptions.title ?? 'AM Code',
      prompt: quickOptions.placeHolder ?? '',
      items: items.map((item) => ({ label: String(item.label ?? ''), description: String(item.description ?? '') }))
    }).then((label) => {
      if (label === null) {
        return undefined;
      }
      return items.find((item) => String(item.label) === label);
    });
  }


  async function showInputBox(inputOptions: {
    title?: string;
    prompt?: string;
    value?: string;
    placeHolder?: string;
    password?: boolean;
  }): Promise<string | undefined> {
    const answer = await askPanel({
      kind: 'input',
      title: inputOptions.title ?? 'AM Code',
      prompt: inputOptions.prompt,
      value: inputOptions.value,
      placeholder: inputOptions.placeHolder,
      password: inputOptions.password
    });
    return answer === null ? undefined : answer;
  }

  function applyFullConfigDefaults(): void {
    // Desktop-friendly defaults: no LSP in the desktop app, no integrated terminal.
    const agentcode = (settings.agentcode = (settings.agentcode as Record<string, unknown>) ?? {});
    if (agentcode.includeDiagnostics === undefined) {
      agentcode.includeDiagnostics = false;
    }
    if (agentcode.useIntegratedTerminal === undefined) {
      agentcode.useIntegratedTerminal = false;
    }
    if (agentcode.interfaceLayout === undefined) {
      agentcode.interfaceLayout = 'ultra';
    }
    if (agentcode.mcpServers === undefined) {
      agentcode.mcpServers = [];
    }
    saveSettings();
  }
  applyFullConfigDefaults();

  // ----- webview view (only one panel in the desktop app)
  let webviewView: PendingWebviewView | undefined;
  let webviewProvider: { resolveWebviewView(view: unknown): void } | undefined;
  let panelMessageHandler: ((message: unknown) => void) | undefined;
  const iconDataUri = (() => {
    try {
      const bytes = fs.readFileSync(options.iconPath);
      return `data:image/png;base64,${bytes.toString('base64')}`;
    } catch {
      return '';
    }
  })();

  const pendingToPanel: unknown[] = [];
  let panelReady = false;

  /** Called by main.ts once the panel document has finished loading. */
  function markPanelReady(): void {
    panelReady = true;
    flushPanelQueue();
  }

  /** Host → panel (queued until the webview document exists). */
  function sendToPanel(message: unknown): void {
    deliverToPanel(message);
  }

  function deliverToPanel(message: unknown): void {
    if (panelReady && mainWindowRef && !mainWindowRef.isDestroyed()) {
      try {
        options.log?.(`host → panel: ${String((message as { type?: string })?.type)}`);
      } catch {
        /* ignore */
      }
      mainWindowRef.webContents.send('amcode:host-message', message);
    } else {
      options.log?.(`panel message queued: ${String((message as { type?: string })?.type)}`);
      pendingToPanel.push(message);
    }
  }

  function flushPanelQueue(): void {
    while (pendingToPanel.length) {
      const message = pendingToPanel.shift();
      mainWindowRef?.webContents.send('amcode:host-message', message);
    }
  }

  function createWebviewView(): PendingWebviewView {
    const messageEmitter = new EventEmitter<unknown>();
    return {
      webview: {
        html: '',
        options: {},
        cspSource: "'self' data:",
        asWebviewUri: (uri: Uri) => (uri.fsPath.endsWith('.png') ? Uri.parse(iconDataUri) : uri),
        onDidReceiveMessage: (cb: (message: unknown) => void) => {
          panelMessageHandler = cb;
          return messageEmitter.event(cb);
        },
        postMessage: async (message: unknown) => {
          deliverToPanel(message);
          return true;
        }
      },
      visible: true,
      onDidChangeVisibility: () => new Disposable(),
      onDidDispose: () => new Disposable()
    };
  }

  const extensionContext = {
    extensionUri: Uri.file(path.resolve(__dirname, '..')),
    extension: { packageJSON: { version: options.version, name: 'am-code', displayName: 'AM Code' } },
    subscriptions: [] as Array<{ dispose(): void }>,
    globalState: makeMemento('global'),
    workspaceState: makeMemento('workspace'),
    secrets: options.secrets
  };

  function makeMemento(scope: string): Memento {
    const key = `__memento_${scope}`;
    const data = (settings[key] as Record<string, unknown>) ?? {};
    settings[key] = data;
    return {
      get<T>(k: string, defaultValue?: T): T | undefined {
        return (data[k] === undefined ? defaultValue : (data[k] as T)) as T | undefined;
      },
      async update(k: string, value: unknown): Promise<void> {
        if (value === undefined) {
          delete data[k];
        } else {
          data[k] = value;
        }
        saveSettings();
      },
      keys: () => Object.keys(data)
    };
  }

  // ------------------------------------------------------------------ the module itself

  const workspaceApi = {
    get name(): string {
      return path.basename(root);
    },
    get workspaceFolders() {
      return [folder()];
    },
    get rootPath(): string {
      return root;
    },
    get textDocuments(): FakeDocument[] {
      return [...textDocuments.values()];
    },
    getConfiguration,
    onDidChangeConfiguration: onConfigChanged.event,
    onDidSaveTextDocument: () => new Disposable(),
    onDidChangeTextDocument: () => new Disposable(),
    onDidOpenTextDocument: () => new Disposable(),
    asRelativePath(target: Uri | string, includeWorkspaceFolder = false): string {
      const abs = typeof target === 'string' ? target : target.fsPath;
      const rel = toPosix(path.relative(root, path.resolve(abs)));
      if (rel.startsWith('..')) {
        return toPosix(abs);
      }
      return includeWorkspaceFolder ? `${path.basename(root)}/${rel}` : rel;
    },
    findFiles,
    openTextDocument,
    registerTextDocumentContentProvider: (scheme: string, provider: { provideTextDocumentContent(uri: Uri): string }) => {
      contentProviders.set(scheme, provider);
      return new Disposable(() => contentProviders.delete(scheme));
    },
    fs: {
      async stat(uri: Uri) {
        const info = await fsp.stat(uri.fsPath);
        return { type: info.isDirectory() ? 2 : 1, ctime: info.ctimeMs, mtime: info.mtimeMs, size: info.size };
      },
      async readFile(uri: Uri) {
        return fsp.readFile(uri.fsPath);
      },
      async writeFile(uri: Uri, content: Uint8Array) {
        await fsp.mkdir(path.dirname(uri.fsPath), { recursive: true });
        await fsp.writeFile(uri.fsPath, content);
      },
      async createDirectory(uri: Uri) {
        await fsp.mkdir(uri.fsPath, { recursive: true });
      }
    }
  };

  let fakeTerminalOpened = false;

  const windowNamespace = {
    get activeTextEditor(): undefined {
      return undefined;
    },
    get visibleTextEditors(): unknown[] {
      return [];
    },
    showInformationMessage: (message: string, ...items: string[]) => showMessage('info', message, items),
    showWarningMessage: (message: string, ...items: string[]) => showMessage('warning', message, items),
    showErrorMessage: (message: string, ...items: string[]) => showMessage('error', message, items),
    showQuickPick,
    showInputBox,
    showOpenDialog: async (openOptions?: { canSelectFolders?: boolean; canSelectMany?: boolean; defaultUri?: Uri; title?: string }) => {
      const owner = BrowserWindow.getAllWindows()[0];
      const result = await dialog.showOpenDialog(owner && !owner.isDestroyed() ? owner : undefined!, {
        title: openOptions?.title ?? 'Select',
        properties: [openOptions?.canSelectFolders === false ? 'openFile' : 'openDirectory', openOptions?.canSelectMany ? 'multiSelections' : 'openFile'],
        defaultPath: openOptions?.defaultUri?.fsPath ?? root
      });
      return result.canceled ? undefined : result.filePaths.map((file) => Uri.file(file));
    },
    showSaveDialog: async (saveOptions?: { defaultUri?: Uri; filters?: Record<string, string[]>; title?: string }) => {
      const owner = BrowserWindow.getAllWindows()[0];
      const result = await dialog.showSaveDialog(owner && !owner.isDestroyed() ? owner : undefined!, {
        title: saveOptions?.title ?? 'Save as',
        defaultPath: saveOptions?.defaultUri?.fsPath ?? path.join(root, 'session.md')
      });
      return result.canceled || !result.filePath ? undefined : Uri.file(result.filePath);
    },
    withProgress: async <T>(_options: unknown, task: (progress: { report(value: { message?: string; increment?: number }): void }, token: { isCancellationRequested: boolean; onCancellationRequested: () => Disposable }) => Promise<T>): Promise<T> =>
      task({ report: (value) => log(`progress: ${value?.message ?? ''}`) }, { isCancellationRequested: false, onCancellationRequested: () => new Disposable() }),
    showTextDocument: async (doc: FakeDocument, _viewColumn?: unknown, _options?: unknown) => {
      showViewer({ title: `AM Code — ${workspace.asRelativePath(doc.uri, false)}`, right: { label: path.basename(doc.uri.fsPath), content: doc.getText() } });
      return {
        document: doc,
        selection: new Selection(0, 0, 0, 0),
        visibleRanges: [],
        setDecorations: () => undefined,
        revealRange: () => undefined,
        edit: async () => true
      };
    },
    createStatusBarItem: () => {
      const item = {
        text: '',
        tooltip: '',
        command: undefined as string | undefined,
        show() {
          statusBarItems.add(item);
          options.onStatusBar?.(item.text, String(item.tooltip ?? ''));
        },
        hide() {
          statusBarItems.delete(item);
        },
        dispose() {
          statusBarItems.delete(item);
        }
      };
      const originalShow = item.show.bind(item);
      Object.defineProperty(item, 'show', { value: originalShow });
      const handler = {
        set(target: typeof item, prop: string, value: unknown) {
          (target as unknown as Record<string, unknown>)[prop] = value;
          if (prop === 'text' || prop === 'tooltip') {
            options.onStatusBar?.(target.text, String(target.tooltip ?? ''));
          }
          return true;
        }
      };
      void statusBarEmitter.event(() => undefined);
      return new Proxy(item, handler);
    },
    createOutputChannel: (name: string) => ({
      name,
      appendLine: (line: string) => log(`[${name}] ${line}`),
      append: (line: string) => log(`[${name}] ${line}`),
      show: () => undefined,
      hide: () => undefined,
      clear: () => undefined,
      dispose: () => undefined
    }),
    createTerminal: (terminalOptions?: { name?: string; cwd?: string }) => {
      const win = new BrowserWindow({
        width: 760,
        height: 460,
        title: terminalOptions?.name ?? 'AM Code terminal',
        backgroundColor: '#101010',
        autoHideMenuBar: true,
        webPreferences: { sandbox: true, contextIsolation: true, preload: path.join(__dirname, 'preload-aux.js') }
      });
      const cwd = terminalOptions?.cwd ?? root;
      const write = (line: string) => {
        if (!win.isDestroyed()) {
          win.webContents.send('terminal-line', line);
        }
      };
      let running = false;
      const run = (command: string) => {
        if (running) {
          write(`> already running\n`);
          return;
        }
        running = true;
        write(`$ ${command}`);
        const child = trackChild(spawn(command, { cwd, shell: true, windowsHide: true }));
        child.stdout?.on('data', (chunk) => write(String(chunk).replace(/\n$/, '')));
        child.stderr?.on('data', (chunk) => write(String(chunk).replace(/\n$/, '')));
        child.on('exit', (code) => {
          running = false;
          write(`[exit ${code ?? 0}]`);
        });
      };
      void win.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(terminalHtml(terminalOptions?.name ?? 'AM Code terminal', cwd))}`
      );
      win.webContents.once('did-finish-load', () => {
        write(`# AM Code terminal — ${cwd}`);
        write('# agent commands run here so you can watch them');
      });
      win.webContents.on('ipc-message', (_event, channel, payload: string) => {
        if (channel === 'terminal-run' && typeof payload === 'string') {
          run(payload);
        }
      });
      fakeTerminalOpened = true;
      return {
        name: terminalOptions?.name ?? 'AM Code',
        processId: Promise.resolve(0),
        sendText: (text: string) => run(text),
        show: () => win.show(),
        hide: () => win.hide(),
        dispose: () => win.close()
      };
    },
    createTextEditorDecorationType: () => ({ key: 'decoration', dispose: () => undefined }),
    onDidChangeActiveTextEditor: () => new Disposable(),
    onDidChangeTextEditorSelection: () => new Disposable(),
    onDidChangeVisibleTextEditors: () => new Disposable(),
    registerWebviewViewProvider: (viewType: string, provider: { resolveWebviewView(view: unknown): void }) => {
      webviewProvider = provider;
      webviewView = createWebviewView();
      provider.resolveWebviewView(webviewView);
      return new Disposable(() => {
        webviewProvider = undefined;
      });
    },
    createWebviewPanel: (viewType: string, title: string, _column?: unknown, _options?: unknown) => {
      const view = createWebviewView();
      return {
        viewType,
        title,
        visible: true,
        webview: view.webview,
        onDidDispose: () => new Disposable(),
        onDidChangeViewState: () => new Disposable(),
        reveal: () => undefined,
        dispose: () => undefined
      };
    }
  };

  const api = {
    version: options.version,
    Uri,
    Range,
    Position,
    Selection,
    Disposable,
    EventEmitter,
    RelativePattern,
    ThemeColor,
    ThemeIcon,
    ConfigurationTarget,
    StatusBarAlignment,
    ViewColumn,
    DiagnosticSeverity,
    OverviewRulerLane,
    ProgressLocation,
    TextEditorRevealType,
    EndOfLine,
    workspace: workspaceApi,
    window: windowNamespace,
    languages: {
      getDiagnostics: () => [] as Array<[Uri, unknown[]]>
    },
    env: {
      openExternal: async (uri: Uri) => {
        await shell.openExternal(uri.toString());
        return true;
      },
      clipboard: {
        writeText: async (text: string) => clipboard.writeText(text),
        readText: async () => clipboard.readText()
      },
      appName: 'AM Code',
      language: 'en'
    },
    commands: {
      registerCommand: (id: string, callback: (...args: any[]) => unknown) => {
        commandHandlers.set(id, callback);
        return new Disposable(() => commandHandlers.delete(id));
      },
      executeCommand: async (id: string, ...args: any[]): Promise<unknown> => {
        if (id === 'vscode.diff') {
          const [left, right, title] = args as [Uri, Uri, string];
          const leftDoc = left ? await openTextDocument(left) : undefined;
          const rightDoc = await openTextDocument(right);
          showViewer({
            title: title ?? 'AM Code diff',
            left: leftDoc ? { label: `on disk — ${workspace.asRelativePath(leftDoc.uri, false)}`, content: leftDoc.getText() } : undefined,
            right: { label: `proposed — ${workspace.asRelativePath(rightDoc.uri, false)}`, content: rightDoc.getText() }
          });
          return undefined;
        }
        if (id === 'workbench.action.files.openFolder' || id === 'workbench.action.openSettings') {
          return undefined; // handled by the desktop menu / settings screen
        }
        const handler = commandHandlers.get(id);
        if (!handler) {
          log(`command not found: ${id}`);
          return undefined;
        }
        return handler(...args);
      },
      getCommands: async () => [...commandHandlers.keys()]
    },
    extensions: {
      all: [],
      getExtension: () => undefined
    },
    // exposed so main.ts can drive the panel
    __amcode: {
      setWorkspaceFolder(next: string): void {
        root = path.resolve(next);
      },
      getRoot(): string {
        return root;
      },
      onPanelMessage(cb: (message: unknown) => void): void {
        panelMessageHandler = cb;
      },
      settlePrompt(message: { id?: unknown; value?: unknown }): boolean {
        return settlePrompt(message);
      },
      killChildren,
      cancelPrompts(): void {
        for (const [, resolve] of pendingPrompts) {
          resolve(null);
        }
        pendingPrompts.clear();
      },
      receiveMessage(message: unknown): unknown {
        if (!panelMessageHandler) {
          options.log?.('panel message dropped: no handler registered yet');
          return undefined;
        }
        return panelMessageHandler(message);
      },
      setMainWindow(win: BrowserWindow): void {
        mainWindowRef = win;
      },
      sendToPanel(message: unknown): void {
        deliverToPanel(message);
      },
      flushQueue(): void {
        flushPanelQueue();
      },
      markPanelReady(): void {
        markPanelReady();
      },
      getWebview(): PendingWebviewView | undefined {
        return webviewView;
      },
      hasWebview(): boolean {
        return Boolean(webviewView);
      },
      iconDataUri,
      dispose(): void {
        extensionContext.subscriptions.forEach((item) => item.dispose());
      }
    }
  };

  // publish the namespaces so `import * as vscode from 'vscode'` works in the bundled extension
  workspace = api.workspace;
  window = api.window;
  env = api.env;
  commands = api.commands;
  languages = api.languages;

  return { api, extensionContext, settings, saveSettings, showViewer, pickFromList, setWorkspaceRoot: (next: string) => (root = path.resolve(next)) };
}

export type VscodeShim = ReturnType<typeof createVscodeShim>;

export function tempDir(): string {
  return path.join(os.tmpdir(), 'am-code');
}
