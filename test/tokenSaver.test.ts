/* Token saver tests: the compression that runs before every provider request. Run with: npm test */
import * as assert from 'assert';
import { Agent, AgentHost, AgentRunOptions, HostContext } from '../src/core/agent';
import { estimateMessageTokens } from '../src/core/context';
import { setProviderFactory } from '../src/core/providers';
import { AgentSession } from '../src/core/session';
import { compressMessages, describeTokenSaver } from '../src/core/tokenSaver';
import type {
  AgentEvent,
  ChatMessage,
  ModelConfig,
  PermissionDecision,
  PermissionRequest,
  Plan,
  PlanDecision,
  Provider,
  ProviderStreamEvent,
  AskUserAnswer,
  AskUserRequest,
  ChatRequest,
  ToolCall,
  ToolOutcome
} from '../src/core/types';

const TESTS: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  TESTS.push({ name, fn });
}

const total = (messages: ChatMessage[]) => messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);

function bigFile(lines = 400, marker = 'const value = 1;'): string {
  return Array.from({ length: lines }, (_, i) => `${String(i + 1).padStart(4)}  ${marker} // line ${i + 1}`).join('\n');
}

function conversation(): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'user', content: 'Refactor the parser and run the tests.', ts: 1 }];
  for (let i = 0; i < 6; i += 1) {
    messages.push({
      role: 'assistant',
      content: `Step ${i}: reading files`,
      toolCalls: [{ id: `c${i}`, name: 'read_file', args: { path: `src/file${i}.ts` } }],
      ts: 2 + i
    });
    messages.push({ role: 'tool', toolCallId: `c${i}`, name: 'read_file', content: bigFile(300, `export const f${i} = ${i};`), ts: 3 + i });
  }
  messages.push({ role: 'assistant', content: 'Working on it.', ts: 20 });
  return messages;
}

test('big tool results are digested to head + tail with an honest marker', () => {
  const messages = conversation();
  const { messages: out, stats } = compressMessages(messages, { mode: 'balanced', keepRecent: 2 });
  const squeezed = out.filter((m) => m.role === 'tool' && (m.content ?? '').includes('token saver'));
  assert.ok(squeezed.length >= 4, `expected digested results, got ${squeezed.length}`);
  const sample = squeezed[0].content ?? '';
  assert.ok(sample.includes('omitted by the AM Code token saver'), 'marker must explain itself');
  assert.ok(sample.length < 2200, 'digested result must be much smaller');
  assert.ok(stats.savedTokens > 0 && stats.savedPercent > 30, JSON.stringify(stats));
  assert.ok(stats.notes.some((n) => n.includes('digested')), JSON.stringify(stats.notes));
});

test('the newest messages are never touched', () => {
  const messages = conversation();
  const { messages: out } = compressMessages(messages, { mode: 'balanced', keepRecent: 4 });
  for (let i = 0; i < 4; i += 1) {
    const before = messages[messages.length - 1 - i];
    const after = out[out.length - 1 - i];
    assert.strictEqual(after.content, before.content, 'recent message must keep its original text');
    assert.deepStrictEqual(after.images, before.images);
  }
});

test('mode "off" is a no-op and reports zero savings', () => {
  const messages = conversation();
  const { messages: out, stats } = compressMessages(messages, { mode: 'off' });
  assert.deepStrictEqual(out.map((m) => m.content), messages.map((m) => m.content));
  assert.strictEqual(stats.savedTokens, 0);
  assert.strictEqual(stats.afterTokens, stats.beforeTokens);
});

test('identical tool output is collapsed to a pointer', () => {
  const payload = bigFile(500, 'the same command output');
  const messages: ChatMessage[] = [
    { role: 'user', content: 'run the tests twice', ts: 1 },
    {
      role: 'assistant',
      content: 'running',
      toolCalls: [{ id: 'a1', name: 'run_command', args: { command: 'npm test' } }],
      ts: 2
    },
    { role: 'tool', toolCallId: 'a1', name: 'run_command', content: payload, ts: 3 },
    {
      role: 'assistant',
      content: 'running again',
      toolCalls: [{ id: 'a2', name: 'run_command', args: { command: 'npm test' } }],
      ts: 4
    },
    { role: 'tool', toolCallId: 'a2', name: 'run_command', content: payload, ts: 5 },
    { role: 'assistant', content: 'done', ts: 6 }
  ];
  const { messages: out, stats } = compressMessages(messages, { mode: 'balanced', keepRecent: 2 });
  const pointers = out.filter((m) => (m.content ?? '').includes('identical run_command output'));
  assert.strictEqual(pointers.length, 1, 'the duplicate must become a pointer');
  assert.ok(out[out.length - 1].content === 'done', 'the tail is untouched');
  assert.ok(stats.notes.some((n) => n.includes('collapsed')), JSON.stringify(stats.notes));
});

test('a file that is read again later supersedes its older copy', () => {
  const v1 = bigFile(600, 'const version = 1;');
  const v2 = bigFile(600, 'const version = 2;');
  const messages: ChatMessage[] = [
    { role: 'user', content: 'update config.ts', ts: 1 },
    { role: 'assistant', content: 'reading', toolCalls: [{ id: 'r1', name: 'read_file', args: { path: 'src/config.ts' } }], ts: 2 },
    { role: 'tool', toolCallId: 'r1', name: 'read_file', content: v1, ts: 3 },
    { role: 'assistant', content: 'editing', toolCalls: [{ id: 'w1', name: 'edit_file', args: { path: 'src/config.ts' } }], ts: 4 },
    { role: 'tool', toolCallId: 'w1', name: 'edit_file', content: 'applied', ts: 5 },
    { role: 'assistant', content: 're-reading', toolCalls: [{ id: 'r2', name: 'read_file', args: { path: 'src/config.ts' } }], ts: 6 },
    { role: 'tool', toolCallId: 'r2', name: 'read_file', content: v2, ts: 7 }
  ];
  const { messages: out, stats } = compressMessages(messages, { mode: 'balanced', keepRecent: 2 });
  const stale = out[2];
  assert.ok((stale.content ?? '').includes('older copy of src/config.ts removed'), stale.content);
  assert.strictEqual(out[6].content, v2, 'the newest read stays verbatim');
  assert.ok(stats.notes.some((n) => n.includes('stale file read')), JSON.stringify(stats.notes));
});

test('older screenshots are dropped but the latest one survives', () => {
  const image = `data:image/png;base64,${'A'.repeat(4000)}`;
  const messages: ChatMessage[] = [
    { role: 'user', content: 'look at this screenshot', images: [image], ts: 1 },
    { role: 'assistant', content: 'I see the bug.', ts: 2 },
    { role: 'user', content: 'and this one', images: [image], ts: 3 },
    { role: 'assistant', content: 'also visible.', ts: 4 }
  ];
  const { messages: out, stats } = compressMessages(messages, { mode: 'balanced', keepRecent: 2 });
  assert.strictEqual(out[0].images, undefined, 'the old screenshot is gone');
  assert.deepStrictEqual(out[2].images, [image], 'the recent screenshot is kept');
  assert.ok((out[0].content ?? '').includes('image attachment'), 'the model is told what happened');
  assert.ok(stats.notes.some((n) => n.includes('image')), JSON.stringify(stats.notes));
});

test('noise scrubbing removes ANSI colours, CRLF and blank-line runs', () => {
  const noisy = [
    '\u001b[32mPASS\u001b[0m src/a.test.ts\r',
    '',
    '',
    '',
    '\u001b[31mFAIL\u001b[0m src/b.test.ts\r',
    ...Array.from({ length: 60 }, (_, i) => `line ${i}`)
  ].join('\n');
  const messages: ChatMessage[] = [
    {
      role: 'assistant',
      content: 'ran',
      toolCalls: [{ id: 'x1', name: 'run_command', args: { command: 'npm test' } }],
      ts: 1
    },
    { role: 'tool', toolCallId: 'x1', name: 'run_command', content: noisy, ts: 2 },
    { role: 'assistant', content: 'ok', ts: 3 }
  ];
  const { messages: out } = compressMessages(messages, { mode: 'balanced', keepRecent: 1 });
  const text = out[1].content ?? '';
  assert.ok(!text.includes('\u001b['), 'ANSI escapes must be gone');
  assert.ok(!text.includes('\r'), 'carriage returns must be gone');
  assert.ok(!/\n{3,}/.test(text), 'blank-line runs must be collapsed');
});

test('aggressive mode squeezes at least as hard as balanced and keeps the shape valid', () => {
  const messages = conversation();
  const balanced = compressMessages(messages, { mode: 'balanced', keepRecent: 4 });
  const aggressive = compressMessages(messages, { mode: 'aggressive', keepRecent: 4 });
  assert.ok(aggressive.stats.afterTokens <= balanced.stats.afterTokens, JSON.stringify([balanced.stats, aggressive.stats]));
  assert.ok(aggressive.stats.savedPercent >= balanced.stats.savedPercent);

  // pairing rules: no orphaned tool result at the start, no unanswered assistant tool call at the end
  for (const result of [balanced, aggressive]) {
    const out = result.messages;
    assert.notStrictEqual(out[0]?.role, 'tool', 'history must not start with a tool result');
    const answered = new Set(out.filter((m) => m.role === 'tool').map((m) => m.toolCallId));
    const lastAssistant = [...out].reverse().find((m) => m.role === 'assistant' && m.toolCalls?.length);
    if (lastAssistant) {
      assert.ok(
        lastAssistant.toolCalls!.every((tc) => answered.has(tc.id)),
        'an assistant tool call must keep its results'
      );
    }
  }
});

test('the saver never mutates the caller history and is deterministic', () => {
  const messages = conversation();
  const snapshot = JSON.stringify(messages);
  const first = compressMessages(messages, { mode: 'balanced', keepRecent: 3 });
  const second = compressMessages(messages, { mode: 'balanced', keepRecent: 3 });
  assert.strictEqual(JSON.stringify(messages), snapshot, 'the saved session must stay intact');
  assert.strictEqual(JSON.stringify(first.messages), JSON.stringify(second.messages), 'compression must be deterministic');
  assert.ok(total(first.messages) < total(messages));
});

test('describeTokenSaver explains the active mode', () => {
  assert.ok(describeTokenSaver({ mode: 'off' }).includes('off'));
  assert.ok(describeTokenSaver({ mode: 'aggressive' }).includes('aggressive'));
  assert.ok(describeTokenSaver(undefined).includes('balanced'));
});

// --------------------------------------------------------------------------- on the wire

class WireHost implements AgentHost {
  readonly events: AgentEvent[] = [];
  constructor(private readonly payload: string, private readonly tokenSaver: Partial<import('../src/core/tokenSaver').TokenSaverSettings>) {}
  emit(event: AgentEvent): void {
    this.events.push(event);
  }
  async executeTool(): Promise<ToolOutcome> {
    return { ok: true, content: this.payload, summary: 'read a big file' };
  }
  async requestPermission(): Promise<PermissionDecision> {
    return { allowed: true };
  }
  async approvePlan(): Promise<PlanDecision> {
    return { approved: true };
  }
  async askUser(_request: AskUserRequest): Promise<AskUserAnswer> {
    return { answer: 'yes' };
  }
  async getApiKey(): Promise<string> {
    return 'k';
  }
  async collectContext(): Promise<HostContext> {
    return { rulesFiles: [], cwd: process.cwd(), workspaceName: 'w', os: 'linux', today: '2026-01-01' };
  }
  getOptions(): AgentRunOptions {
    return {
      model: { id: 'm', name: 'm', provider: 'openai', baseUrl: 'http://localhost/v1', modelId: 'm', contextWindow: 200000 } as ModelConfig,
      toolCallMode: 'native',
      maxSteps: 4,
      softStepBudget: 0,
      strictChecklist: false,
      alwaysPlan: false,
      enableWebTools: false,
      subagents: false,
      customInstructions: '',
      thinkingBudgetHint: 'low',
      responseLanguage: 'auto',
      includeOpenFileContext: false,
      includeDiagnostics: false,
      tokenSaver: { mode: 'balanced', keepRecent: 2, maxToolResultChars: 1200, dedupeToolResults: true, dropOldImages: true, ...this.tokenSaver }
    };
  }
  onModeChanged(): void {}
  onTodosChanged(): void {}
  save(): void {}
}

test('the saver shrinks what actually goes over the wire', async () => {
  const payload = bigFile(900, 'const heavy = true;');
  const host = new WireHost(payload, {});
  const sent: ChatMessage[][] = [];
  const provider: Provider = {
    id: 'openai',
    // eslint-disable-next-line require-yield
    async *streamChat(req: ChatRequest): AsyncGenerator<ProviderStreamEvent> {
      sent.push(req.messages.map((m) => ({ ...m })));
      const step = sent.length;
      if (step === 1) {
        yield { type: 'tool_call', call: { id: 'c1', name: 'read_file', args: { path: 'src/heavy.ts' } } };
        yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
        return;
      }
      if (step === 2) {
        // a second tool call is what makes the first (huge) result "old"
        yield { type: 'tool_call', call: { id: 'c2', name: 'list_dir', args: { path: '.' } } };
        yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
        return;
      }
      yield { type: 'text', text: 'Done.' };
      yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
    }
  };
  setProviderFactory(() => provider);

  const agent = new Agent(host, new AgentSession('build'));
  await agent.send('read the heavy file, then look around');

  assert.ok(sent.length >= 3, `expected at least three steps, got ${sent.length}`);
  const wire = sent[2];
  const toolMessage = wire.find((m) => m.role === 'tool' && (m.content ?? '').includes('token saver'));
  assert.ok(toolMessage, `the big result must be digested before it is re-sent:\n${JSON.stringify(wire.map((m) => [m.role, (m.content ?? '').length]))}`);
  assert.ok((toolMessage!.content ?? '').length < payload.length / 2, 'the payload must be much smaller on the wire');
  const savedToolResult = agent.session.messages.filter((m) => m.role === 'tool')[0].content ?? '';
  assert.ok(savedToolResult.length > 4000, 'the saved session keeps the real output, not the digested copy');
  assert.ok(!savedToolResult.includes('token saver'), 'the stored transcript is never rewritten by the saver');
  assert.ok(savedToolResult.length > (toolMessage!.content ?? '').length, 'what is stored is bigger than what is sent');

  const event = host.events.find((e) => e.type === 'token_saver') as
    | { stats: { savedTokens: number; savedPercent: number; notes: string[] } }
    | undefined;
  assert.ok(event, 'the panel must be told how much was saved');
  assert.ok(event!.stats.savedTokens > 1000, JSON.stringify(event!.stats));
  assert.ok(event!.stats.savedPercent > 30, JSON.stringify(event!.stats));
  assert.ok(event!.stats.notes.length > 0);
});

(async () => {
  let failed = 0;
  for (const t of TESTS) {
    try {
      await t.fn();
      console.log(`  ✓ ${t.name}`);
    } catch (err) {
      failed += 1;
      console.error(`  ✗ ${t.name}`);
      console.error(`    ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    }
  }
  console.log(`\n${TESTS.length - failed}/${TESTS.length} token saver tests passed`);
  if (failed) {
    process.exit(1);
  }
})();
