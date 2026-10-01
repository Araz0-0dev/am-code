import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { Agent, AgentHost, HostContext } from './core/agent';
import { estimateTokens } from './core/context';
import { AgentSession } from './core/session';
import { TOOL_NAMES } from './core/tools';
import { CompressionStats, compressMessages, estimateToolSurfaceTokens, transcriptTokens } from './core/tokenSaver';
import { AgentEvent, ModelConfig, Todo } from './core/types';
import { ApprovalManager } from './host/approvals';
import { ConfigManager, McpServerPayload, cfg } from './host/config';
import { ChangeDecorator, PreviewDocumentProvider } from './host/preview';
import { SessionStore } from './host/sessionStore';
import { ToolRunner } from './host/toolRunner';
import { McpManager } from './core/mcpClient';
import { McpServerConfig, McpServerStatus } from './core/types';
import { ChatViewProvider } from './ui/chatView';
import { ModelSummary, UiItem, WebviewState, WebviewToExt } from './ui/protocol';
import { initLogger, log, logError } from './util/logger';

let chatView!: ChatViewProvider;
let mcpRef: { dispose(): void } | undefined;

/**
 * The desktop app (Electron) has no VS Code input boxes / quick picks — every one of those flows
 * happens inside the panel instead. `__AMCODE_DESKTOP__` is set by the desktop host.
 */
function hostIsDesktop(): boolean {
  return Boolean((globalThis as unknown as { __AMCODE_DESKTOP__?: boolean }).__AMCODE_DESKTOP__);
}

/**
 * Where "add a model" happens: the desktop app opens the in-app Models screen (no OS dialogs),
 * VS Code keeps the classic step-by-step wizard.
 */
function addModelFlow(config: { addModelInteractive(): Promise<unknown> }): void {
  if (hostIsDesktop()) {
    chatView.post({ type: 'modelsShow', open: 'add' });
    return;
  }
  void config.addModelInteractive();
}

/**
 * The panel's General screen may change exactly these settings (with these types) —
 * everything else stays a VS Code settings-file / config-file concern.
 */
const EDITABLE_SETTINGS: Array<{ key: string; type: 'boolean' | 'number' | 'string'; min?: number; max?: number }> = [
  { key: 'mode', type: 'string' },
  { key: 'workMode', type: 'string' },
  { key: 'maxSteps', type: 'number', min: 1, max: 200 },
  { key: 'softStepBudget', type: 'number', min: 0, max: 200 },
  { key: 'toolCallMode', type: 'string' },
  { key: 'strictChecklist', type: 'boolean' },
  { key: 'alwaysPlan', type: 'boolean' },
  { key: 'subagents', type: 'boolean' },
  { key: 'enableWebTools', type: 'boolean' },
  { key: 'autoApproveRead', type: 'boolean' },
  { key: 'autoApproveWrite', type: 'boolean' },
  { key: 'autoApproveCommands', type: 'boolean' },
  { key: 'includeOpenFileContext', type: 'boolean' },
  { key: 'includeDiagnostics', type: 'boolean' },
  { key: 'showReasoning', type: 'boolean' },
  { key: 'approvalStyle', type: 'string' },
  { key: 'useIntegratedTerminal', type: 'boolean' },
  { key: 'commandTimeoutMs', type: 'number', min: 5000, max: 1800000 },
  { key: 'thinkingBudgetHint', type: 'string' },
  { key: 'responseLanguage', type: 'string' },
  { key: 'customInstructions', type: 'string' }
];

export function activate(context: vscode.ExtensionContext): void {
  initLogger();
  log('AM Code activating…');

  const config = new ConfigManager(context.secrets);
  const preview = new PreviewDocumentProvider();
  const decorator = new ChangeDecorator();
  const store = new SessionStore(context);

  let session: AgentSession = store.loadActive() ?? new AgentSession('build');
  let keyStatus: Record<string, boolean> = {};
  let lastEditPath: string | undefined;
  let lastEditContent: { before: string; after: string } | undefined;

  const runner = new ToolRunner({
    workspaceRoot: workspaceRootPath() ?? process.cwd(),
    folder: vscode.workspace.workspaceFolders?.[0],
    commandTimeoutMs: () => cfg().get<number>('commandTimeoutMs', 120000),
    useIntegratedTerminal: () => cfg().get<boolean>('useIntegratedTerminal', false),
    enableWebTools: () => cfg().get<boolean>('enableWebTools', false),
    diagnosticsEnabled: () => cfg().get<boolean>('includeDiagnostics', true)
  });

  // ---------------------------------------------------------------- MCP servers
  let mcpServers: McpServerConfig[] = [];
  let mcpState: McpServerStatus[] = [];
  const mcp = new McpManager({
    getServers: () => mcpServers,
    log: (serverId, level, message) => {
      if (level === 'error') {
        logError(`[mcp:${serverId}] ${message}`);
      } else {
        log(`[mcp:${serverId}] ${message}`);
      }
    },
    onChanged: () => {
      mcpState = mcp.statuses();
      if (typeof chatView !== 'undefined' && chatView) {
        chatView.postState();
      }
    }
  });
  mcpRef = mcp;

  async function reloadMcp(refresh = true): Promise<void> {
    try {
      const stored = config.getMcpServers();
      mcpServers = await Promise.all(stored.map((server) => config.hydrateMcpServer(server)));
      mcpState = mcp.statuses();
      if (refresh) {
        await mcp.refresh();
        mcpState = mcp.statuses();
      }
    } catch (err) {
      logError(err);
    }
    if (chatView) {
      chatView.postState();
    }
  }

  // ---------------------------------------------------------------- presenter / views
  const presenter = {
    postItem: (item: UiItem) => chatView.postItem(item),
    patchItem: (id: string, patch: Partial<UiItem>) => chatView.patchItem(id, patch),
    reveal: () => chatView.reveal(),
    toast: (message: string, level?: 'info' | 'warn' | 'ok') => chatView.toast(message, level),
    isVisible: () => chatView.isVisible()
  };
  const approval = new ApprovalManager(config, presenter, preview);

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'agentcode.openChat';
  statusBar.show();

  // ---------------------------------------------------------------- agent host
  const host: AgentHost = {
    emit: (event) => handleAgentEvent(event),
    executeTool: (call, mode) =>
      mcp.owns(call.name) ? mcp.callTool(call.name, call.args) : runner.run(call, mode),
    getExtraTools: () => mcp.toolDefinitions(),
    requestPermission: (request) => approval.requestPermission(request),
    approvePlan: (planId, plan) => approval.approvePlan(planId, plan),
    askUser: (request) => approval.askUser(request),
    getApiKey: (model) => config.getApiKey(model),
    collectContext: () => collectContext(),
    getOptions: () => config.getRunOptions(),
    onModeChanged: (mode) => {
      updateStatusBar();
      void cfg().update('mode', mode, vscode.ConfigurationTarget.Workspace);
    },
    onTodosChanged: () => updateStatusBar(),
    save: () => {
      store.save(session);
      updateStatusBar();
    }
  };

  let agent = new Agent(host, session);

  // ---------------------------------------------------------------- chat view
  chatView = new ChatViewProvider(context.extensionUri, {
    onMessage: (message) => void handleWebviewMessage(message),
    getState: () => buildState()
  });
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatView, {
    webviewOptions: { retainContextWhenHidden: true }
  }));

  // ---------------------------------------------------------------- helpers

  let git: { available: boolean; branch?: string; dirty?: boolean } = { available: false };
  let tokenStats: CompressionStats | undefined;
  let wordmark = '';

  async function loadWordmark(): Promise<void> {
    try {
      const file = path.join(context.extensionUri.fsPath, 'media', 'wordmark.svg');
      const svg = await fs.readFile(file, 'utf8');
      // only inline a sanitized subset: an SVG we ship ourselves, no scripts, no external refs
      wordmark = svg
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/on\w+="[^"]*"/gi, '')
        .replace(/<svg([^>]*)>/i, '<svg$1 class="wordmarkSvg" aria-hidden="true">');
    } catch (err) {
      logError(err);
      wordmark = '';
    }
  }

  function tokenSaverReport() {
    const settings = config.tokenSaverSettings;
    const tools = [...mcp.toolDefinitions()];
    return {
      stats: tokenStats,
      mode: settings?.mode ?? 'balanced',
      keepRecent: settings?.keepRecent ?? 6,
      maxToolResultChars: settings?.maxToolResultChars ?? 1400,
      dedupeToolResults: settings?.dedupeToolResults !== false,
      dropOldImages: settings?.dropOldImages !== false,
      transcriptTokens: transcriptTokens(session.messages),
      toolSurfaceTokens: estimateToolSurfaceTokens(tools)
    };
  }
  let mcpSecretIds: string[] = [];

  function mcpServerIdsWithSecret(): string[] {
    return mcpSecretIds;
  }

  function mcpUiConfigs() {
    return config.getMcpServers().map((server) => {
      const scrub = (record: Record<string, string> | undefined, keys: string[] | undefined) => {
        const out: Record<string, string> = {};
        for (const [key, value] of Object.entries(record ?? {})) {
          out[key] = (keys ?? []).includes(key) ? '' : value;
        }
        return out;
      };
      const env = scrub(server.env, server.envKeys);
      const headers = scrub(server.headers, server.headerKeys);
      return {
        id: server.id,
        name: server.name,
        transport: server.transport,
        command: server.command,
        argsText: (server.args ?? []).join(' '),
        envText: Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n'),
        url: server.url,
        headersText: Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\n'),
        toolFilterText: (server.toolFilter ?? []).join(', '),
        autoApproveTools: Boolean(server.autoApproveTools),
        enabled: server.enabled !== false,
        hasSecret: mcpSecretIds.includes(server.id),
        timeoutMs: server.timeoutMs
      };
    });
  }

  async function refreshMcpSecrets(): Promise<void> {
    const ids: string[] = [];
    for (const server of config.getMcpServers()) {
      if (await config.hasMcpSecret(server)) {
        ids.push(server.id);
      }
    }
    mcpSecretIds = ids;
  }

  function refreshGitInfo(): void {
    const root = workspaceRootPath();
    if (!root) {
      git = { available: false };
      return;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { execFile } = require('child_process') as typeof import('child_process');
      execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, timeout: 4000 }, (err, stdout) => {
        if (err) {
          git = { available: false };
          return;
        }
        const branch = String(stdout).trim();
        execFile('git', ['status', '--porcelain'], { cwd: root, timeout: 4000 }, (err2, out2) => {
          git = { available: true, branch: branch || 'HEAD', dirty: !err2 && String(out2).trim().length > 0 };
          if (chatView) {
            chatView.postState();
          }
        });
      });
    } catch {
      git = { available: false };
    }
  }

  function sessionTabs(): { id: string; title: string; active: boolean; mode: 'build' | 'plan'; updatedAt: number }[] {
    return store
      .list()
      .slice(0, 8)
      .map((snapshot) => ({
        id: snapshot.id,
        title: snapshot.title || 'New session',
        active: snapshot.id === session.id,
        mode: snapshot.mode,
        updatedAt: snapshot.updatedAt
      }));
  }

  function workspaceRootPath(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  function buildState(): WebviewState {
    const models: ModelSummary[] = config.getModels().map((m) => ({
      id: m.id,
      name: m.name,
      modelId: m.modelId,
      provider: m.provider,
      baseUrl: m.baseUrl,
      hasKey: Boolean(keyStatus[m.id]),
      supportsTools: m.supportsTools !== false
    }));
    const active = config.getActiveModel();
    return {
      models,
      activeModelId: active?.id,
      mode: session.mode,
      busy: agent.isRunning,
      status: agent.isRunning ? 'working' : 'ready',
      title: session.title,
      usage: session.usage,
      steps: session.lastSteps,
      maxSteps: cfg().get<number>('maxSteps', 40),
      contextTokens: estimateTokens('', session.messages),
      contextWindow: active?.contextWindow ?? 128000,
      todos: session.todos.toJSON(),
      items: chatView ? chatView.getItems() : [],
      autoApprove: {
        read: config.autoApproveRead,
        write: config.autoApproveWrite,
        commands: config.autoApproveCommands
      },
      workMode: config.workMode,
      showReasoning: config.showReasoning,
      workspaceName: vscode.workspace.name ?? '(no folder)',
      hasWorkspace: Boolean(vscode.workspace.workspaceFolders?.length),
      version: String(context.extension?.packageJSON?.version ?? ''),
      layout: cfg().get<'auto' | 'panel' | 'ultra'>('interfaceLayout', 'auto'),
      productName: 'AM Code',
      sessions: sessionTabs(),
      git: { available: git.available, branch: git.branch, dirty: git.dirty },
      mcp: mcpState,
      mcpServers: mcpUiConfigs(),
      mcpWithSecret: mcpSecretIds,
      mcpEnabled: mcpState.filter((s) => s.enabled).length,
      tokenStats,
      tokenSaver: config.tokenSaverSettings,
      settings: Object.fromEntries(EDITABLE_SETTINGS.map((spec) => [spec.key, cfg().get(spec.key)])),
      wordmark,
      isDesktop: hostIsDesktop(),
      needsModel: config.getModels().length === 0
    };
  }

  function updateStatusBar(): void {
    const active = config.getActiveModel();
    const mode = session.mode === 'plan' ? 'PLAN' : 'BUILD';
    const todos = session.todos.stats();
    const bits: string[] = [];
    bits.push(`$(${agent.isRunning ? 'sync~spin' : 'hubot'}) AM Code · ${mode}`);
    if (active) {
      bits.push(active.name);
    } else {
      bits.push('no model');
    }
    if (todos.total > 0) {
      bits.push(`${session.todos.progressLabel()}`);
    }
    if (approval.pendingCount > 0) {
      bits.push('$(bell) action needed');
    }
    statusBar.text = bits.join(' · ');
    statusBar.tooltip = `AM Code — ${session.mode} mode\nModel: ${active ? `${active.name} (${active.modelId})` : 'none configured'}\nChecklist: ${todos.completed}/${todos.total}\nClick to open the chat`;
  }

  function setSession(next: AgentSession): void {
    session = next;
    agent = new Agent(host, session);
  }

  /** Rebuilds the chat transcript from the saved session (survives window reloads). */
  function rebuildTranscript(): void {
    const items: UiItem[] = [];
    const toolRows = new Map<string, number>();
    for (const message of session.messages) {
      const ts = message.ts ?? Date.now();
      if (message.role === 'user' && !message.internal) {
        items.push({ kind: 'user', id: `h${items.length}`, text: message.content, images: message.images, ts });
      } else if (message.role === 'assistant') {
        if ((message.content ?? '').trim()) {
          items.push({ kind: 'assistant', id: `h${items.length}`, text: message.content, done: true, ts });
        }
        for (const call of message.toolCalls ?? []) {
          toolRows.set(call.id, items.length);
          items.push({
            kind: 'tool',
            id: `call_${call.id}`,
            name: call.name,
            args: call.args ?? {},
            running: false,
            ok: true,
            summary: 'done',
            ts
          });
        }
      } else if (message.role === 'tool') {
        const index = message.toolCallId ? toolRows.get(message.toolCallId) : undefined;
        if (index !== undefined && items[index]?.kind === 'tool') {
          const row = items[index] as Extract<UiItem, { kind: 'tool' }>;
          const failed = (message.content ?? '').startsWith('ERROR');
          row.ok = !failed;
          row.running = false;
          row.summary = (message.content ?? '').split('\n')[0].slice(0, 120);
        }
      }
    }
    const tail = items.slice(-200);
    chatView.setItems(tail);
    if (session.todos.length) {
      chatView.postState();
    }
  }

  async function collectContext(): Promise<HostContext> {
    const root = workspaceRootPath();
    const rulesFiles: { path: string; content: string }[] = [];
    if (root) {
      for (const rel of config.contextFiles) {
        try {
          const content = await fs.readFile(path.join(root, rel), 'utf8');
          if (content.trim()) {
            rulesFiles.push({ path: rel, content: content.slice(0, 8000) });
          }
        } catch {
          /* file does not exist — fine */
        }
      }
    }
    const editor = vscode.window.activeTextEditor;
    let activeFile: string | undefined;
    let activeSelection: string | undefined;
    if (editor && !editor.document.isUntitled) {
      activeFile = vscode.workspace.asRelativePath(editor.document.uri, false);
      const selection = editor.selection;
      if (!selection.isEmpty) {
        const text = editor.document.getText(selection);
        if (text.trim()) {
          activeSelection = `${activeFile}:${selection.start.line + 1}-${selection.end.line + 1}\n${text.slice(0, 4000)}`;
        }
      }
    }
    const openFileList = vscode.window.visibleTextEditors
      .map((e) => vscode.workspace.asRelativePath(e.document.uri, false))
      .filter((p) => !p.startsWith('agentcode-preview'));

    let diagnosticsSummary: string | undefined;
    if (cfg().get<boolean>('includeDiagnostics', true)) {
      const lines: string[] = [];
      for (const [uri, diags] of vscode.languages.getDiagnostics()) {
        if (uri.scheme !== 'file' || diags.length === 0) {
          continue;
        }
        const rel = vscode.workspace.asRelativePath(uri, false);
        for (const d of diags.slice(0, 6)) {
          if (d.severity > vscode.DiagnosticSeverity.Warning) {
            continue;
          }
          lines.push(`${rel}:${d.range.start.line + 1} ${d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning'}: ${d.message.split('\n')[0].slice(0, 160)}`);
          if (lines.length >= 25) {
            break;
          }
        }
        if (lines.length >= 25) {
          break;
        }
      }
      diagnosticsSummary = lines.length ? lines.join('\n') : undefined;
    }

    return {
      rulesFiles,
      activeFile,
      activeSelection,
      openFileList,
      diagnosticsSummary,
      cwd: root ?? '(no workspace folder open)',
      workspaceName: vscode.workspace.name ?? 'workspace',
      os: `${process.platform} (${process.arch})`,
      today: new Date().toISOString().slice(0, 10)
    };
  }

  function handleAgentEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'assistant_start':
        chatView.postItem({ kind: 'assistant', id: event.id, text: '', done: false, model: config.getActiveModel()?.name, ts: Date.now() });
        break;
      case 'assistant_delta':
        chatView.appendDelta(event.id, 'text', event.text);
        break;
      case 'reasoning_delta':
        chatView.appendDelta(event.id, 'reasoning', event.text);
        break;
      case 'assistant_end':
        chatView.patchItem(event.id, { done: true } as Partial<UiItem>);
        break;
      case 'tool_start':
        chatView.postItem({
          kind: 'tool',
          id: event.callId,
          name: event.name,
          args: event.args,
          running: true,
          ts: Date.now()
        });
        break;
      case 'tool_end': {
        const existing = chatView.getItems().find((i) => i.id === event.callId);
        chatView.postItem({
          kind: 'tool',
          id: event.callId,
          name: event.name,
          args: existing && existing.kind === 'tool' ? existing.args : {},
          ok: event.ok,
          summary: event.summary,
          running: false,
          ts: existing?.ts ?? Date.now()
        });
        if (event.name === TOOL_NAMES.attemptCompletion && event.ok) {
          const detail = (event as AgentEvent & { detail?: string }).detail;
          void detail;
        }
        break;
      }
      case 'todos':
        chatView.postState();
        updateStatusBar();
        break;
      case 'token_saver':
        tokenStats = event.stats;
        chatView.post({ type: 'tokenStats', stats: event.stats });
        break;
      case 'notice':
        chatView.postItem({ kind: 'notice', id: `n_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, text: event.message, level: event.level ?? 'info', ts: Date.now() });
        break;
      case 'error':
        chatView.postItem({ kind: 'error', id: `e_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, text: event.message, ts: Date.now() });
        break;
      case 'usage':
        chatView.setUsage(session.usage, estimateTokens('', session.messages));
        break;
      case 'status':
        chatView.post({ type: 'busy', busy: Boolean(event.busy), status: event.text });
        updateStatusBar();
        break;
      case 'mode':
        chatView.postItem({ kind: 'mode', id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, mode: event.mode, ts: Date.now() });
        updateStatusBar();
        break;
      case 'turn_end':
        if (event.reason === 'aborted') {
          chatView.postItem({ kind: 'notice', id: `n_${Date.now()}`, text: 'Stopped by the user.', level: 'warn', ts: Date.now() });
        } else if (event.reason === 'stopped') {
          // the agent already explained why it stopped (read-only limit) — keep the transcript clean
        } else if (event.reason === 'max_steps') {
          chatView.postItem({ kind: 'notice', id: `n_${Date.now()}`, text: `Step limit reached (${cfg().get<number>('maxSteps', 40)}). Ask me to continue.`, level: 'warn', ts: Date.now() });
        }
        if (event.reason === 'completed' && event.text) {
          chatView.postItem({ kind: 'completion', id: `c_${Date.now()}`, text: event.text, ts: Date.now() });
        }
        updateStatusBar();
        break;
      default:
        break;
    }
    if (event.type === 'tool_end' && event.name === TOOL_NAMES.attemptCompletion) {
      updateStatusBar();
    }
  }

  // ---------------------------------------------------------------- webview messages

  async function handleWebviewMessage(message: WebviewToExt): Promise<void> {
    try {
      switch (message.type) {
        case 'refreshWorkspace':
          await refreshGitInfo();
          chatView.postState();
          break;
        case 'ready':
          chatView.postState();
          void refreshKeyStatus();
          break;
        case 'send':
          await sendUserMessage(message.text, message.images);
          break;
        case 'stop':
          agent.abort();
          approval.cancelAll();
          chatView.toast('Stopping the agent…', 'warn');
          break;
        case 'newSession':
          store.save(session);
          setSession(new AgentSession(cfg().get<'build' | 'plan'>('mode', 'build')));
          chatView.setItems([]);
          chatView.toast('New session started.');
          updateStatusBar();
          break;
        case 'clearSession':
          session.clear();
          chatView.setItems([]);
          store.save(session);
          updateStatusBar();
          break;
        case 'compact': {
          if (agent.isRunning) {
            chatView.toast('Stop the agent before compacting.', 'warn');
            break;
          }
          chatView.toast('Compacting the conversation…');
          await agent.compact();
          chatView.postState();
          break;
        }
        case 'selectModel':
          await config.setActiveModel(message.id);
          await refreshKeyStatus();
          chatView.postState();
          updateStatusBar();
          break;
        case 'openModelPicker':
          chatView.post({ type: 'modelsShow' });
          break;
        case 'addModelInline': {
          const payload = message.payload;
          const result = payload.id
            ? await config.updateModelFromPayload(payload.id, payload)
            : await config.addModelFromPayload(payload);
          if (!result.ok || !result.model) {
            chatView.post({ type: 'modelSaved', ok: false, message: result.error ?? 'Could not save the model.' });
            break;
          }
          const model = result.model;
          if (payload.apiKey) {
            await config.setApiKey(model, payload.apiKey);
          }
          if (!payload.id) {
            await config.setActiveModel(model.id);
          }
          await refreshKeyStatus();
          chatView.post({ type: 'modelSaved', ok: true, message: `${payload.id ? 'Updated' : 'Saved'} “${model.name}”.` });
          chatView.postState();
          updateStatusBar();
          if (payload.test !== false) {
            try {
              const report = await config.testModel(model);
              chatView.post({ type: 'modelSaved', ok: true, message: `Ready · ${report}` });
              chatView.toast(report, 'ok');
            } catch (err) {
              const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
              chatView.post({ type: 'modelSaved', ok: false, message: `Saved, but the connection test failed: ${detail}` });
              chatView.toast('Model saved, but the connection test failed — check Base URL / Model ID / key.', 'warn');
            }
          } else {
            chatView.toast(`Model “${model.name}” saved.`);
          }
          break;
        }
        case 'saveMcpServer': {
          const payload: McpServerPayload = message.payload;
          const saved = await config.saveMcpServer(payload);
          await refreshMcpSecrets();
          await reloadMcp(true);
          chatView.post({
            type: 'mcpSaved',
            ok: true,
            message: `MCP server “${saved.name}” saved — ${mcp.toolCount()} tool(s) available.`
          });
          chatView.postState();
          break;
        }
        case 'removeMcpServer': {
          const removed = await config.removeMcpServer(message.id);
          await refreshMcpSecrets();
          await reloadMcp(true);
          chatView.post({ type: 'mcpSaved', ok: true, message: removed ? 'MCP server removed.' : 'That server was already gone.' });
          break;
        }
        case 'toggleMcp': {
          await config.setMcpEnabled(message.id, message.enabled);
          await reloadMcp(true);
          chatView.post({ type: 'mcpSaved', ok: true, message: message.enabled ? 'MCP server enabled.' : 'MCP server disabled.' });
          break;
        }
        case 'refreshMcp': {
          await reloadMcp(true);
          chatView.post({
            type: 'mcpSaved',
            ok: true,
            message: `Reconnected ${mcpServers.filter((s) => s.enabled).length} server(s) · ${mcp.toolCount()} tool(s).`
          });
          break;
        }
        case 'testMcp': {
          let server = config.getMcpServers().find((s) => s.id === message.id);
          if (!server && message.payload) {
            // test the form contents before saving
            const draft = await config.saveMcpServer({ ...message.payload, id: message.payload.id ?? 'draft-test' });
            server = draft;
          }
          if (!server) {
            chatView.post({ type: 'mcpTested', id: message.id ?? '', ok: false, message: 'Nothing to test yet.' });
            break;
          }
          const hydrated = await config.hydrateMcpServer(server);
          const result = await mcp.test(hydrated);
          chatView.post({ type: 'mcpTested', id: server.id, ok: result.ok, message: `${server.name}: ${result.message}` });
          await reloadMcp(true);
          break;
        }
        case 'openSession': {
          const snapshot = store.list().find((s) => s.id === message.id);
          if (snapshot) {
            store.save(session);
            setSession(AgentSession.fromSnapshot(snapshot));
            chatView.setItems([]);
            rebuildTranscript();
            chatView.postState();
            updateStatusBar();
          }
          break;
        }
        case 'deleteSession': {
          store.delete(message.id);
          chatView.postState();
          break;
        }
        case 'setSetting': {
          const spec = EDITABLE_SETTINGS.find((entry) => entry.key === message.key);
          if (!spec) {
            chatView.post({ type: 'settingSaved', ok: false, message: 'That setting can not be changed from the panel.' });
            break;
          }
          let value = message.value;
          if (spec.type === 'number') {
            const numeric = Number(value);
            if (Number.isNaN(numeric)) {
              chatView.post({ type: 'settingSaved', ok: false, message: 'That value must be a number.' });
              break;
            }
            value = Math.min(spec.max ?? numeric, Math.max(spec.min ?? numeric, numeric));
          } else if (spec.type === 'boolean') {
            value = Boolean(value);
          } else {
            value = String(value ?? '');
          }
          await cfg().update(spec.key, value, vscode.ConfigurationTarget.Global);
          if (spec.key === 'mode') {
            agent.setMode(value === 'plan' ? 'plan' : 'build');
          }
          chatView.postState();
          chatView.post({ type: 'settingSaved', ok: true, message: `${spec.key} saved.` });
          break;
        }
        case 'setTokenSaver': {
          const section = cfg();
          if (message.mode) {
            await section.update('tokenSaver', message.mode, vscode.ConfigurationTarget.Global);
          }
          if (message.key && message.value !== undefined) {
            await section.update(message.key, message.value, vscode.ConfigurationTarget.Global);
          }
          chatView.postState();
          chatView.toast('Token saver settings updated.');
          break;
        }
        case 'previewCompression': {
          const result = compressMessages(session.messages, config.tokenSaverSettings);
          chatView.post({ type: 'tokenStats', stats: result.stats, report: tokenSaverReport() });
          break;
        }
        case 'setLayout': {
          await cfg().update('interfaceLayout', message.layout, vscode.ConfigurationTarget.Global);
          chatView.post({ type: 'layout', layout: message.layout });
          chatView.postState();
          break;
        }
        case 'removeModel': {
          const removed = await config.removeModelById(message.id);
          await refreshKeyStatus();
          chatView.postState();
          updateStatusBar();
          chatView.post({ type: 'modelRemoved', message: removed ? 'Model removed.' : 'That model was already gone.' });
          break;
        }
        case 'setModelKey': {
          const model = config.getModels().find((m) => m.id === message.id);
          if (!model) {
            chatView.post({ type: 'modelKeySaved', message: 'That model no longer exists.' });
            break;
          }
          await config.setApiKey(model, message.apiKey ?? '');
          await refreshKeyStatus();
          chatView.postState();
          chatView.post({
            type: 'modelKeySaved',
            message: message.apiKey ? `API key saved for ${model.name}.` : `API key cleared for ${model.name}.`
          });
          break;
        }
        case 'testModel': {
          const model = config.getModels().find((m) => m.id === message.id);
          if (!model) {
            break;
          }
          chatView.post({ type: 'modelSaved', ok: true, message: `Testing ${model.name}…` });
          try {
            const report = await config.testModel(model);
            chatView.post({ type: 'modelSaved', ok: true, message: report });
            chatView.toast(report, 'ok');
          } catch (err) {
            const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
            chatView.post({ type: 'modelSaved', ok: false, message: `Connection test failed: ${detail}` });
          }
          break;
        }
        case 'listModelsInline': {
          try {
            const models = await config.listModelsFor(message.payload);
            chatView.post({ type: 'modelList', requestId: message.requestId, models });
          } catch (err) {
            chatView.post({
              type: 'modelList',
              requestId: message.requestId,
              models: [],
              error: err instanceof Error ? err.message.split('\n')[0] : String(err)
            });
          }
          break;
        }
        case 'setWorkMode':
          await config.setWorkMode(message.mode);
          chatView.postState();
          chatView.toast(
            message.mode === 'autonomy'
              ? 'High autonomy: edits and commands run without asking.'
              : 'Review first: every edit and command is confirmed.',
            message.mode === 'autonomy' ? 'warn' : 'info'
          );
          break;
        case 'mentionFiles': {
          const query = String(message.query ?? '').replace(/[\\]/g, '');
          const pattern = query ? `**/*${query}*` : '**/*';
          const files = await vscode.workspace.findFiles(pattern, '**/{node_modules,.git,dist,out,build,coverage,.next,target}/**', 40);
          chatView.post({
            type: 'mentionResults',
            query: message.query ?? '',
            files: files.map((uri) => vscode.workspace.asRelativePath(uri, false)).filter(Boolean).sort()
          });
          break;
        }
        case 'setMode':
          agent.setMode(message.mode);
          break;
        case 'undo':
          await undoLastChange();
          break;
        case 'initProject':
          await initProjectRules();
          break;
        case 'openSettings':
          await vscode.commands.executeCommand('workbench.action.openSettings', 'agentcode');
          break;
        case 'showDiff':
          await showDiffFor(message.path, message.content);
          break;
        case 'openFile':
          await openPath(message.path, message.line);
          break;
        case 'permissionResponse':
          approval.respond(message.id, { allowed: message.allowed, remember: message.remember });
          updateStatusBar();
          break;
        case 'planResponse':
          approval.respond(message.id, { approved: message.approved, feedback: message.feedback });
          updateStatusBar();
          break;
        case 'askResponse':
          approval.respond(message.id, { answer: message.answer });
          break;
        case 'pickImage':
          await pickImages();
          break;
        case 'exportSession':
          await exportSession();
          break;
        case 'copy':
          await vscode.env.clipboard.writeText(message.text);
          break;
        default:
          break;
      }
    } catch (err) {
      logError(err);
      chatView.toast(err instanceof Error ? err.message : String(err), 'warn');
    }
  }

  async function refreshKeyStatus(): Promise<void> {
    const next: Record<string, boolean> = {};
    for (const model of config.getModels()) {
      next[model.id] = await config.hasApiKey(model);
    }
    keyStatus = next;
  }

  async function sendUserMessage(text: string, images?: string[]): Promise<void> {
    if (!vscode.workspace.workspaceFolders?.length) {
      const open = await vscode.window.showWarningMessage('AM Code needs an open folder to work in.', 'Open folder');
      if (open === 'Open folder') {
        await vscode.commands.executeCommand('workbench.action.files.openFolder');
      }
      return;
    }
    if (!config.getActiveModel()) {
      const add = await vscode.window.showInformationMessage('No model configured yet. Add one with a Base URL and Model ID.', 'Add model');
      if (add === 'Add model') {
        await config.addModelInteractive();
        await refreshKeyStatus();
        chatView.postState();
      }
      if (!config.getActiveModel()) {
        return;
      }
    }
    const trimmed = (text ?? '').trim();
    const userItemId = `u_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    chatView.postItem({ kind: 'user', id: userItemId, text: trimmed, images, ts: Date.now() });
    chatView.post({ type: 'busy', busy: true, status: 'starting' });
    updateStatusBar();

    const enriched = await augmentWithEditorContext(trimmed);
    void agent.send(enriched, images).catch((err) => {
      logError(err);
      chatView.postItem({
        kind: 'error',
        id: `e_${Date.now()}`,
        text: err instanceof Error ? err.message : String(err),
        ts: Date.now()
      });
    });
  }

  async function augmentWithEditorContext(text: string): Promise<string> {
    if (!cfg().get<boolean>('includeOpenFileContext', true)) {
      return text;
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.isUntitled) {
      return text;
    }
    const rel = vscode.workspace.asRelativePath(editor.document.uri, false);
    if (rel.startsWith('agentcode-preview')) {
      return text;
    }
    const selection = editor.selection;
    if (selection.isEmpty) {
      return `${text}\n\n<editor-context>\nActive file: ${rel}:${selection.active.line + 1}\n</editor-context>`;
    }
    const code = editor.document.getText(selection).slice(0, 6000);
    const lang = editor.document.languageId;
    return (
      `${text}\n\n<editor-context>\nSelection in ${rel}:${selection.start.line + 1}-${selection.end.line + 1}:\n` +
      '```' + `${lang}\n${code}\n` + '```\n</editor-context>'
    );
  }

  async function undoLastChange(): Promise<void> {
    const edit = session.edits.pop();
    if (!edit) {
      chatView.toast('Nothing to undo yet — the agent has not changed any file in this session.', 'warn');
      store.save(session);
      return;
    }
    const root = workspaceRootPath();
    if (!root) {
      return;
    }
    const abs = path.join(root, edit.path);
    try {
      if (edit.kind === 'create' && !edit.existedBefore) {
        await fs.unlink(abs);
      } else if (edit.existedBefore) {
        await fs.writeFile(abs, edit.before, 'utf8');
      }
      lastEditPath = edit.path;
      lastEditContent = { before: edit.after, after: edit.before };
      store.save(session);
      chatView.postItem({
        kind: 'notice',
        id: `n_${Date.now()}`,
        text: `Reverted ${edit.tool} on ${edit.path}.`,
        level: 'info',
        ts: Date.now()
      });
      await openPath(edit.path);
    } catch (err) {
      logError(err);
      chatView.toast(`Undo failed: ${err instanceof Error ? err.message : String(err)}`, 'warn');
    }
  }

  async function showDiffFor(relPath: string, proposed: string): Promise<void> {
    const target = relPath || lastEditPath;
    if (!target) {
      chatView.toast('No change to diff yet.', 'warn');
      return;
    }
    const root = workspaceRootPath();
    if (!root) {
      return;
    }
    let after = proposed;
    if (!after) {
      const last = session.edits[session.edits.length - 1];
      after = last && last.path === target ? last.after : await fs.readFile(path.join(root, target), 'utf8').catch(() => '');
    }
    await preview.openDiff(target, after);
  }

  async function openPath(target: string, line?: number): Promise<void> {
    if (/^https?:\/\//i.test(target)) {
      await vscode.env.openExternal(vscode.Uri.parse(target));
      return;
    }
    if (!target) {
      return;
    }
    const root = workspaceRootPath();
    if (!root) {
      return;
    }
    const uri = vscode.Uri.file(path.join(root, target));
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, { preview: true });
      if (line && line > 1) {
        const position = new vscode.Position(Math.min(line - 1, doc.lineCount - 1), 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
      }
    } catch {
      chatView.toast(`Could not open ${target}`, 'warn');
    }
  }

  async function pickImages(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: 'Attach',
      filters: { Images: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }
    });
    if (!picked?.length) {
      return;
    }
    const dataUrls: string[] = [];
    for (const uri of picked.slice(0, 4)) {
      const buffer = await fs.readFile(uri.fsPath);
      if (buffer.byteLength > 4 * 1024 * 1024) {
        chatView.toast(`${path.basename(uri.fsPath)} is larger than 4 MB — skipped.`, 'warn');
        continue;
      }
      const ext = path.extname(uri.fsPath).slice(1).toLowerCase();
      const mime = ext === 'jpg' ? 'jpeg' : ext;
      dataUrls.push(`data:image/${mime};base64,${buffer.toString('base64')}`);
    }
    if (dataUrls.length) {
      chatView.addImages(dataUrls);
    }
  }

  async function exportSession(): Promise<void> {
    const markdown = sessionToMarkdown();
    const target = await vscode.window.showSaveDialog({
      saveLabel: 'Export',
      filters: { Markdown: ['md'] },
      defaultUri: vscode.workspace.workspaceFolders?.[0]
        ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, `agentcode-session-${session.id}.md`)
        : undefined
    });
    if (!target) {
      return;
    }
    await fs.writeFile(target.fsPath, markdown, 'utf8');
    const open = await vscode.window.showInformationMessage('Session exported.', 'Open file');
    if (open === 'Open file') {
      await vscode.window.showTextDocument(target);
    }
  }

  function sessionToMarkdown(): string {
    const stats = session.todos.stats();
    const lines: string[] = [
      `# AM Code session — ${session.title}`,
      '',
      `- Session: \`${session.id}\``,
      `- Mode: ${session.mode}`,
      `- Model: ${config.getActiveModel()?.name ?? 'n/a'}`,
      `- Tokens: ${session.usage.inputTokens} in / ${session.usage.outputTokens} out`,
      `- Checklist: ${stats.completed}/${stats.total} completed`,
      '',
      '## Checklist',
      session.todos.toMarkdown(),
      '',
      '## Transcript',
      ''
    ];
    for (const message of session.messages) {
      if (message.role === 'system') {
        continue;
      }
      if (message.role === 'user') {
        lines.push(`### 👤 User`, '', message.content, '');
      } else if (message.role === 'assistant') {
        lines.push(`### 🤖 Assistant`, '', message.content || '(no text)');
        for (const call of message.toolCalls ?? []) {
          lines.push('', `> tool call: \`${call.name}\` ${JSON.stringify(call.args).slice(0, 400)}`);
        }
        lines.push('');
      } else {
        lines.push(`<details><summary>tool result — ${message.name}</summary>`, '', '```', (message.content ?? '').slice(0, 4000), '```', '', '</details>', '');
      }
    }
    return lines.join('\n');
  }

  async function initProjectRules(): Promise<void> {
    const root = workspaceRootPath();
    if (!root) {
      return;
    }
    const dir = path.join(root, '.agentcode');
    await fs.mkdir(dir, { recursive: true });
    const rulesPath = path.join(dir, 'rules.md');
    const exists = await fs.access(rulesPath).then(() => true).catch(() => false);
    if (!exists) {
      await fs.writeFile(
        rulesPath,
        [
          '# Project rules for AM Code',
          '',
          'Keep this file short and concrete — it is injected into every session.',
          '',
          '## Commands',
          '- Test: `npm test`',
          '- Lint: `npm run lint`',
          '- Build: `npm run build`',
          '',
          '## Conventions',
          '- (e.g. TypeScript strict mode, no `any`, named exports only)',
          '',
          '## Architecture',
          '- src/ — ...',
          '',
          '## Do not touch',
          '- (generated files, migrations, vendored code)'
        ].join('\n'),
        'utf8'
      );
    }
    const agentsPath = path.join(root, 'AGENTS.md');
    const agentsExists = await fs.access(agentsPath).then(() => true).catch(() => false);
    if (!agentsExists) {
      await fs.writeFile(
        agentsPath,
        '# AGENTS.md\n\nAM Code reads this file automatically (see also .agentcode/rules.md).\n',
        'utf8'
      );
    }
    chatView.postItem({
      kind: 'notice',
      id: `n_${Date.now()}`,
      text: 'Created .agentcode/rules.md (edit it with your build/test commands and conventions).',
      level: 'info',
      ts: Date.now()
    });
    await openPath('.agentcode/rules.md');
  }

  function selectionPrompt(instruction: string): string | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      return undefined;
    }
    const rel = vscode.workspace.asRelativePath(editor.document.uri, false);
    const code = editor.document.getText(editor.selection);
    return `${instruction}\n\nFile: ${rel} (lines ${editor.selection.start.line + 1}-${editor.selection.end.line + 1})\n\n\`\`\`${editor.document.languageId}\n${code}\n\`\`\``;
  }

  // ---------------------------------------------------------------- commands

  context.subscriptions.push(
    vscode.commands.registerCommand('agentcode.openChat', async () => {
      await chatView.reveal();
    }),
    vscode.commands.registerCommand('agentcode.newSession', () => {
      void handleWebviewMessage({ type: 'newSession' });
    }),
    vscode.commands.registerCommand('agentcode.addModel', async () => {
      await config.addModelInteractive();
      await refreshKeyStatus();
      chatView.postState();
      updateStatusBar();
    }),
    vscode.commands.registerCommand('agentcode.editModel', async () => {
      if (hostIsDesktop()) {
        chatView.post({ type: 'modelsShow' });
        return;
      }
      await config.editModelInteractive();
      await refreshKeyStatus();
      chatView.postState();
    }),
    vscode.commands.registerCommand('agentcode.removeModel', async () => {
      if (hostIsDesktop()) {
        chatView.post({ type: 'modelsShow' });
        return;
      }
      await config.removeModelInteractive();
      await refreshKeyStatus();
      chatView.postState();
    }),
    vscode.commands.registerCommand('agentcode.setApiKey', async () => {
      if (hostIsDesktop()) {
        chatView.post({ type: 'modelsShow' });
        return;
      }
      const model = await config.selectModelInteractive();
      if (!model) {
        return;
      }
      const key = await vscode.window.showInputBox({
        title: `API key for ${model.name}`,
        prompt: 'Stored in VS Code Secret Storage (leave empty to clear)',
        password: true,
        ignoreFocusOut: true
      });
      if (key === undefined) {
        return;
      }
      await config.setApiKey(model, key);
      await refreshKeyStatus();
      chatView.postState();
      vscode.window.showInformationMessage(key ? `API key saved for ${model.name}.` : `API key cleared for ${model.name}.`);
    }),
    vscode.commands.registerCommand('agentcode.selectModel', async () => {
      if (hostIsDesktop()) {
        chatView.post({ type: 'modelsShow' });
        return;
      }
      await config.selectModelInteractive();
      await refreshKeyStatus();
      chatView.postState();
      updateStatusBar();
    }),
    vscode.commands.registerCommand('agentcode.testModel', async () => {
      const active = config.getActiveModel();
      if (!active) {
        if (hostIsDesktop()) {
          chatView.post({ type: 'modelsShow', open: 'add' });
          return;
        }
        const add = await vscode.window.showInformationMessage('No model configured yet.', 'Add model');
        if (add === 'Add model') {
          await vscode.commands.executeCommand('agentcode.addModel');
        }
        return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `AM Code: testing ${active.name}…` },
        async () => {
          try {
            const result = await config.testModel(active);
            chatView.toast(result);
            vscode.window.showInformationMessage(`AM Code — ${result}`);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logError(err);
            chatView.postItem({
              kind: 'error',
              id: `e_${Date.now()}`,
              text: `Connection test for "${active.name}" failed:\n${message}`,
              ts: Date.now()
            });
            chatView.toast(`Connection test failed for ${active.name}.`, 'warn');
          }
        }
      );
    }),
    vscode.commands.registerCommand('agentcode.toggleMode', () => {
      agent.setMode(session.mode === 'plan' ? 'build' : 'plan');
      chatView.toast(`Mode: ${session.mode.toUpperCase()}`);
    }),
    vscode.commands.registerCommand('agentcode.plan', () => agent.setMode('plan')),
    vscode.commands.registerCommand('agentcode.build', () => agent.setMode('build')),
    vscode.commands.registerCommand('agentcode.toggleAutoApprove', async () => {
      const current = config.autoApproveWrite && config.autoApproveCommands;
      const target = vscode.ConfigurationTarget.Workspace;
      await cfg().update('autoApproveWrite', !current, target);
      await cfg().update('autoApproveCommands', !current, target);
      chatView.postState();
      chatView.toast(current ? 'Auto-approve disabled: every write and command is confirmed.' : 'Auto-approve ENABLED (YOLO): writes and commands run without asking.', 'warn');
    }),
    vscode.commands.registerCommand('agentcode.undoLastChange', () => void undoLastChange()),
    vscode.commands.registerCommand('agentcode.showDiff', () => void showDiffFor('', '')),
    vscode.commands.registerCommand('agentcode.initProject', () => void initProjectRules()),
    vscode.commands.registerCommand('agentcode.addSelectionToChat', async () => {
      const prompt = selectionPrompt('Look at this selection:');
      if (!prompt) {
        vscode.window.showInformationMessage('Select some code first.');
        return;
      }
      await chatView.reveal();
      chatView.prefill(prompt);
    }),
    vscode.commands.registerCommand('agentcode.explainSelection', async () => {
      const prompt = selectionPrompt('Explain this code: what it does, its edge cases and any issues you see.');
      if (!prompt) {
        vscode.window.showInformationMessage('Select some code first.');
        return;
      }
      await chatView.reveal();
      await sendUserMessage(prompt);
    }),
    vscode.commands.registerCommand('agentcode.fixSelection', async () => {
      const prompt = selectionPrompt('Find the bugs in this selection and fix them in place. Explain each fix briefly.');
      if (!prompt) {
        vscode.window.showInformationMessage('Select some code first.');
        return;
      }
      await chatView.reveal();
      await sendUserMessage(prompt);
    }),
    vscode.commands.registerCommand('agentcode.compactSession', async () => {
      await agent.compact();
      chatView.postState();
    }),
    vscode.commands.registerCommand('agentcode.clearSession', () => void handleWebviewMessage({ type: 'clearSession' })),
    vscode.commands.registerCommand('agentcode.exportSession', () => void exportSession()),
    vscode.commands.registerCommand('agentcode.showStatus', () => {
      const active = config.getActiveModel();
      const todos = session.todos.toJSON();
      void vscode.window.showInformationMessage(
        [
          `AM Code — ${session.mode.toUpperCase()} mode`,
          `Model: ${active ? `${active.name} (${active.modelId})` : 'none configured'}`,
          `Checklist: ${session.todos.progressLabel()}`,
          `Tokens: ${session.usage.inputTokens} in / ${session.usage.outputTokens} out`,
          `Edits: ${session.edits.length}`
        ].join('  |  `'),
        { modal: false },
        'Open chat'
      ).then((picked) => {
        if (picked === 'Open chat') {
          void chatView.reveal();
        }
      });
      log(`status: ${JSON.stringify({ todos, mode: session.mode })}`);
    }),
    vscode.commands.registerCommand('agentcode.manageMcp', async () => {
      await chatView.reveal();
      chatView.post({ type: 'mcpShow' });
    }),
    vscode.commands.registerCommand('agentcode.refreshMcp', async () => {
      await reloadMcp(true);
      const ready = mcpState.filter((s) => s.state === 'ready').length;
      vscode.window.showInformationMessage(`AM Code — MCP: ${ready}/${mcpServers.length} server(s) connected, ${mcp.toolCount()} tool(s).`);
    }),
    vscode.commands.registerCommand('agentcode.switchSession', async () => {
      const snapshots = store.list();
      if (!snapshots.length) {
        vscode.window.showInformationMessage('No saved sessions yet.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        snapshots.map((s) => ({
          label: s.title,
          description: `${s.mode} · ${new Date(s.updatedAt).toLocaleString()} · ${s.todos.filter((t) => t.status === 'completed').length}/${s.todos.length}`,
          id: s.id
        })),
        { title: 'AM Code sessions', ignoreFocusOut: true }
      );
      if (!picked) {
        return;
      }
      const snapshot = snapshots.find((s) => s.id === picked.id);
      if (!snapshot) {
        return;
      }
      store.save(session);
      setSession(AgentSession.fromSnapshot(snapshot));
      chatView.setItems([]);
      chatView.postState();
      updateStatusBar();
    })
  );

  context.subscriptions.push(
    preview,
    decorator,
    approval,
    statusBar,
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('agentcode')) {
        if (event.affectsConfiguration('agentcode.mcpServers')) {
          void loadWordmark();
  void refreshMcpSecrets().then(() => reloadMcp(true));
        }
        chatView.postState();
        updateStatusBar();
      }
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        decorator.refresh(editor);
      }
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      const edit = session.edits.find((e) => e.path === vscode.workspace.asRelativePath(event.textEditor.document.uri, false));
      if (edit) {
        const before = edit.before.split(/\r?\n/).length;
        const after = edit.after.split(/\r?\n/).length;
        decorator.focus(edit.path, 1, Math.max(1, Math.abs(after - before) + 1));
      }
      decorator.refresh(event.textEditor);
    })
  );

  // Initial mode from settings.
  const savedMode = cfg().get<'build' | 'plan'>('mode', 'build');
  session.mode = savedMode;

  void refreshMcpSecrets()
    .then(() => reloadMcp(config.getMcpServers().some((s) => s.enabled)))
    .then(() => refreshGitInfo());

  void refreshKeyStatus().then(() => {
    rebuildTranscript();
    chatView.postState();
    updateStatusBar();
    const models = config.getModels();
    if (models.length === 0 && !hostIsDesktop()) {
      void vscode.window
        .showInformationMessage('AM Code is ready. Add your first model (Base URL + Model ID) to start.', 'Add model', 'Later')
        .then((picked) => {
          if (picked === 'Add model') {
            void vscode.commands.executeCommand('agentcode.addModel');
          }
        });
    }
  });

  log('AM Code activated.');
}

export function deactivate(): void {
  // Stop every MCP stdio server and any child process the agent started — otherwise node.exe
  // children keep running after the editor/window is closed.
  try {
    mcpRef?.dispose();
  } catch {
    /* best effort */
  }
  log('AM Code deactivated.');
}

export type { Todo, ModelConfig };
