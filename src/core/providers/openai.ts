import { ChatMessage, ChatRequest, ModelConfig, Provider, ProviderStreamEvent, ToolCall } from '../types';

export interface HttpError extends Error {
  status?: number;
  bodyText?: string;
}

export function joinUrl(base: string, path: string): string {
  const b = (base || '').trim().replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  if (!b) {
    return p;
  }
  // If the user already pasted the full endpoint, do not append it twice.
  if (b.endsWith(p)) {
    return b;
  }
  return `${b}${p}`;
}

export function toOpenAiMessages(system: string, messages: ChatMessage[], vision: boolean): unknown[] {
  const out: unknown[] = [];
  if (system) {
    out.push({ role: 'system', content: system });
  }
  for (const m of messages) {
    if (m.role === 'system') {
      out.push({ role: 'system', content: m.content });
      continue;
    }
    if (m.role === 'user') {
      if (vision && m.images?.length) {
        const parts: unknown[] = [];
        if (m.content) {
          parts.push({ type: 'text', text: m.content });
        }
        for (const img of m.images) {
          parts.push({ type: 'image_url', image_url: { url: img } });
        }
        out.push({ role: 'user', content: parts });
      } else {
        out.push({ role: 'user', content: m.content });
      }
      continue;
    }
    if (m.role === 'assistant') {
      const entry: Record<string, unknown> = { role: 'assistant', content: m.content || null };
      if (m.toolCalls?.length) {
        entry.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) }
        }));
      }
      out.push(entry);
      continue;
    }
    if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
    }
  }
  return out;
}

export class OpenAiCompatibleProvider implements Provider {
  id = 'openai' as const;

  async *streamChat(req: ChatRequest): AsyncGenerator<ProviderStreamEvent> {
    const wantsTools = req.tools.length > 0 && req.model.supportsTools !== false;
    const baseBody: Record<string, unknown> = {
      model: req.model.modelId,
      messages: toOpenAiMessages(req.system, req.messages, Boolean(req.model.supportsVision)),
      stream: true,
      temperature: req.temperature ?? req.model.temperature ?? 0
    };
    if (req.maxTokens || req.model.maxTokens) {
      baseBody.max_tokens = req.maxTokens ?? req.model.maxTokens;
    }
    if (wantsTools) {
      baseBody.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.schema }
      }));
      baseBody.tool_choice = 'auto';
      baseBody.parallel_tool_calls = false;
    }

    let response = await this.post(req, { ...baseBody, stream_options: { include_usage: true } });
    if (!response.ok && response.status === 400) {
      const text = await safeText(response);
      // Many self-hosted / proxy servers reject stream_options — retry without it.
      if (/stream_options|include_usage|unrecognized|unsupported|unknown/i.test(text)) {
        response = await this.post(req, baseBody);
      } else {
        throw makeHttpError(response.status, text);
      }
    }
    if (!response.ok) {
      throw makeHttpError(response.status, await safeText(response));
    }
    if (!response.body) {
      throw makeHttpError(0, 'Empty response body (is the Base URL correct?)');
    }

    const toolAcc = new Map<number, { id: string; name: string; args: string }>();
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    let stopReason: string | null = null;

    for await (const payload of sseIterate(response.body, req.signal)) {
      if (payload === '[DONE]') {
        break;
      }
      let json: any;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      if (json.error) {
        throw makeHttpError(Number(json.error.code) || 0, json.error.message ?? JSON.stringify(json.error));
      }
      if (json.usage) {
        usage = {
          inputTokens: Number(json.usage.prompt_tokens ?? json.usage.input_tokens ?? 0),
          outputTokens: Number(json.usage.completion_tokens ?? json.usage.output_tokens ?? 0)
        };
      }
      const choice = json.choices?.[0];
      if (!choice) {
        continue;
      }
      if (choice.finish_reason) {
        stopReason = choice.finish_reason;
      }
      const delta = choice.delta ?? choice.message ?? {};
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === 'string' && reasoning) {
        yield { type: 'reasoning', text: reasoning };
      }
      if (typeof delta.content === 'string' && delta.content) {
        yield { type: 'text', text: delta.content };
      }
      const calls = delta.tool_calls;
      if (Array.isArray(calls)) {
        for (const c of calls) {
          const index = Number(c.index ?? 0);
          const acc = toolAcc.get(index) ?? { id: '', name: '', args: '' };
          if (c.id) {
            acc.id = c.id;
          }
          if (c.function?.name) {
            acc.name = (acc.name + c.function.name).trim() === c.function.name ? c.function.name : acc.name + c.function.name;
          }
          if (typeof c.function?.arguments === 'string') {
            acc.args += c.function.arguments;
          }
          toolAcc.set(index, acc);
        }
      }
    }

    for (const [, acc] of [...toolAcc.entries()].sort((a, b) => a[0] - b[0])) {
      if (!acc.name) {
        continue;
      }
      yield {
        type: 'tool_call',
        call: { id: acc.id || `call_${Math.random().toString(36).slice(2, 10)}`, name: acc.name, args: parseArgs(acc.args) }
      };
    }

    yield { type: 'done', stopReason, usage };
  }

  async listModels(model: ModelConfig, apiKey?: string): Promise<string[]> {
    const res = await fetch(joinUrl(model.baseUrl, '/models'), {
      headers: buildHeaders(model, apiKey)
    });
    if (!res.ok) {
      throw makeHttpError(res.status, await safeText(res));
    }
    const json: any = await res.json();
    const list = json?.data ?? json?.models ?? [];
    return (Array.isArray(list) ? list : [])
      .map((m: any) => String(m?.id ?? m?.name ?? ''))
      .filter(Boolean)
      .sort();
  }

  private async post(req: ChatRequest, body: Record<string, unknown>): Promise<Response> {
    return fetch(joinUrl(req.model.baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: { ...buildHeaders(req.model, req.apiKey), 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: req.signal
    });
  }
}

export function buildHeaders(model: ModelConfig, apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = { ...(model.headers ?? {}) };
  const key = apiKey ?? (model.apiKeyEnv ? process.env[model.apiKeyEnv] : undefined);
  if (key) {
    if (model.provider === 'anthropic') {
      headers['x-api-key'] = key;
      headers['anthropic-version'] = headers['anthropic-version'] ?? '2023-06-01';
    } else {
      headers['Authorization'] = `Bearer ${key}`;
    }
  }
  return headers;
}

export function parseArgs(raw: string): Record<string, unknown> {
  const text = (raw ?? '').trim();
  if (!text) {
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : { value: parsed };
  } catch {
    // Some models emit almost-JSON (trailing commas, single quotes). Try a gentle repair.
    try {
      const repaired = text
        .replace(/,\s*([}\]])/g, '$1')
        .replace(/'/g, '"');
      const parsed = JSON.parse(repaired);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : { value: parsed };
    } catch {
      return { __raw: text };
    }
  }
}

export async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

export function makeHttpError(status: number, bodyText: string): HttpError {
  const hint =
    status === 401 || status === 403
      ? ' — check the API key for this model (AM Code: Set API Key for Model).'
      : status === 404
        ? ' — check the Base URL and the Model ID; OpenAI-compatible servers expect the /v1 path without /chat/completions.'
        : status === 429
          ? ' — rate limited; wait a moment or switch model.'
          : '';
  const err = new Error(`HTTP ${status} from the model endpoint${hint}\n${truncateBody(bodyText)}`) as HttpError;
  err.status = status;
  err.bodyText = bodyText;
  return err;
}

function truncateBody(text: string): string {
  const t = (text ?? '').trim();
  return t.length > 1200 ? `${t.slice(0, 1200)}…` : t;
}

/** Minimal SSE reader that works on Node's fetch body stream. */
export async function* sseIterate(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) {
          continue;
        }
        const data = line.slice(5).trim();
        if (data) {
          yield data;
        }
      }
    }
    const rest = buffer.trim();
    if (rest.startsWith('data:')) {
      yield rest.slice(5).trim();
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}
