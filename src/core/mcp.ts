/**
 * MCP helpers shared by every host (VS Code extension, desktop app, tests).
 * This file is intentionally free of `vscode` (and of node globals) so it can be
 * unit tested in plain node and reused inside the desktop app.
 */

import { McpServerConfig, McpToolInfo, ToolDefinition, ToolOutcome } from './types';

/** Namespacing: MCP tools are exposed to the model as mcp__<serverId>__<toolName>. */
export const MCP_PREFIX = 'mcp__';
const SEP = '__';

export function mcpToolName(serverId: string, tool: string): string {
  return `${MCP_PREFIX}${serverId}${SEP}${tool}`;
}

export function parseMcpToolName(exposed: string): { serverId: string; tool: string } | undefined {
  if (!exposed.startsWith(MCP_PREFIX)) {
    return undefined;
  }
  const rest = exposed.slice(MCP_PREFIX.length);
  const at = rest.indexOf(SEP);
  if (at <= 0 || at >= rest.length - SEP.length) {
    return undefined;
  }
  return { serverId: rest.slice(0, at), tool: rest.slice(at + SEP.length) };
}

export function isMcpTool(name: string): boolean {
  return name.startsWith(MCP_PREFIX);
}

/** Turns a discovered MCP tool into a tool definition the agent can offer to the model. */
export function mcpToolDefinition(server: McpServerConfig, tool: McpToolInfo): ToolDefinition {
  const schema = tool.schema && typeof tool.schema === 'object' ? tool.schema : { type: 'object' as const, properties: {} };
  const via = server.transport === 'stdio' ? server.command ?? 'stdio' : server.url ?? 'http';
  const description =
    `${tool.description || 'MCP tool.'}\n\n` +
    `Provided by the MCP server "${server.name}" (${via}). ` +
    (tool.readOnly
      ? 'This tool only reads data.'
      : 'This tool may change state — call it only when the user asked for that change.');
  return {
    name: tool.exposed,
    kind: tool.readOnly ? 'read' : 'exec',
    description,
    schema: {
      type: 'object',
      properties: (schema.properties ?? {}) as Record<string, unknown>,
      required: Array.isArray(schema.required) ? schema.required : undefined
    }
  };
}

/** Flattens an MCP `tools/call` result into the text we feed back to the model. */
export function mcpResultToText(result: unknown): string {
  if (result == null) {
    return '(no content)';
  }
  const asRecord = result as Record<string, unknown>;
  const parts: string[] = [];
  const content = Array.isArray(asRecord.content) ? (asRecord.content as Array<Record<string, unknown>>) : [];
  for (const block of content) {
    const type = String(block.type ?? '');
    if (type === 'text' || typeof block.text === 'string') {
      parts.push(String(block.text ?? ''));
    } else if (type === 'image') {
      parts.push(`[image ${String(block.mimeType ?? 'image')}, ${String(block.data ?? '').length} base64 chars]`);
    } else if (type === 'resource') {
      const resource = (block.resource ?? {}) as Record<string, unknown>;
      const text = resource.text ?? resource.blob ?? '';
      parts.push(`[resource ${String(resource.uri ?? '')}]\n${String(text).slice(0, 4000)}`);
    } else if (type === 'resource_link') {
      parts.push(`[resource_link ${String(block.uri ?? '')} ${String(block.name ?? '')}]`);
    } else {
      parts.push(JSON.stringify(block));
    }
  }
  if (asRecord.structuredContent && typeof asRecord.structuredContent === 'object') {
    parts.push(JSON.stringify(asRecord.structuredContent, null, 2));
  }
  const text = parts.filter((p) => p.trim().length > 0).join('\n\n');
  return text.trim() || '(empty result)';
}

export function mcpError(outcome: { summary: string; content: string }): ToolOutcome {
  return { ok: false, content: outcome.content, summary: outcome.summary };
}

/** Simple glob matcher for the per-server tool filter ("read_*", "search"). */
export function matchesToolFilter(name: string, filters?: string[]): boolean {
  if (!filters || filters.length === 0) {
    return true;
  }
  return filters.some((pattern) => {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    try {
      return new RegExp(`^${escaped}$`, 'i').test(name);
    } catch {
      return pattern.toLowerCase() === name.toLowerCase();
    }
  });
}

export function describeMcpTarget(server: McpServerConfig): string {
  if (server.transport === 'stdio') {
    const args = (server.args ?? []).join(' ');
    return `${server.command ?? ''} ${args}`.trim();
  }
  return server.url ?? '';
}

/** Known servers offered as one-click presets in the UI. */
export interface McpPreset {
  key: string;
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  hint: string;
  envKeys?: string[];
  needsUrl?: boolean;
  needsKey?: boolean;
  keyLabel?: string;
  keyEnv?: string;
  headers?: Record<string, string>;
  samples?: string[];
}

export const MCP_PRESETS: McpPreset[] = [
  {
    key: 'filesystem',
    name: 'Filesystem',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
    hint: 'Read/write files in a folder (the "folder" argument is the path it may touch).',
    samples: ['npx -y @modelcontextprotocol/server-filesystem .']
  },
  {
    key: 'github',
    name: 'GitHub',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    hint: 'Issues, pull requests and repository browsing.',
    envKeys: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    needsKey: true,
    keyLabel: 'GitHub personal access token',
    keyEnv: 'GITHUB_PERSONAL_ACCESS_TOKEN'
  },
  {
    key: 'fetch',
    name: 'Fetch (web)',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-fetch'],
    hint: 'Fetch a URL and convert it to markdown for the model.'
  },
  {
    key: 'memory',
    name: 'Memory',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    hint: 'Persistent knowledge graph the agent can remember things in.'
  },
  {
    key: 'playwright',
    name: 'Playwright (browser)',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    hint: 'Drive a real browser: navigate, click, screenshot, read the DOM.'
  },
  {
    key: 'sqlite',
    name: 'SQLite',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-sqlite', '--db-path', './data.db'],
    hint: 'Query a local SQLite database (needs uv/uvx installed).'
  },
  {
    key: 'sse',
    name: 'Remote server (HTTP)',
    transport: 'http',
    url: 'http://localhost:3000/mcp',
    hint: 'Any remote MCP server speaking streamable HTTP or SSE.',
    needsUrl: true
  }
];
