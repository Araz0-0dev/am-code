import * as vscode from 'vscode';
import { ApprovalPresenter } from '../host/approvals';
import { ExtToWebview, UiItem, WebviewState, WebviewToExt } from './protocol';
import webviewJs from './webview.wvjs';
import webviewCss from './webview.css';

export interface ChatViewHandlers {
  onMessage(message: WebviewToExt): void | Promise<void>;
  getState(): WebviewState;
}

export class ChatViewProvider implements vscode.WebviewViewProvider, ApprovalPresenter {
  public static readonly viewType = 'agentcode.chat';

  private view?: vscode.WebviewView;
  private items: UiItem[] = [];
  private iconUri = '';

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly handlers: ChatViewHandlers
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    try {
      this.iconUri = view.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.png')).toString();
    } catch {
      this.iconUri = '';
    }
    view.webview.html = buildHtml(view.webview, this.iconUri);
    view.webview.onDidReceiveMessage((message: WebviewToExt) => {
      void this.handlers.onMessage(message);
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.postState();
      }
    });
    view.onDidDispose(() => {
      this.view = undefined;
    });
  }

  /** ApprovalPresenter: is the panel actually on screen? */
  isVisible(): boolean {
    return Boolean(this.view?.visible);
  }

  post(message: ExtToWebview): void {
    void this.view?.webview.postMessage(message);
  }

  postState(): void {
    const state = this.handlers.getState();
    state.iconUri = this.iconUri || state.iconUri;
    this.post({ type: 'state', state });
  }

  async reveal(): Promise<void> {
    try {
      await vscode.commands.executeCommand(`workbench.view.extension.agentcode`);
    } catch {
      /* container id may differ in older versions */
    }
    try {
      await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
    } catch {
      /* view may not be registered yet */
    }
  }

  toast(message: string, level: 'info' | 'warn' | 'ok' = 'info'): void {
    this.post({ type: 'toast', message, level });
  }

  getItems(): UiItem[] {
    return this.items;
  }

  setItems(items: UiItem[]): void {
    this.items = items;
    this.post({ type: 'reset' });
    this.postState();
  }

  /** ApprovalPresenter */
  postItem(item: UiItem): void {
    const index = this.items.findIndex((i) => i.id === item.id);
    if (index >= 0) {
      this.items[index] = item;
    } else {
      this.items.push(item);
    }
    this.post({ type: 'upsert', item });
  }

  patchItem(id: string, patch: Partial<UiItem>): void {
    const index = this.items.findIndex((i) => i.id === id);
    if (index < 0) {
      return;
    }
    this.items[index] = { ...this.items[index], ...patch } as UiItem;
    this.post({ type: 'upsert', item: this.items[index] });
  }

  appendDelta(id: string, channel: 'text' | 'reasoning', text: string): void {
    const index = this.items.findIndex((i) => i.id === id);
    if (index < 0) {
      return;
    }
    const item = this.items[index];
    if (item.kind !== 'assistant') {
      return;
    }
    if (channel === 'reasoning') {
      item.reasoning = `${item.reasoning ?? ''}${text}`;
    } else {
      item.text = `${item.text ?? ''}${text}`;
    }
    this.post({ type: 'delta', id, channel, text });
  }

  setUsage(usage: { inputTokens: number; outputTokens: number }, contextTokens: number): void {
    this.post({ type: 'usage', usage, contextTokens });
  }

  focusComposer(): void {
    this.post({ type: 'focusComposer' });
  }

  prefill(text: string): void {
    this.post({ type: 'prefill', text });
  }

  addImages(images: string[]): void {
    this.post({ type: 'images', images });
  }
}

function buildHtml(webview: vscode.Webview, iconUri: string): string {
  const nonce = randomNonce();
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data: https:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<title>AM Code</title>
<style nonce="${nonce}">${webviewCss}</style>
</head>
<body>
<div id="app">
  <div class="appbar">
    <button class="iconbtn" id="btnMenu" title="Menu"></button>
    <span class="brand" id="brand">
      ${iconUri ? `<img id="brandIcon" src="${iconUri}" alt="" />` : ''}
      <span>AM Code</span>
      <span class="ver" id="brandVer"></span>
    </span>
    <div id="tabbar" class="tabbar"></div>
    <div class="grow"></div>
    <span class="winDots" aria-hidden="true"><i></i><i></i><i></i></span>
  </div>
  <header>
    <div class="topbar">
      <span class="brand brandInline">
        ${iconUri ? `<img id="brandIcon" src="${iconUri}" alt="" />` : ''}
        <span>AM Code</span>
        <span class="ver" id="brandVer"></span>
      </span>
      <div class="grow"></div>
      <button class="iconbtn" id="btnNew" title="New session"></button>
      <button class="iconbtn" id="btnCompact" title="Compact the conversation (free context)"></button>
      <button class="iconbtn" id="btnUndo" title="Undo the last agent edit (Ctrl+Alt+Z)"></button>
      <button class="iconbtn" id="btnSettings" title="Settings"></button>
    </div>
    <div class="modelRow">
      <div class="modelWrap">
        <select id="model" title="Active model"></select>
        <span class="caret">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </span>
      </div>
      <button class="iconbtn" id="btnAddModel" title="Add a model (Base URL + Model ID)"></button>
    </div>
    <div class="chips">
      <span class="chip" id="usage">0 tokens</span>
      <span class="chip" id="ctx">context 0%</span>
      <span class="chip" id="steps">step 0/40</span>
      <span class="chip ok" id="statusLine">ready</span>
    </div>
    <div id="todoPanel"></div>
  </header>
  <section id="modelsPage" class="overlay" hidden></section>
  <main id="stream"></main>
  <footer>
    <div id="attachments"></div>
    <div class="composer">
      <textarea id="input" rows="1" placeholder="Ask anything, / for commands, @ for context…"></textarea>
      <div class="bar2">
        <button class="chipBtn plusBtn" id="btnAttach" title="Attach, add a model or an MCP server">+</button>
        <button class="chipBtn" id="btnMode" title="Agent mode"></button>
        <button class="chipBtn" id="btnModelChip" title="Active model"></button>
        <button class="chipBtn" id="btnAuto" title="Autonomy level"></button>
        <div class="grow"></div>
        <button class="iconbtn" id="btnImage" title="Attach images (vision models)"></button>
        <button id="btnSend" title="Send (Enter)"></button>
        <button id="btnStop" hidden>Stop</button>
      </div>
      <div class="statusRow" id="statusRow"></div>
      <div class="bar2 credit">
        <span id="credit"></span>
      </div>
    </div>
    <div id="slashMenu" class="menu" hidden></div>
    <div id="mentionMenu" class="menu" hidden></div>
  </footer>
</div>
<div id="toasts"></div>
<script nonce="${nonce}">${webviewJs}</script>
</body>
</html>`;
}

function randomNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i += 1) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
