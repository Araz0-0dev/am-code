import { ToolCall, ToolDefinition } from './types';

/**
 * Fallback tool-call parsing for models without native function calling.
 * Supports:
 *   1. ```tool { "name": "...", "args": {...} } ```     (preferred, what the system prompt teaches)
 *   2. <tool_call>{...}</tool_call>
 *   3. an <tool name="x">...</tool> XML-ish block (best effort)
 *   4. a bare JSON object as the whole message
 */
export interface ParsedText {
  calls: ToolCall[];
  /** Assistant text with the tool block removed. */
  text: string;
}

export function parseTextToolCalls(raw: string, tools: ToolDefinition[]): ParsedText {
  const allowed = new Set(tools.map((t) => t.name));
  let text = raw ?? '';

  const fenced = /```(?:tool|tool_call|json|json5)?\s*\n?([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  const candidates: { json: string; full: string }[] = [];
  while ((match = fenced.exec(text)) !== null) {
    const body = match[1].trim();
    if (body.includes('"name"') || body.includes('"tool"') || body.includes('"function"')) {
      candidates.push({ json: body, full: match[0] });
    }
  }
  const xmlMatch = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i.exec(text);
  if (xmlMatch) {
    candidates.push({ json: xmlMatch[1].trim(), full: xmlMatch[0] });
  }
  const tagMatch = /<tool\s+name=["']?([\w-]+)["']?\s*>([\s\S]*?)<\/tool>/i.exec(text);
  if (tagMatch) {
    const name = tagMatch[1];
    const inner = tagMatch[2].trim();
    let args: Record<string, unknown>;
    try {
      args = inner.startsWith('{') ? JSON.parse(inner) : { value: inner };
    } catch {
      args = { value: inner };
    }
    if (allowed.has(name)) {
      return {
        calls: [{ id: newToolId(), name, args }],
        text: text.replace(tagMatch[0], '').trim()
      };
    }
  }

  if (candidates.length === 0) {
    const trimmed = text.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      candidates.push({ json: trimmed, full: trimmed });
    }
  }

  const calls: ToolCall[] = [];
  for (const c of candidates) {
    const call = tryParseCall(c.json, allowed);
    if (call) {
      calls.push(call);
      text = text.replace(c.full, '');
    }
  }

  return { calls, text: text.trim() };
}

function tryParseCall(json: string, allowed: Set<string>): ToolCall | null {
  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch {
    try {
      parsed = JSON.parse(json.replace(/,\s*([}\]])/g, '$1').replace(/'/g, '"'));
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }
  const name = String(parsed.name ?? parsed.tool ?? parsed.tool_name ?? parsed.function?.name ?? '');
  if (!name || !allowed.has(name)) {
    return null;
  }
  let args = parsed.args ?? parsed.arguments ?? parsed.parameters ?? parsed.function?.arguments ?? parsed.input ?? {};
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      args = { value: args };
    }
  }
  if (args && typeof args !== 'object') {
    args = { value: args };
  }
  return { id: newToolId(), name, args: (args ?? {}) as Record<string, unknown> };
}

export function newToolId(): string {
  return `call_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

/** Textual description of the tools for models without native tool calling. */
export function describeToolsForText(tools: ToolDefinition[]): string {
  const lines = tools.map((t) => {
    const props = t.schema.properties as Record<string, { description?: string; type?: string; enum?: string[] }>;
    const params = Object.entries(props)
      .map(([key, value]) => {
        const required = t.schema.required?.includes(key) ? '' : '?';
        const enumText = value.enum ? ` (${value.enum.join(' | ')})` : '';
        return `    - ${key}${required}: ${value.type ?? 'any'}${enumText} — ${value.description ?? ''}`;
      })
      .join('\n');
    return `## ${t.name}\n${t.description}\n  parameters:\n${params || '    (none)'}`;
  });
  return `# Available tools\n${lines.join('\n\n')}`;
}
