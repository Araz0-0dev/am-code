import { ChatMessage } from './types';

/** Rough token estimate (~4 chars/token for code+prose, images cost a flat amount). */
export function estimateMessageTokens(m: ChatMessage): number {
  const text = m.content ?? '';
  let tokens = Math.ceil(text.length / 4) + 8;
  if (m.images?.length) {
    tokens += m.images.length * 800;
  }
  for (const tc of m.toolCalls ?? []) {
    tokens += Math.ceil(JSON.stringify(tc.args ?? {}).length / 4) + 10;
  }
  return tokens;
}

export function estimateTokens(system: string, messages: ChatMessage[]): number {
  return Math.ceil((system?.length ?? 0) / 4) + messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

const OMITTED = '[older tool output omitted to save context — re-run the tool if you need it again]';

/**
 * Keeps the transcript inside the model's context window:
 *  - large old tool results are replaced with a placeholder,
 *  - the oldest messages are dropped, but an assistant message is never separated
 *    from the tool results that answer its tool calls (that breaks strict APIs).
 */
export function trimHistory(
  messages: ChatMessage[],
  budgetTokens: number,
  keepRecent = 16
): { messages: ChatMessage[]; trimmed: boolean; dropped: number } {
  if (messages.length === 0) {
    return { messages, trimmed: false, dropped: 0 };
  }
  const working = messages.map((m) => ({ ...m }));
  let trimmed = false;

  // 1) compress old tool outputs (keep the most recent ones intact)
  const toolIndexes = working.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0);
  const protectFrom = toolIndexes.length - 4;
  toolIndexes.slice(0, Math.max(0, protectFrom)).forEach((i) => {
    const msg = working[i];
    if (msg.content && msg.content.length > 700) {
      msg.content = `${msg.content.slice(0, 400)}\n${OMITTED}`;
      trimmed = true;
    }
  });

  // 2) drop oldest messages until we fit
  let total = working.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  let cut = 0;
  while (total > budgetTokens && cut < working.length - keepRecent && cut < working.length) {
    total -= estimateMessageTokens(working[cut]);
    cut++;
    trimmed = true;
  }
  let kept = working.slice(cut);

  // 3) never start the history with orphaned tool results
  while (kept.length && kept[0].role === 'tool') {
    kept = kept.slice(1);
  }
  // 4) never end with an assistant tool call whose results were dropped
  const lastAssistantWithCalls = [...kept].reverse().find((m) => m.role === 'assistant' && m.toolCalls?.length);
  if (lastAssistantWithCalls) {
    const answered = new Set(kept.filter((m) => m.role === 'tool').map((m) => m.toolCallId));
    if (lastAssistantWithCalls.toolCalls!.every((tc) => !answered.has(tc.id))) {
      kept = kept.filter((m) => m !== lastAssistantWithCalls);
    }
  }

  return { messages: kept, trimmed, dropped: cut };
}

/** Crude digest of a conversation used by /compact when no model call is desired. */
export function digestTranscript(messages: ChatMessage[], maxChars = 8000): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      continue;
    }
    const label = m.role === 'user' ? 'USER' : m.role === 'assistant' ? 'ASSISTANT' : `TOOL(${m.name ?? ''})`;
    const body = (m.content ?? '').trim();
    if (!body) {
      continue;
    }
    parts.push(`### ${label}\n${body.length > 1200 ? `${body.slice(0, 1200)}…` : body}`);
  }
  const joined = parts.join('\n\n');
  return joined.length > maxChars ? `${joined.slice(0, maxChars)}\n…(truncated)` : joined;
}
