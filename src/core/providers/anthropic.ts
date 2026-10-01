import { ChatMessage, ChatRequest, ModelConfig, Provider, ProviderStreamEvent } from '../types';
import { buildHeaders, joinUrl, parseArgs, safeText, sseIterate } from './openai';

interface Block {
  type: string;
  [key: string]: unknown;
}

/** Converts the internal transcript into Anthropic /v1/messages format. */
export function toAnthropicMessages(messages: ChatMessage[], vision: boolean): unknown[] {
  const out: unknown[] = [];
  const push = (role: 'user' | 'assistant', blocks: unknown[]) => {
    const last = out[out.length - 1] as { role: string; content: unknown[] } | undefined;
    if (last && last.role === role) {
      last.content.push(...blocks);
    } else {
      out.push({ role, content: blocks });
    }
  };

  for (const m of messages) {
    if (m.role === 'system') {
      continue;
    }
    if (m.role === 'user') {
      const blocks: unknown[] = [];
      if (vision && m.images?.length) {
        for (const img of m.images) {
          const match = /^data:(.*?);base64,(.*)$/.exec(img);
          if (match) {
            blocks.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } });
          } else {
            blocks.push({ type: 'image', source: { type: 'url', url: img } });
          }
        }
      }
      blocks.push({ type: 'text', text: m.content || '(empty)' });
      push('user', blocks);
      continue;
    }
    if (m.role === 'assistant') {
      const blocks: unknown[] = [];
      if (m.content) {
        blocks.push({ type: 'text', text: m.content });
      }
      for (const tc of m.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args ?? {} });
      }
      if (blocks.length) {
        push('assistant', blocks);
      }
      continue;
    }
    if (m.role === 'tool') {
      push('user', [
        {
          type: 'tool_result',
          tool_use_id: m.toolCallId,
          content: m.content || '(empty result)',
          is_error: /^\s*ERROR|^\s*✗/i.test(m.content ?? '')
        }
      ]);
    }
  }
  return out;
}

export class AnthropicProvider implements Provider {
  id = 'anthropic' as const;

  async *streamChat(req: ChatRequest): AsyncGenerator<ProviderStreamEvent> {
    const wantsTools = req.tools.length > 0 && req.model.supportsTools !== false;
    const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const convo = req.messages.filter((m) => m.role !== 'system');

    const body: Record<string, unknown> = {
      model: req.model.modelId,
      max_tokens: req.maxTokens ?? req.model.maxTokens ?? 8192,
      messages: toAnthropicMessages(convo, Boolean(req.model.supportsVision)),
      stream: true,
      temperature: req.temperature ?? req.model.temperature ?? 0
    };
    if (req.system || system) {
      body.system = req.system || system;
    }
    if (wantsTools) {
      body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema }));
    }

    const res = await fetch(joinUrl(req.model.baseUrl, '/messages'), {
      method: 'POST',
      headers: {
        ...buildHeaders(req.model, req.apiKey),
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        Accept: 'text/event-stream'
      },
      body: JSON.stringify(body),
      signal: req.signal
    });

    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} from the Anthropic endpoint\n${(await safeText(res)).slice(0, 1200)}`);
      throw err;
    }
    if (!res.body) {
      throw new Error('Empty response body from the Anthropic endpoint');
    }

    const blocks = new Map<number, { type: string; id: string; name: string; json: string }>();
    let usage = { inputTokens: 0, outputTokens: 0 };
    let stopReason: string | null = null;

    for await (const data of sseIterate(res.body, req.signal)) {
      let json: any;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      switch (json.type) {
        case 'message_start':
          usage.inputTokens = Number(json.message?.usage?.input_tokens ?? 0);
          usage.outputTokens = Number(json.message?.usage?.output_tokens ?? 0);
          break;
        case 'content_block_start': {
          const b = json.content_block as Block;
          blocks.set(Number(json.index), {
            type: String(b.type),
            id: String(b.id ?? ''),
            name: String(b.name ?? ''),
            json: b.input && Object.keys(b.input as object).length ? JSON.stringify(b.input) : ''
          });
          break;
        }
        case 'content_block_delta': {
          const index = Number(json.index);
          const delta = json.delta ?? {};
          if (delta.type === 'text_delta' && delta.text) {
            yield { type: 'text', text: String(delta.text) };
          } else if (delta.type === 'thinking_delta' && delta.thinking) {
            yield { type: 'reasoning', text: String(delta.thinking) };
          } else if (delta.type === 'input_json_delta' && delta.partial_json) {
            const acc = blocks.get(index) ?? { type: 'tool_use', id: '', name: '', json: '' };
            acc.json += String(delta.partial_json);
            blocks.set(index, acc);
          }
          break;
        }
        case 'message_delta':
          if (json.delta?.stop_reason) {
            stopReason = String(json.delta.stop_reason);
          }
          if (json.usage?.output_tokens) {
            usage.outputTokens = Number(json.usage.output_tokens);
          }
          if (json.usage?.input_tokens) {
            usage.inputTokens = Number(json.usage.input_tokens);
          }
          break;
        case 'error':
          throw new Error(`Anthropic stream error: ${json.error?.message ?? JSON.stringify(json.error)}`);
        default:
          break;
      }
    }

    for (const [, b] of [...blocks.entries()].sort((a, c) => a[0] - c[0])) {
      if (b.type !== 'tool_use' || !b.name) {
        continue;
      }
      yield {
        type: 'tool_call',
        call: { id: b.id || `toolu_${Math.random().toString(36).slice(2, 10)}`, name: b.name, args: parseArgs(b.json) }
      };
    }

    yield { type: 'done', stopReason, usage };
  }

  async listModels(model: ModelConfig, apiKey?: string): Promise<string[]> {
    const res = await fetch(joinUrl(model.baseUrl, '/models'), { headers: buildHeaders(model, apiKey) });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${(await safeText(res)).slice(0, 400)}`);
    }
    const json: any = await res.json();
    const list = json?.data ?? [];
    return (Array.isArray(list) ? list : []).map((m: any) => String(m?.id ?? '')).filter(Boolean).sort();
  }
}
