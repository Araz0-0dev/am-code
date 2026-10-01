/**
 * Token saver — squeezes every request before it leaves the machine.
 *
 * The expensive part of an agent conversation is almost never the user's words; it is the
 * transcript that grows around them: file dumps, command output, MCP payloads and screenshots
 * that get re-sent with every single step. This module rewrites *the copy* that goes to the
 * provider (the saved session stays intact) using techniques that keep the meaning:
 *
 *  1. tool-result digesting — head + tail of every old tool result, middle replaced by a marker
 *     that still says how much was there (errors and summaries live at the edges),
 *  2. duplicate collapsing — identical results (same file read twice, same command output)
 *     become a one-line pointer to the copy that is already in the transcript,
 *  3. stale file reads — when a file is read again later, the older copy is dropped,
 *  4. image dropping — screenshots older than the protected tail are removed,
 *  5. noise scrubbing — ANSI colours, carriage returns and runs of blank lines disappear.
 *
 * Everything is deterministic and pair-safe: a tool message is never separated from the
 * assistant tool call it answers, which strict APIs (OpenAI, Anthropic) would reject.
 */

import { ChatMessage } from './types';
import { estimateMessageTokens, estimateTokens } from './context';

export type TokenSaverMode = 'off' | 'balanced' | 'aggressive';

export interface TokenSaverSettings {
  mode: TokenSaverMode;
  /** How many of the newest messages are never touched. */
  keepRecent: number;
  /** Tool results longer than this are digested (balanced). */
  maxToolResultChars: number;
  /** Replace repeated identical tool output with a pointer. */
  dedupeToolResults: boolean;
  /** Drop image attachments from older messages. */
  dropOldImages: boolean;
}

export const DEFAULT_TOKEN_SAVER: TokenSaverSettings = {
  mode: 'balanced',
  keepRecent: 6,
  maxToolResultChars: 1400,
  dedupeToolResults: true,
  dropOldImages: true
};

export interface CompressionStats {
  mode: TokenSaverMode;
  beforeTokens: number;
  afterTokens: number;
  savedTokens: number;
  savedPercent: number;
  /** Messages whose payload changed. */
  messagesTouched: number;
  /** Human readable list of what was squeezed (shown in the UI). */
  notes: string[];
}

function clampSettings(settings?: Partial<TokenSaverSettings>): TokenSaverSettings {
  const merged = { ...DEFAULT_TOKEN_SAVER, ...(settings ?? {}) };
  const aggressive = merged.mode === 'aggressive';
  return {
    mode: merged.mode,
    keepRecent: Math.max(2, Math.min(60, merged.keepRecent || DEFAULT_TOKEN_SAVER.keepRecent)),
    maxToolResultChars: aggressive ? 600 : Math.max(400, Math.min(8000, merged.maxToolResultChars)),
    dedupeToolResults: merged.dedupeToolResults !== false,
    dropOldImages: merged.dropOldImages !== false
  };
}

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

/** Removes things that cost tokens but carry no meaning. */
function scrub(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(ANSI, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n');
}

function digest(text: string, maxChars: number): string {
  const headLines = Math.max(4, Math.floor(maxChars / 90));
  const tailLines = Math.max(3, Math.floor(maxChars / 140));
  const lines = text.split('\n');
  if (lines.length <= headLines + tailLines + 4) {
    return text;
  }
  const head = lines.slice(0, headLines).join('\n');
  const tail = lines.slice(-tailLines).join('\n');
  const dropped = lines.length - headLines - tailLines;
  return `${head}\n\n… [${dropped} lines / ${Math.max(0, text.length - head.length - tail.length)} chars of ${
    text.length
  } omitted by the AM Code token saver — re-read or re-run if you need them again] …\n\n${tail}`;
}

/** Pointer used when an identical result already exists later/earlier in the transcript. */
function pointer(tool: string, hint: string): string {
  return `[token saver] identical ${tool} output already sent earlier in this conversation (${hint}) — not repeated.`;
}

function toolSignature(message: ChatMessage): string | undefined {
  if (message.role !== 'tool' || !message.content) {
    return undefined;
  }
  const body = message.content.trim();
  if (body.length < 400) {
    return undefined; // too small to be worth a pointer
  }
  // cheap 64-bit-ish hash: length + a rolling FNV over the body
  let hash = 2166136261;
  for (let i = 0; i < body.length; i += 7) {
    hash ^= body.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${body.length}:${(hash >>> 0).toString(36)}`;
}

/**
 * Maps every tool result to the file it read, by looking at the assistant tool call that
 * produced it (message.toolCallId → args.path). Falls back to a text heuristic for tools
 * that are not the builtin reader.
 */
function readPathsById(messages: ChatMessage[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.toolCalls) {
      continue;
    }
    for (const call of message.toolCalls) {
      const args = (call.args ?? {}) as Record<string, unknown>;
      const path = typeof args.path === 'string' ? args.path.trim() : '';
      if (path && /read|cat|view|open/i.test(call.name)) {
        map.set(call.id, path);
      }
    }
  }
  return map;
}

function guessReadPath(message: ChatMessage): string | undefined {
  const firstLine = (message.content ?? '').split('\n')[0] ?? '';
  const match = /^(?:read|cat)\s+(\S+)/i.exec(firstLine);
  return match ? match[1].trim() : undefined;
}

export interface CompressResult {
  messages: ChatMessage[];
  stats: CompressionStats;
}

/**
 * Returns a compressed *copy* of the transcript for the provider call.
 * The caller keeps its own history untouched.
 */
export function compressMessages(messages: ChatMessage[], settings?: Partial<TokenSaverSettings>): CompressResult {
  const options = clampSettings(settings);
  const before = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  if (options.mode === 'off' || messages.length === 0) {
    return {
      messages,
      stats: {
        mode: options.mode,
        beforeTokens: before,
        afterTokens: before,
        savedTokens: 0,
        savedPercent: 0,
        messagesTouched: 0,
        notes: []
      }
    };
  }

  const copy = messages.map((m) => ({ ...m }));
  const protectedCount = Math.min(options.keepRecent, copy.length);
  const firstProtected = copy.length - protectedCount;

  const notes: string[] = [];
  let touched = 0;
  let digestedCount = 0;
  const dedupedCount = { value: 0 };
  let supersededReads = 0;
  let droppedImages = 0;

  // ---- pass 1: scrub noise everywhere, but leave the protected tail readable
  for (let i = 0; i < copy.length; i += 1) {
    const message = copy[i];
    const content = message.content;
    if (typeof content === 'string' && content.length > 120 && (message.role === 'tool' || content.length > 600)) {
      const scrubbed = scrub(content);
      if (scrubbed !== content) {
        message.content = scrubbed;
      }
    }
  }

  // ---- pass 2: supersede stale file reads (same path read again later)
  const readPaths = readPathsById(copy);
  const pathOf = (message: ChatMessage): string | undefined =>
    (message.toolCallId ? readPaths.get(message.toolCallId) : undefined) ?? guessReadPath(message);

  const lastReadByPath = new Map<string, number>();
  for (let i = 0; i < copy.length; i += 1) {
    const path = pathOf(copy[i]);
    if (path) {
      lastReadByPath.set(path, i);
    }
  }

  // ---- pass 3a: find duplicate tool output (keep the newest copy, collapse the older ones)
  const lastBySignature = new Map<string, number>();
  if (options.dedupeToolResults) {
    for (let i = 0; i < copy.length; i += 1) {
      const signature = toolSignature(copy[i]);
      if (signature) {
        lastBySignature.set(signature, i);
      }
    }
  }

  // ---- pass 3b: collapse duplicates, digest big ones
  for (let i = 0; i < copy.length; i += 1) {
    const message = copy[i];
    if (i >= firstProtected) {
      continue; // never touch the newest messages
    }
    const signature = toolSignature(message);
    if (signature && options.dedupeToolResults && lastBySignature.get(signature) !== i) {
      const newer = (lastBySignature.get(signature) ?? 0) + 1;
      message.content = pointer(
        message.name ?? 'tool',
        `the newest copy is message #${newer}, ${(message.content ?? '').trim().length} chars — that one is still in this request`
      );
      dedupedCount.value += 1;
      touched += 1;
      continue;
    }

    if (message.role !== 'tool' || !message.content) {
      continue;
    }

    const path = pathOf(message);
    if (path && lastReadByPath.get(path) !== i) {
      message.content = `[token saver] older copy of ${path} removed — the file was read again later in this conversation (${
        (message.content ?? '').trim().length
      } chars, still available on disk).`;
      supersededReads += 1;
      touched += 1;
      continue;
    }

    if (message.content.length > options.maxToolResultChars) {
      message.content = digest(message.content, options.maxToolResultChars);
      digestedCount += 1;
      touched += 1;
    }
  }

  // ---- pass 4: screenshots older than the protected tail
  if (options.dropOldImages) {
    for (let i = 0; i < firstProtected; i += 1) {
      const message = copy[i];
      if (message.images?.length) {
        const count = message.images.length;
        delete message.images;
        message.content = `${message.content ?? ''}\n[token saver] ${count} image attachment${
          count === 1 ? '' : 's'
        } from earlier in the conversation were dropped (ask again if you need them).`.trim();
        droppedImages += count;
        touched += 1;
      }
    }
  }

  const after = copy.reduce((sum, m) => sum + estimateMessageTokens(m), 0);

  if (digestedCount) {
    notes.push(`${digestedCount} large tool result${digestedCount === 1 ? '' : 's'} digested (head + tail kept)`);
  }
  if (dedupedCount.value) {
    notes.push(`${dedupedCount.value} repeated tool output${dedupedCount.value === 1 ? '' : 's'} collapsed to a pointer`);
  }
  if (supersededReads) {
    notes.push(`${supersededReads} stale file read${supersededReads === 1 ? '' : 's'} superseded`);
  }
  if (droppedImages) {
    notes.push(`${droppedImages} older image${droppedImages === 1 ? '' : 's'} dropped from the request`);
  }

  const savedTokens = Math.max(0, before - after);
  return {
    messages: copy,
    stats: {
      mode: options.mode,
      beforeTokens: before,
      afterTokens: after,
      savedTokens,
      savedPercent: before > 0 ? Math.round((savedTokens / before) * 100) : 0,
      messagesTouched: touched,
      notes
    }
  };
}

/** Cheap description of the tool surface (MCP servers can add a lot of schema tokens). */
/** Total size of the transcript (used by the Tokens screen). */
export function transcriptTokens(messages: ChatMessage[]): number {
  return estimateTokens('', messages);
}

export function estimateToolSurfaceTokens(tools: Array<{ name: string; description: string; schema: unknown }>): number {
  return tools.reduce((sum, tool) => sum + Math.ceil((tool.name.length + tool.description.length) / 4) + Math.ceil(JSON.stringify(tool.schema ?? {}).length / 4), 0);
}

export function describeTokenSaver(settings: Partial<TokenSaverSettings> | undefined): string {
  const mode = (settings?.mode ?? DEFAULT_TOKEN_SAVER.mode) as TokenSaverMode;
  if (mode === 'off') {
    return 'Token saver is off — every request carries the full transcript.';
  }
  if (mode === 'aggressive') {
    return 'Token saver: aggressive — maximum squeezing (tool results cut to head + tail, images dropped early).';
  }
  return 'Token saver: balanced — old tool output digested, duplicates collapsed, images trimmed.';
}
