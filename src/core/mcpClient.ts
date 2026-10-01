/**
 * Minimal, dependency-free MCP (Model Context Protocol) client.
 *
 * Supports the three transports people actually use:
 *   - stdio            : spawn a local process and talk JSON-RPC over stdin/stdout
 *   - http (streamable): POST JSON-RPC to a single endpoint (JSON or SSE response)
 *   - sse (legacy)     : GET /sse for the event stream, POST to the announced message endpoint
 *
 * No `vscode` import on purpose: the VS Code extension and the desktop app share this file.
 */

import { spawn, ChildProcess } from 'child_process';
import {
  McpPromptInfo,
  McpServerConfig,
  McpServerStatus,
  McpToolInfo,
  ToolDefinition,
  ToolOutcome
} from './types';
import {
  describeMcpTarget,
  matchesToolFilter,
  mcpResultToText,
  mcpToolDefinition,
  mcpToolName,
  parseMcpToolName
} from './mcp';

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'am-code', version: '0.2.0' };
const DEFAULT_TIMEOUT = 25000;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc?: '2.0';
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface Transport {
  readonly label: string;
  start(): Promise<void>;
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  close(): void;
  /** Called when the transport dies (so the manager can drop the connection). */
  onClose(handler: (reason: string) => void): void;
}

class RpcError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = 'RpcError';
  }
}

// --------------------------------------------------------------------------- stdio

class StdioTransport implements Transport {
  private child?: ChildProcess;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private closeHandlers: Array<(reason: string) => void> = [];
  private dead = false;

  readonly label: string;

  constructor(private readonly server: McpServerConfig) {
    this.label = describeMcpTarget(server);
  }

  onClose(handler: (reason: string) => void): void {
    this.closeHandlers.push(handler);
  }

  async start(): Promise<void> {
    const command = (this.server.command ?? '').trim();
    if (!command) {
      throw new Error('Missing command for the stdio server (e.g. "npx").');
    }
    // tolerate a hand-edited config file where "args" is a single string
    const rawArgs = this.server.args as unknown;
    const args = Array.isArray(rawArgs)
      ? rawArgs.map((value) => String(value))
      : typeof rawArgs === 'string' && rawArgs.trim()
        ? rawArgs.trim().split(/\s+/)
        : [];
    const child = spawn(command, args, {
      env: { ...process.env, ...(this.server.env ?? {}) },
      cwd: this.server.cwd && this.server.cwd.trim() ? this.server.cwd : undefined,
      shell: process.platform === 'win32',
      windowsHide: true
    });
    this.child = child;
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.ingest(chunk));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      const line = String(chunk).trim();
      if (line) {
        this.logTail = `${this.logTail}\n${line}`.slice(-4000);
      }
    });
    child.on('error', (err) => this.die(`failed to start "${command}": ${err.message}`));
    child.on('exit', (code, signal) => this.die(`process exited (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''})`));
  }

  logTail = '';

  private die(reason: string): void {
    if (this.dead) {
      return;
    }
    this.dead = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
    for (const handler of this.closeHandlers) {
      handler(reason);
    }
  }

  private ingest(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) {
        this.handleLine(line);
      }
      index = this.buffer.indexOf('\n');
    }
  }

  private handleLine(line: string): void {
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return; // servers sometimes print banners on stdout — ignore anything that is not JSON
    }
    if (message.id === undefined || message.id === null) {
      return; // notification
    }
    const pending = this.pending.get(Number(message.id));
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(Number(message.id));
    if (message.error) {
      pending.reject(new RpcError(message.error.message || 'MCP error', message.error.code));
    } else {
      pending.resolve(message.result);
    }
  }

  request(method: string, params?: unknown, timeoutMs = DEFAULT_TIMEOUT): Promise<unknown> {
    if (this.dead || !this.child) {
      return Promise.reject(new Error('MCP server is not running.'));
    }
    const id = this.nextId++;
    const payload: JsonRpcRequest = { jsonrpc: '2.0', id, method, params: params ?? {} };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out after ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child?.stdin?.write(`${JSON.stringify(payload)}\n`);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    const payload: JsonRpcNotification = { jsonrpc: '2.0', method, params: params ?? {} };
    try {
      this.child?.stdin?.write(`${JSON.stringify(payload)}\n`);
    } catch {
      /* ignore */
    }
  }

  close(): void {
    this.dead = true;
    try {
      this.child?.kill();
    } catch {
      /* ignore */
    }
    this.child = undefined;
  }
}

// --------------------------------------------------------------------------- HTTP

class HttpTransport implements Transport {
  private sessionId?: string;
  private closeHandlers: Array<(reason: string) => void> = [];
  private nextId = 1;
  readonly label: string;
  logTail = '';

  constructor(private readonly server: McpServerConfig) {
    this.label = server.url ?? '';
  }

  onClose(handler: (reason: string) => void): void {
    this.closeHandlers.push(handler);
  }

  async start(): Promise<void> {
    if (!this.server.url) {
      throw new Error('Missing URL for the remote MCP server.');
    }
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'user-agent': 'am-code-mcp/0.2',
      ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
      ...(this.server.headers ?? {})
    };
  }

  private async post(body: JsonRpcRequest | JsonRpcNotification, timeoutMs: number): Promise<unknown> {
    const url = this.server.url as string;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const session = response.headers.get('mcp-session-id');
      if (session) {
        this.sessionId = session;
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (!response.ok && !contentType.includes('text/event-stream')) {
        const text = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 300)}` : ''}`);
      }
      if ('id' in body && body.id !== undefined) {
        if (contentType.includes('text/event-stream')) {
          return await this.readEventStream(response, body.id);
        }
        const text = await response.text();
        if (!text.trim()) {
          return undefined;
        }
        const parsed = JSON.parse(text) as JsonRpcResponse;
        if (parsed.error) {
          throw new RpcError(parsed.error.message || 'MCP error', parsed.error.code);
        }
        return parsed.result;
      }
      await response.text().catch(() => '');
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  private async readEventStream(response: Response, id: number): Promise<unknown> {
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Empty response body from the MCP server.');
    }
    const decoder = new TextDecoder();
    let buffer = '';
    let result: unknown;
    let found = false;
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n');
        if (!data) {
          continue;
        }
        try {
          const message = JSON.parse(data) as JsonRpcResponse;
          if (Number(message.id) === id) {
            if (message.error) {
              throw new RpcError(message.error.message || 'MCP error', message.error.code);
            }
            result = message.result;
            found = true;
          }
        } catch (err) {
          if (err instanceof RpcError) {
            throw err;
          }
        }
      }
      if (done || found) {
        break;
      }
    }
    void reader.cancel().catch(() => undefined);
    if (!found) {
      throw new Error('The MCP server closed the stream without answering.');
    }
    return result;
  }

  request(method: string, params?: unknown, timeoutMs = DEFAULT_TIMEOUT): Promise<unknown> {
    const id = this.nextId++;
    return this.post({ jsonrpc: '2.0', id, method, params: params ?? {} }, timeoutMs);
  }

  notify(method: string, params?: unknown): void {
    void this.post({ jsonrpc: '2.0', method, params: params ?? {} }, DEFAULT_TIMEOUT).catch((err) => {
      this.logTail = `${this.logTail}\n${String(err)}`.slice(-2000);
    });
  }

  close(): void {
    for (const handler of this.closeHandlers) {
      handler('closed');
    }
  }
}

// --------------------------------------------------------------------------- manager

interface Connection {
  server: McpServerConfig;
  transport?: Transport;
  status: McpServerStatus;
  tools: McpToolInfo[];
}

export interface McpLogger {
  (serverId: string, level: 'info' | 'error', message: string): void;
}

export interface McpManagerOptions {
  getServers: () => McpServerConfig[];
  log?: McpLogger;
  /** Called whenever the tool list or a server status changes. */
  onChanged?: () => void;
}

export class McpManager {
  private readonly connections = new Map<string, Connection>();
  private refreshing = false;

  constructor(private readonly options: McpManagerOptions) {}

  /** All MCP tools currently available, as tool definitions for the model. */
  toolDefinitions(): ToolDefinition[] {
    const defs: ToolDefinition[] = [];
    for (const connection of this.connections.values()) {
      if (connection.status.state !== 'ready' || !connection.server.enabled) {
        continue;
      }
      for (const tool of connection.tools) {
        defs.push(mcpToolDefinition(connection.server, tool));
      }
    }
    return defs;
  }

  /** True when the given (namespaced) name belongs to an MCP server we know. */
  owns(name: string): boolean {
    const parsed = parseMcpToolName(name);
    return Boolean(parsed && this.connections.has(parsed.serverId));
  }

  statuses(): McpServerStatus[] {
    const configured = this.options.getServers();
    return configured.map((server) => {
      const connection = this.connections.get(server.id);
      if (!server.enabled) {
        return {
          id: server.id,
          name: server.name,
          transport: server.transport,
          enabled: false,
          state: 'disabled' as const,
          target: describeMcpTarget(server),
          toolCount: 0,
          tools: []
        };
      }
      if (!connection) {
        return {
          id: server.id,
          name: server.name,
          transport: server.transport,
          enabled: true,
          state: 'connecting' as const,
          target: describeMcpTarget(server),
          toolCount: 0,
          tools: []
        };
      }
      return connection.status;
    });
  }

  toolCount(): number {
    return this.statuses().reduce((sum, s) => sum + (s.state === 'ready' ? s.toolCount : 0), 0);
  }

  /** Connects (or reconnects) servers, refreshes their tool lists. */
  async refresh(onlyServerId?: string): Promise<McpServerStatus[]> {
    if (this.refreshing && !onlyServerId) {
      return this.statuses();
    }
    this.refreshing = true;
    try {
      const servers = this.options.getServers();
      const live = new Map(servers.filter((s) => s.enabled).map((s) => [s.id, s]));

      // Drop connections whose server was removed, disabled or re-configured.
      for (const [id, connection] of [...this.connections]) {
        const server = live.get(id);
        const stale = !server || JSON.stringify(server) !== JSON.stringify(connection.server);
        if (stale) {
          connection.transport?.close();
          this.connections.delete(id);
        }
      }

      const targets = [...live.values()].filter(
        (server) => (!onlyServerId || server.id === onlyServerId) && !this.connections.has(server.id)
      );
      await Promise.all(targets.map((server) => this.connect(server)));
      this.options.onChanged?.();
      return this.statuses();
    } finally {
      this.refreshing = false;
    }
  }

  private async connect(server: McpServerConfig): Promise<void> {
    const existing = this.connections.get(server.id);
    existing?.transport?.close();

    const connection: Connection = {
      server,
      tools: [],
      status: {
        id: server.id,
        name: server.name,
        transport: server.transport,
        enabled: true,
        state: 'connecting',
        target: describeMcpTarget(server),
        toolCount: 0,
        tools: []
      }
    };
    this.connections.set(server.id, connection);

    const timeoutMs = clampTimeout(server.timeoutMs);
    let transport: Transport | undefined;
    try {
      transport = server.transport === 'stdio' ? new StdioTransport(server) : new HttpTransport(server);
      connection.transport = transport;
      transport.onClose((reason) => {
        const current = this.connections.get(server.id);
        if (current && current.transport === transport && current.status.state === 'ready') {
          current.status = { ...current.status, state: 'error', error: reason, toolCount: 0, tools: [] };
          this.options.log?.(server.id, 'error', `${server.name} disconnected: ${reason}`);
          this.options.onChanged?.();
        }
      });
      await transport.start();

      const initResult = (await transport.request(
        'initialize',
        {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: true }, prompts: {} },
          clientInfo: CLIENT_INFO
        },
        timeoutMs
      )) as { serverInfo?: { name?: string; version?: string }; protocolVersion?: string } | undefined;
      transport.notify('notifications/initialized');

      const tools = await this.listTools(connection, timeoutMs);
      connection.tools = tools;
      connection.status = {
        ...connection.status,
        state: 'ready',
        toolCount: tools.length,
        tools: tools.map((t) => t.name),
        serverName: initResult?.serverInfo?.name,
        serverVersion: initResult?.serverInfo?.version,
        error: undefined
      };
      this.options.log?.(
        server.id,
        'info',
        `${server.name} connected — ${tools.length} tool${tools.length === 1 ? '' : 's'}${
          initResult?.serverInfo?.name ? ` (${initResult.serverInfo.name} ${initResult.serverInfo.version ?? ''})` : ''
        }`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      transport?.close();
      connection.status = { ...connection.status, state: 'error', error: message, toolCount: 0, tools: [] };
      this.options.log?.(server.id, 'error', `${server.name} failed: ${message}`);
    }
  }

  private async listTools(connection: Connection, timeoutMs: number): Promise<McpToolInfo[]> {
    const transport = connection.transport as Transport;
    const found: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = (await transport.request('tools/list', cursor ? { cursor } : {}, timeoutMs)) as
        | { tools?: Array<Record<string, unknown>>; nextCursor?: string }
        | undefined;
      const tools = Array.isArray(result?.tools) ? (result?.tools as Array<Record<string, unknown>>) : [];
      for (const raw of tools) {
        const name = String(raw.name ?? '').trim();
        if (!name || !matchesToolFilter(name, connection.server.toolFilter)) {
          continue;
        }
        const annotations = (raw.annotations ?? {}) as Record<string, unknown>;
        const schema = (raw.inputSchema ?? raw.input_schema ?? {}) as ToolDefinition['schema'];
        found.push({
          serverId: connection.server.id,
          serverName: connection.server.name,
          name,
          exposed: mcpToolName(connection.server.id, name),
          description: String(raw.description ?? raw.title ?? '').trim(),
          schema: {
            type: 'object',
            properties: (schema?.properties ?? {}) as Record<string, unknown>,
            required: Array.isArray(schema?.required) ? schema.required : undefined
          },
          readOnly: Boolean(annotations.readOnlyHint)
        });
      }
      cursor = result?.nextCursor ? String(result.nextCursor) : undefined;
      if (!cursor) {
        break;
      }
    }
    return found;
  }

  /** Best-effort prompt discovery (used by the desktop/VS Code UIs to list "/" commands). */
  async listPrompts(serverId: string): Promise<McpPromptInfo[]> {
    const connection = this.connections.get(serverId);
    if (!connection?.transport || connection.status.state !== 'ready') {
      return [];
    }
    try {
      const result = (await connection.transport.request('prompts/list', {}, clampTimeout(connection.server.timeoutMs))) as
        | { prompts?: Array<Record<string, unknown>> }
        | undefined;
      return (result?.prompts ?? []).map((raw) => ({
        serverId,
        serverName: connection.server.name,
        name: String(raw.name ?? ''),
        description: raw.description ? String(raw.description) : undefined,
        arguments: Array.isArray(raw.arguments)
          ? (raw.arguments as Array<Record<string, unknown>>).map((a) => ({
              name: String(a.name ?? ''),
              description: a.description ? String(a.description) : undefined,
              required: Boolean(a.required)
            }))
          : undefined
      }));
    } catch {
      return [];
    }
  }

  /** Runs an MCP tool. The name must be the namespaced form (mcp__server__tool). */
  async callTool(exposed: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    const parsed = parseMcpToolName(exposed);
    if (!parsed) {
      return { ok: false, content: `"${exposed}" is not an MCP tool name.`, summary: 'unknown MCP tool' };
    }
    const connection = this.connections.get(parsed.serverId);
    if (!connection?.transport || connection.status.state !== 'ready') {
      return {
        ok: false,
        content: `The MCP server "${parsed.serverId}" is not connected. Ask the user to enable/refresh it in the AM Code → MCP screen.`,
        summary: 'MCP server offline'
      };
    }
    const timeoutMs = clampTimeout(connection.server.timeoutMs);
    try {
      const result = (await connection.transport.request(
        'tools/call',
        { name: parsed.tool, arguments: args ?? {} },
        timeoutMs
      )) as { isError?: boolean; content?: unknown } | undefined;
      const text = mcpResultToText(result);
      const failed = Boolean(result?.isError);
      return {
        ok: !failed,
        content: failed ? `ERROR from ${parsed.tool}: ${text}` : text,
        summary: `${connection.server.name} · ${parsed.tool}${failed ? ' failed' : ''}`
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        content: `MCP tool "${parsed.tool}" on ${connection.server.name} failed: ${message}`,
        summary: `${parsed.tool} failed: ${message.slice(0, 60)}`
      };
    }
  }

  /** Connects one server on demand and reports a human readable result (used by the Test button). */
  async test(server: McpServerConfig): Promise<{ ok: boolean; message: string; tools: string[] }> {
    const connection: Connection = {
      server,
      tools: [],
      status: {
        id: server.id,
        name: server.name,
        transport: server.transport,
        enabled: true,
        state: 'connecting',
        target: describeMcpTarget(server),
        toolCount: 0,
        tools: []
      }
    };
    let transport: Transport | undefined;
    const timeoutMs = clampTimeout(server.timeoutMs);
    try {
      transport = server.transport === 'stdio' ? new StdioTransport(server) : new HttpTransport(server);
      connection.transport = transport;
      await transport.start();
      const info = (await transport.request(
        'initialize',
        { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, clientInfo: CLIENT_INFO },
        timeoutMs
      )) as { serverInfo?: { name?: string; version?: string } } | undefined;
      transport.notify('notifications/initialized');
      const tools = await this.listTools(connection, timeoutMs);
      const label = info?.serverInfo?.name ?? server.name;
      return {
        ok: true,
        message: `${label}${info?.serverInfo?.version ? ` ${info.serverInfo.version}` : ''} — ${
          tools.length
        } tool${tools.length === 1 ? '' : 's'}${tools.length ? `: ${tools.slice(0, 6).map((t) => t.name).join(', ')}${tools.length > 6 ? '…' : ''}` : ''}`,
        tools: tools.map((t) => t.name)
      };
    } catch (err) {
      const stdio = transport instanceof StdioTransport ? transport : undefined;
      const tail = stdio?.logTail?.trim();
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `${message}${tail ? ` — ${tail.split('\n').slice(-2).join(' ')}` : ''}`, tools: [] };
    } finally {
      transport?.close();
    }
  }

  dispose(): void {
    for (const connection of this.connections.values()) {
      connection.transport?.close();
    }
    this.connections.clear();
  }
}

function clampTimeout(value?: number): number {
  if (!value || Number.isNaN(value)) {
    return DEFAULT_TIMEOUT;
  }
  return Math.max(3000, Math.min(value, 180000));
}
