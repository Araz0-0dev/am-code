import {
  AgentMode,
  AskUserRequest,
  McpServerStatus,
  PermissionRequest,
  Plan,
  Todo,
  Usage
} from '../core/types';

export type UiItem =
  | { kind: 'user'; id: string; text: string; images?: string[]; ts: number }
  | { kind: 'assistant'; id: string; text: string; reasoning?: string; done: boolean; model?: string; ts: number }
  | {
      kind: 'tool';
      id: string;
      name: string;
      args: Record<string, unknown>;
      summary?: string;
      ok?: boolean;
      running: boolean;
      ts: number;
    }
  | { kind: 'todos'; id: string; todos: Todo[]; explanation?: string; ts: number }
  | { kind: 'plan'; id: string; plan: Plan; decision?: { approved: boolean; feedback?: string }; ts: number }
  | {
      kind: 'permission';
      id: string;
      request: PermissionRequest;
      decision?: { allowed: boolean; remember?: boolean };
      ts: number;
    }
  | { kind: 'ask'; id: string; request: AskUserRequest; answer?: string; ts: number }
  | { kind: 'notice'; id: string; text: string; level: 'info' | 'warn'; ts: number }
  | { kind: 'error'; id: string; text: string; ts: number }
  | { kind: 'completion'; id: string; text: string; ts: number }
  | { kind: 'mode'; id: string; mode: AgentMode; ts: number }
  | { kind: 'divider'; id: string; text: string; ts: number };

export interface TokenStats {
  mode: 'off' | 'balanced' | 'aggressive';
  beforeTokens: number;
  afterTokens: number;
  savedTokens: number;
  savedPercent: number;
  messagesTouched: number;
  notes: string[];
}

export interface TokenSaverReport {
  stats?: TokenStats;
  mode: 'off' | 'balanced' | 'aggressive';
  keepRecent: number;
  maxToolResultChars: number;
  dedupeToolResults: boolean;
  dropOldImages: boolean;
  transcriptTokens: number;
  toolSurfaceTokens: number;
}

export interface ModelSummary {
  id: string;
  name: string;
  modelId: string;
  provider: string;
  baseUrl: string;
  hasKey: boolean;
  supportsTools: boolean;
}

export type WorkMode = 'review' | 'autonomy';

/** 'auto' = full window on a wide screen gets the OpenCode-like layout, narrow sidebar gets the compact panel. */
export type InterfaceLayout = 'auto' | 'panel' | 'ultra';

export interface SessionTab {
  id: string;
  title: string;
  active: boolean;
  mode: AgentMode;
  updatedAt: number;
}

export interface GitInfo {
  available: boolean;
  branch?: string;
  dirty?: boolean;
  ahead?: number;
}

/** Sanitized MCP server config sent to the panel (never contains secret values). */
export interface McpServerUiConfig {
  id: string;
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  argsText?: string;
  envText?: string;
  url?: string;
  headersText?: string;
  toolFilterText?: string;
  autoApproveTools?: boolean;
  enabled: boolean;
  hasSecret: boolean;
  timeoutMs?: number;
}

export interface McpServerPayloadUi {
  id?: string;
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  argsText?: string;
  envText?: string;
  url?: string;
  headersText?: string;
  toolFilterText?: string;
  autoApproveTools?: boolean;
  enabled?: boolean;
  secret?: string;
  secretEnv?: string;
  secretHeader?: string;
  timeoutMs?: number;
}

export interface WebviewState {
  models: ModelSummary[];
  activeModelId?: string;
  mode: AgentMode;
  busy: boolean;
  status: string;
  title: string;
  usage: Usage;
  steps: number;
  maxSteps: number;
  contextTokens: number;
  contextWindow: number;
  todos: Todo[];
  items: UiItem[];
  autoApprove: { read: boolean; write: boolean; commands: boolean };
  workMode: WorkMode;
  showReasoning: boolean;
  workspaceName: string;
  hasWorkspace: boolean;
  iconUri?: string;
  version?: string;
  /** Interface layout preference from settings ('auto' by default). */
  layout: InterfaceLayout;
  /** Resolved layout of the current viewport — the webview may report back a different value. */
  productName: string;
  sessions: SessionTab[];
  git: GitInfo;
  mcp: McpServerStatus[];
  /** Editable form data for every configured server (secrets excluded). */
  mcpServers: McpServerUiConfig[];
  /** ids of MCP servers that have a secret stored. */
  mcpWithSecret: string[];
  /** Per-server tool counters shown in the MCP screen. */
  mcpEnabled: number;
  /** True when the panel runs inside the AM Code desktop app (Windows/Linux/macOS build). */
  isDesktop?: boolean;
  /** Live token-saver numbers (updated on every request). */
  tokenStats?: TokenStats;
  tokenSaver: {
    mode: 'off' | 'balanced' | 'aggressive';
    keepRecent: number;
    maxToolResultChars: number;
    dedupeToolResults: boolean;
    dropOldImages: boolean;
  };
  /** Inline SVG of the AM Code wordmark (already sanitized by the host). */
  wordmark?: string;
  /** No model configured yet — the panel offers the in-app setup screen. */
  needsModel?: boolean;
  /** Current values of the agent settings shown on the General screen. */
  settings: Record<string, unknown>;
}

export interface InlineModelPayload {
  /** Present when the user edits an existing model instead of adding a new one. */
  id?: string;
  name: string;
  provider: 'openai' | 'anthropic';
  baseUrl: string;
  modelId: string;
  apiKey?: string;
  contextWindow?: number;
  supportsTools?: boolean;
  supportsVision?: boolean;
  /** When true the host also runs a connection test and reports the result in the form. */
  test?: boolean;
}

export type ExtToWebview =
  | { type: 'state'; state: WebviewState }
  | { type: 'upsert'; item: UiItem }
  | { type: 'delta'; id: string; channel: 'text' | 'reasoning'; text: string }
  | { type: 'busy'; busy: boolean; status?: string; steps?: number; maxSteps?: number }
  | { type: 'usage'; usage: Usage; contextTokens: number }
  | { type: 'toast'; message: string; level?: 'info' | 'warn' | 'ok' }
  | { type: 'images'; images: string[] }
  | { type: 'focusComposer' }
  | { type: 'focusModelForm' }
  | { type: 'prefill'; text: string }
  | { type: 'modelList'; requestId: string; models: string[]; error?: string }
  | { type: 'modelSaved'; ok: boolean; message: string }
  | { type: 'modelRemoved'; message: string }
  | { type: 'modelKeySaved'; message: string }
  | { type: 'modelsShow'; open?: 'add' }
  | { type: 'settingsShow'; tab?: 'models' | 'mcp' | 'tokens' | 'general' | 'interface' }
  | { type: 'inlinePrompt'; prompt: { id: number; kind: 'input' | 'pick'; title?: string; prompt?: string; value?: string; placeholder?: string; password?: boolean; items?: Array<{ label: string; description?: string }> } }
  | { type: 'mcpShow' }
  | { type: 'mcpSaved'; ok: boolean; message: string }
  | { type: 'mcpTested'; id: string; ok: boolean; message: string }
  | { type: 'layout'; layout: InterfaceLayout }
  | { type: 'tokenStats'; stats: TokenStats; report?: TokenSaverReport }
  | { type: 'settingSaved'; ok: boolean; message: string }
  | { type: 'mentionResults'; query: string; files: string[] }
  | { type: 'reset' };

export type WebviewToExt =
  | { type: 'ready' }
  | { type: 'send'; text: string; images?: string[] }
  | { type: 'stop' }
  | { type: 'newSession' }
  | { type: 'clearSession' }
  | { type: 'compact' }
  | { type: 'selectModel'; id: string }
  | { type: 'openModelPicker' }
  | { type: 'addModelInline'; payload: InlineModelPayload }
  | { type: 'removeModel'; id: string }
  | { type: 'setModelKey'; id: string; apiKey: string }
  | { type: 'testModel'; id: string }
  | { type: 'listModelsInline'; requestId: string; payload: Partial<InlineModelPayload> }
  | { type: 'setWorkMode'; mode: WorkMode }
  | { type: 'setMode'; mode: AgentMode }
  | { type: 'mentionFiles'; query: string }
  | { type: 'undo' }
  | { type: 'initProject' }
  | { type: 'openSettings' }
  | { type: 'showDiff'; path: string; content: string }
  | { type: 'openFile'; path: string; line?: number }
  | { type: 'permissionResponse'; id: string; allowed: boolean; remember?: boolean }
  | { type: 'planResponse'; id: string; approved: boolean; feedback?: string }
  | { type: 'askResponse'; id: string; answer: string }
  | { type: 'pickImage' }
  | { type: 'exportSession' }
  | { type: 'copy'; text: string }
  | { type: 'saveMcpServer'; payload: McpServerPayloadUi }
  | { type: 'removeMcpServer'; id: string }
  | { type: 'toggleMcp'; id: string; enabled: boolean }
  | { type: 'testMcp'; id?: string; payload?: McpServerPayloadUi }
  | { type: 'refreshMcp' }
  | { type: 'openSession'; id: string }
  | { type: 'deleteSession'; id: string }
  | { type: 'setLayout'; layout: InterfaceLayout }
  | { type: 'setTokenSaver'; mode?: 'off' | 'balanced' | 'aggressive'; key?: string; value?: unknown }
  | { type: 'previewCompression' }
  | { type: 'inlinePromptResult'; id: number; value: string | null; index?: number }
  | { type: 'refreshWorkspace' }
  | { type: 'setSetting'; key: string; value: unknown };
