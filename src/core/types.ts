/**
 * Core (vscode-free) types for the AM Code agent engine.
 * Keeping this file free of `vscode` imports allows the engine to be unit tested in plain node.
 */

export type AgentMode = 'plan' | 'build';

export type ToolCallMode = 'auto' | 'native' | 'text';

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface Todo {
  id: string;
  content: string;
  status: TodoStatus;
  /** Optional short note added when the item is completed (e.g. "3 tests pass"). */
  note?: string;
}

export interface PlanStep {
  title: string;
  details?: string;
  files?: string[];
}

export interface Plan {
  summary: string;
  steps: PlanStep[];
  openQuestions?: string[];
}

export type ProviderKind = 'openai' | 'anthropic';

export interface ModelConfig {
  id: string;
  name: string;
  provider: ProviderKind;
  baseUrl: string;
  modelId: string;
  /** Name of an environment variable holding the key (used when nothing is stored in SecretStorage). */
  apiKeyEnv?: string;
  headers?: Record<string, string>;
  maxTokens?: number;
  temperature?: number;
  contextWindow?: number;
  supportsTools?: boolean;
  supportsVision?: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Native tool calls requested by the assistant. */
  toolCalls?: ToolCall[];
  /** For role === 'tool': which call this result belongs to. */
  toolCallId?: string;
  name?: string;
  /** data: URLs of attached images (for vision models). */
  images?: string[];
  /** Marks internally generated messages (compact summaries etc). */
  internal?: boolean;
  ts?: number;
}

export type ToolKind = 'read' | 'write' | 'exec' | 'meta' | 'plan';

export interface ToolDefinition {
  name: string;
  description: string;
  kind: ToolKind;
  /** JSON-schema for the parameters (OpenAI "function.parameters" / Anthropic "input_schema"). */
  schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface EditRecord {
  path: string;
  before: string;
  after: string;
  /** false when the file did not exist before (used by undo to delete it again). */
  existedBefore: boolean;
  tool: string;
  kind: 'create' | 'edit' | 'delete';
  ts: number;
}

export interface ToolOutcome {
  ok: boolean;
  /** Text returned to the model. */
  content: string;
  /** One-line summary shown in the chat UI. */
  summary: string;
  /** Files touched (for undo + diff). */
  edits?: EditRecord[];
  /** Set when the turn should end after this tool (attempt_completion). */
  endsTurn?: boolean;
  /** Set when the agent should stop looping (fatal error / user abort). */
  abort?: boolean;
  /** Extra markdown shown in the chat (final report of attempt_completion). */
  detail?: string;
}

export interface PermissionRequest {
  id: string;
  toolName: string;
  /** Short human readable title, e.g. "Edit src/app.ts". */
  title: string;
  /** Longer detail (diff preview, command, ...). */
  detail: string;
  kind: ToolKind;
  /** For write tools: file path + proposed content (used for the diff preview). */
  preview?: { path: string; before: string; after: string; isNew: boolean };
  /** For exec tools. */
  command?: string;
}

export interface PermissionDecision {
  allowed: boolean;
  /** "Approve without asking again for this kind of tool in this session". */
  remember?: boolean;
  reason?: string;
}

export interface AskUserRequest {
  id: string;
  question: string;
  options?: string[];
  allowFreeText?: boolean;
}

export interface AskUserAnswer {
  answer: string;
  cancelled?: boolean;
}

export interface PlanDecision {
  approved: boolean;
  feedback?: string;
  /** Suggested next mode after a rejection. */
  mode?: AgentMode;
}

export type AgentEvent =
  | { type: 'turn_start'; userText: string }
  | { type: 'assistant_start'; id: string }
  | { type: 'assistant_delta'; id: string; text: string }
  | { type: 'reasoning_delta'; id: string; text: string }
  | { type: 'assistant_end'; id: string; text: string }
  | { type: 'tool_start'; callId: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_end'; callId: string; name: string; ok: boolean; summary: string }
  | { type: 'permission_ask'; request: PermissionRequest }
  | { type: 'permission_result'; id: string; allowed: boolean; remember?: boolean }
  | { type: 'todos'; todos: Todo[] }
  | { type: 'plan'; plan: Plan; id: string }
  | { type: 'plan_result'; id: string; approved: boolean; feedback?: string }
  | { type: 'ask_user'; request: AskUserRequest }
  | { type: 'ask_user_answer'; id: string; answer: string }
  | { type: 'mode'; mode: AgentMode }
  | { type: 'status'; text: string; busy?: boolean; steps?: number; maxSteps?: number }
  | { type: 'usage'; usage: Usage; model: string }
  | { type: 'error'; message: string }
  | { type: 'notice'; message: string; level?: 'info' | 'warn' }
  | {
      type: 'token_saver';
      stats: {
        mode: 'off' | 'balanced' | 'aggressive';
        beforeTokens: number;
        afterTokens: number;
        savedTokens: number;
        savedPercent: number;
        messagesTouched: number;
        notes: string[];
      };
    }
  | { type: 'turn_end'; reason: 'completed' | 'max_steps' | 'aborted' | 'error' | 'stopped'; text?: string };

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface ProviderStreamEvent {
  type: 'text' | 'reasoning' | 'tool_call' | 'done';
  text?: string;
  call?: ToolCall;
  stopReason?: string | null;
  usage?: Usage;
}

export interface ChatRequest {
  model: ModelConfig;
  system: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  /** signal for abort */
  signal?: AbortSignal;
  apiKey?: string;
}

export interface Provider {
  id: ProviderKind;
  streamChat(req: ChatRequest): AsyncGenerator<ProviderStreamEvent>;
  listModels?(model: ModelConfig, apiKey?: string): Promise<string[]>;
}

// ---------------------------------------------------------------------------- MCP

export type McpTransport = 'stdio' | 'http' | 'sse';

/** One Model Context Protocol server the user added (local process or remote URL). */
export interface McpServerConfig {
  id: string;
  name: string;
  transport: McpTransport;
  /** stdio: the executable to launch (e.g. "npx", "uvx", "node"). */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** http/sse: the server endpoint. */
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
  /** Skip the approval prompt for every tool of this server. */
  autoApproveTools?: boolean;
  /** Only expose tools whose raw names match these patterns (e.g. "read_*"). */
  toolFilter?: string[];
  /** env/header names whose value comes from VS Code Secret Storage. */
  envKeys?: string[];
  headerKeys?: string[];
  timeoutMs?: number;
}

/** A tool discovered from an MCP server. */
export interface McpToolInfo {
  serverId: string;
  serverName: string;
  /** Raw tool name as the server reports it. */
  name: string;
  /** Name exposed to the model: mcp__<serverId>__<name>. */
  exposed: string;
  description: string;
  schema: ToolDefinition['schema'];
  readOnly: boolean;
}

export interface McpServerStatus {
  id: string;
  name: string;
  transport: McpTransport;
  enabled: boolean;
  state: 'disabled' | 'connecting' | 'ready' | 'error';
  /** Human readable target: the command line or the URL. */
  target: string;
  toolCount: number;
  tools: string[];
  serverName?: string;
  serverVersion?: string;
  error?: string;
  lastError?: string;
}

export interface McpPromptInfo {
  serverId: string;
  serverName: string;
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}
