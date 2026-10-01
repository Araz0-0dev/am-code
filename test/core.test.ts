/* Smoke tests for the vscode-free agent engine. Run with: npm test */
import * as assert from 'assert';
import { Agent, AgentHost, AgentRunOptions, HostContext } from '../src/core/agent';
import { estimateTokens, trimHistory } from '../src/core/context';
import { setProviderFactory } from '../src/core/providers';
import { AgentSession } from '../src/core/session';
import { parseTextToolCalls } from '../src/core/textTools';
import { TodoList } from '../src/core/todos';
import { buildToolDefinitions } from '../src/core/tools';
import type {
  AgentEvent,
  AskUserAnswer,
  ChatMessage,
  ModelConfig,
  PermissionDecision,
  PermissionRequest,
  Plan,
  PlanDecision,
  Provider,
  ProviderStreamEvent,
  ToolCall,
  ToolDefinition
} from '../src/core/types';

const TESTS: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  TESTS.push({ name, fn });
}

const MODEL: ModelConfig = {
  id: 'fake',
  name: 'Fake',
  provider: 'openai',
  baseUrl: 'http://localhost:0/v1',
  modelId: 'fake-model',
  contextWindow: 128000
};

// --------------------------------------------------------------------- fakes

class ScriptedProvider implements Provider {
  id = 'openai' as const;
  calls = 0;
  constructor(private readonly script: ((call: number, messages: ChatMessage[]) => ProviderStreamEvent[])) {}

  async *streamChat(req: { messages: ChatMessage[] }): AsyncGenerator<ProviderStreamEvent> {
    this.calls += 1;
    const events = this.script(this.calls, req.messages as ChatMessage[]);
    for (const event of events) {
      yield event;
    }
  }
}

function textCall(name: string, args: Record<string, unknown>): ProviderStreamEvent[] {
  return [
    { type: 'text', text: '```tool\n' + JSON.stringify({ name, args }) + '\n```' },
    { type: 'done', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } }
  ];
}

class FakeHost implements AgentHost {
  events: AgentEvent[] = [];
  executed: { name: string; args: Record<string, unknown> }[] = [];
  permissionRequests: PermissionRequest[] = [];
  planDecisions: PlanDecision[] = [];
  todosSnapshots: string[] = [];
  files = new Map<string, string>();
  autoApproveWrites = false;
  planApprove = true;
  planFeedback: string | undefined;
  saved = 0;

  constructor(private readonly options: Partial<AgentRunOptions> = {}) {}

  emit(event: AgentEvent): void {
    this.events.push(event);
    if (event.type === 'todos') {
      this.todosSnapshots.push(event.todos.map((t) => `${t.content}:${t.status}`).join(','));
    }
  }

  async executeTool(call: ToolCall): Promise<{ ok: boolean; content: string; summary: string }> {
    this.executed.push({ name: call.name, args: call.args });
    if (call.name === 'read_file') {
      const path = String(call.args.path ?? '');
      const content = this.files.get(path);
      return content === undefined
        ? { ok: false, content: `File not found: ${path}`, summary: `read ${path} failed` }
        : { ok: true, content: `File: ${path}\n\n1| ${content}`, summary: `read ${path}` };
    }
    if (call.name === 'write_file') {
      this.files.set(String(call.args.path), String(call.args.content));
      return {
        ok: true,
        content: `Created ${call.args.path}`,
        summary: `created ${call.args.path}`,
        edits: [
          {
            path: String(call.args.path),
            before: '',
            after: String(call.args.content),
            existedBefore: false,
            tool: 'write_file',
            kind: 'create',
            ts: Date.now()
          }
        ]
      };
    }
    return { ok: true, content: `ok:${call.name}`, summary: call.name };
  }

  async requestPermission(request: PermissionRequest): Promise<PermissionDecision> {
    this.permissionRequests.push(request);
    if (request.kind === 'read') {
      return { allowed: true };
    }
    if (request.kind === 'write' && this.autoApproveWrites) {
      return { allowed: true };
    }
    return this.autoApproveWrites ? { allowed: true } : { allowed: request.kind === 'write' };
  }

  async approvePlan(_id: string, plan: Plan): Promise<PlanDecision> {
    const decision = { approved: this.planApprove, feedback: this.planFeedback };
    this.planDecisions.push(decision);
    return decision;
  }

  async askUser(): Promise<AskUserAnswer> {
    return { answer: 'yes' };
  }

  async getApiKey(): Promise<string | undefined> {
    return 'test-key';
  }

  async collectContext(): Promise<HostContext> {
    return {
      rulesFiles: [{ path: 'AGENTS.md', content: 'Always run npm test.' }],
      cwd: '/tmp/project',
      workspaceName: 'project',
      os: 'linux',
      today: '2026-09-30',
      diagnosticsSummary: 'src/a.ts:3 error: boom'
    };
  }

  getOptions(): AgentRunOptions {
    return {
      model: MODEL,
      toolCallMode: 'text',
      maxSteps: 20,
      softStepBudget: 15,
      strictChecklist: true,
      alwaysPlan: true,
      enableWebTools: false,
      subagents: false,
      customInstructions: '',
      thinkingBudgetHint: 'medium',
      responseLanguage: 'auto',
      includeOpenFileContext: true,
      includeDiagnostics: true,
      ...this.options
    };
  }

  onModeChanged(): void {}
  onTodosChanged(): void {}
  save(): void {
    this.saved += 1;
  }
}

// --------------------------------------------------------------------- tests

test('TodoList parses, normalises and renders a checklist', () => {
  const list = new TodoList();
  list.set([
    { id: '1', content: 'Read the code', status: 'completed', note: '3 files' },
    { content: 'Write the handler', status: 'in-progress' },
    { content: 'Run tests', status: 'pending' }
  ]);
  const stats = list.stats();
  assert.strictEqual(stats.total, 3);
  assert.strictEqual(stats.completed, 1);
  assert.strictEqual(stats.inProgress, 1);
  assert.deepStrictEqual(list.unfinished().map((t) => t.content), ['Write the handler', 'Run tests']);
  const markdown = list.toMarkdown();
  assert.ok(markdown.includes('- [x] 1. Read the code — 3 files'), markdown);
  assert.ok(markdown.includes('- [~] t2.'), markdown);
  assert.strictEqual(list.progressLabel(), '1/3');
  assert.strictEqual(list.isComplete(), false);
});

test('parseTextToolCalls understands fenced, xml and bare JSON tool calls', () => {
  const tools: ToolDefinition[] = buildToolDefinitions({ enableWebTools: false, subagents: false });
  const fenced = parseTextToolCalls('Let me look.\n```tool\n{"name":"read_file","args":{"path":"src/a.ts"}}\n```', tools);
  assert.strictEqual(fenced.calls.length, 1);
  assert.strictEqual(fenced.calls[0].name, 'read_file');
  assert.strictEqual(fenced.calls[0].args.path, 'src/a.ts');
  assert.strictEqual(fenced.text, 'Let me look.');

  const xml = parseTextToolCalls('<tool_call>{"tool": "glob", "arguments": {"pattern": "**/*.ts"}}</tool_call>', tools);
  assert.strictEqual(xml.calls[0].name, 'glob');
  assert.strictEqual(xml.calls[0].args.pattern, '**/*.ts');

  const bare = parseTextToolCalls('{"name":"run_command","args":{"command":"npm test"}}', tools);
  assert.strictEqual(bare.calls[0].args.command, 'npm test');

  const none = parseTextToolCalls('Just prose, no tools here.', tools);
  assert.strictEqual(none.calls.length, 0);
});

test('trimHistory compresses old output and never orphans tool results', () => {
  const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];
  for (let i = 0; i < 40; i += 1) {
    messages.push({ role: 'assistant', content: '', toolCalls: [{ id: `c${i}`, name: 'read_file', args: { path: `f${i}` } }] });
    messages.push({ role: 'tool', toolCallId: `c${i}`, name: 'read_file', content: 'x'.repeat(3000) });
  }
  const before = estimateTokens('', messages);
  const { messages: trimmed, trimmed: didTrim } = trimHistory(messages, 4000, 8);
  assert.ok(didTrim, 'expected trimming to happen');
  assert.ok(estimateTokens('', trimmed) < before, 'expected fewer tokens');
  assert.notStrictEqual(trimmed[0].role, 'tool', 'history must not start with an orphan tool result');
  const answered = new Set(trimmed.filter((m) => m.role === 'tool').map((m) => m.toolCallId));
  for (const message of trimmed) {
    for (const call of message.toolCalls ?? []) {
      assert.ok(answered.has(call.id), `assistant tool call ${call.id} lost its result`);
    }
  }
});

test('build loop: checklist first, completion is blocked until every item is ticked', async () => {
  const provider = new ScriptedProvider((call) => {
    switch (call) {
      case 1:
        // The model plans the work and creates the checklist.
        return textCall('update_todos', {
          todos: [
            { id: '1', content: 'Create hello.js', status: 'in_progress' },
            { id: '2', content: 'Add a test', status: 'pending' }
          ]
        });
      case 2:
        return textCall('write_file', { path: 'hello.js', content: 'console.log("hi");\n' });
      case 3:
        // It tries to finish too early — the host must reject this.
        return textCall('attempt_completion', { result: 'Done!' });
      case 4:
        return textCall('update_todos', {
          todos: [
            { id: '1', content: 'Create hello.js', status: 'completed', note: '1 file' },
            { id: '2', content: 'Add a test', status: 'completed', note: 'npm test green' }
          ]
        });
      default:
        return textCall('attempt_completion', { result: 'Done!', files_changed: ['hello.js'], verified: 'npm test' });
    }
  });
  setProviderFactory(() => provider);

  const host = new FakeHost();
  const session = new AgentSession('build');
  const agent = new Agent(host, session);
  await agent.send('Create hello.js with a log line');

  assert.strictEqual(host.files.get('hello.js'), 'console.log("hi");\n', 'file should have been written');

  const toolEnds = host.events.filter((e) => e.type === 'tool_end') as Extract<AgentEvent, { type: 'tool_end' }>[];
  const completionAttempts = toolEnds.filter((e) => e.name === 'attempt_completion');
  assert.strictEqual(completionAttempts.length, 2, 'first completion attempt must be rejected, second accepted');
  assert.strictEqual(completionAttempts[0].ok, false);
  assert.strictEqual(completionAttempts[1].ok, true);

  const turnEnd = host.events.find((e) => e.type === 'turn_end') as Extract<AgentEvent, { type: 'turn_end' }>;
  assert.strictEqual(turnEnd.reason, 'completed');
  assert.ok(String(turnEnd.text ?? '').includes('Done!'));

  assert.strictEqual(host.todosSnapshots.length, 2, 'checklist must be updated twice');
  assert.ok(host.todosSnapshots[1].includes('Create hello.js:completed'));
  assert.strictEqual(session.todos.stats().completed, 2);
  assert.strictEqual(session.edits.length, 1);

  // a rejected attempt_completion must tell the model what is still open
  const toolMessages = session.messages.filter((m) => m.role === 'tool');
  const rejection = toolMessages.find((m) => (m.content ?? '').includes('rejected'));
  assert.ok(rejection && rejection.content.includes('Add a test'), 'rejection must list the open items');
});

test('plan mode blocks writes and hands the plan to the user for approval', async () => {
  const provider = new ScriptedProvider((call) => {
    if (call === 1) {
      return textCall('write_file', { path: 'nope.js', content: 'x' });
    }
    if (call === 2) {
      return textCall('plan', {
        summary: 'Add a login endpoint',
        steps: [
          { title: 'Add route', files: ['src/routes.ts'] },
          { title: 'Add tests', files: ['test/login.test.ts'] }
        ]
      });
    }
    if (call === 3) {
      return textCall('update_todos', { todos: [{ id: '1', content: 'Add route', status: 'in_progress' }] });
    }
    if (call === 4) {
      return textCall('write_file', { path: 'src/routes.ts', content: 'export const routes = [];\n' });
    }
    return textCall('attempt_completion', { result: 'Login endpoint added.' });
  });
  setProviderFactory(() => provider);

  const host = new FakeHost({ toolCallMode: 'text' });
  const session = new AgentSession('plan');
  const agent = new Agent(host, session);

  await agent.send('Add a login endpoint');
  // call 1: write blocked, call 2: plan approved -> build mode, call 3/4: checklist + write
  // call 5 is attempt_completion but the checklist still has an unfinished item -> rejected,
  // then the scripted provider repeats attempt_completion on call 6.
  assert.strictEqual(host.files.has('nope.js'), false, 'plan mode must not write files');
  assert.strictEqual(host.planDecisions.length >= 1, true, 'the plan must be sent for approval');
  assert.strictEqual(session.mode, 'build', 'approving the plan switches to build mode');
  assert.ok(host.files.get('src/routes.ts')?.includes('routes'), 'after approval the agent may write');
  const blocked = host.events.find((e) => e.type === 'notice' && /step limit/i.test(e.message));
  assert.ok(!blocked, 'should not hit the step limit');
  const blockedTool = host.events.find(
    (e) => e.type === 'tool_end' && e.name === 'write_file' && !e.ok
  ) as Extract<AgentEvent, { type: 'tool_end' }>;
  assert.ok(blockedTool, 'the plan-mode write must be reported as blocked');
});

test('a rejected plan keeps the agent in plan mode with the user feedback', async () => {
  const provider = new ScriptedProvider((call) => {
    if (call === 1) {
      return textCall('plan', { summary: 'first idea', steps: [{ title: 'A' }] });
    }
    if (call === 2) {
      return textCall('plan', { summary: 'second idea', steps: [{ title: 'B' }] });
    }
    return textCall('attempt_completion', { result: 'noop' });
  });
  setProviderFactory(() => provider);

  const host = new FakeHost();
  host.planApprove = false;
  host.planFeedback = 'use a different file';
  const session = new AgentSession('plan');
  const agent = new Agent(host, session);
  await agent.send('do something');

  assert.strictEqual(host.planDecisions.length, 2, 'the agent must be able to revise the plan');
  assert.strictEqual(session.mode, 'plan');
  const feedbackMessage = session.messages.find((m) => (m.content ?? '').includes('use a different file'));
  assert.ok(feedbackMessage, 'the rejection feedback must reach the model');
});

test('a conversational message is answered in ONE model call, with no tools and no checklist', async () => {
  let calls = 0;
  const provider = new ScriptedProvider(() => {
    calls += 1;
    return [
      { type: 'text', text: 'سلام! هر وقت خواستی بگو چه کاری انجام بدم.' },
      { type: 'done', stopReason: 'stop', usage: { inputTokens: 20, outputTokens: 12 } }
    ];
  });
  setProviderFactory(() => provider);

  const host = new FakeHost();
  const session = new AgentSession('build');
  const agent = new Agent(host, session);
  await agent.send('سلام');

  assert.strictEqual(calls, 1, 'a greeting must cost exactly one model call');
  assert.strictEqual(host.executed.length, 0, 'no tool may be called for small talk');
  assert.strictEqual(session.todos.length, 0, 'no checklist for small talk');
  const turnEnd = host.events.find((e) => e.type === 'turn_end') as Extract<AgentEvent, { type: 'turn_end' }>;
  assert.strictEqual(turnEnd.reason, 'completed');
  assert.ok(String(turnEnd.text ?? '').includes('سلام'));
  const statusEvents = host.events.filter((e) => e.type === 'status') as Extract<AgentEvent, { type: 'status' }>[];
  assert.strictEqual(statusEvents[statusEvents.length - 1].busy, false, 'the turn must report idle at the end');
});

test('a question about the code answers and stops (bounded reads, no endless thinking)', async () => {
  let calls = 0;
  const provider = new ScriptedProvider((n) => {
    calls += 1;
    if (n === 1) {
      return textCall('read_file', { path: 'src/a.ts' });
    }
    return [
      { type: 'text', text: 'It returns the session token.' },
      { type: 'done', stopReason: 'stop', usage: { inputTokens: 30, outputTokens: 9 } }
    ];
  });
  setProviderFactory(() => provider);
  const host = new FakeHost();
  host.files.set('src/a.ts', 'export function token() {}');
  const session = new AgentSession('build');
  const agent = new Agent(host, session);
  await agent.send('how does the token helper work?');

  assert.strictEqual(calls, 2, 'one read + one answer');
  assert.strictEqual(session.todos.length, 0, 'answering a question must not create a checklist');
  const turnEnd = host.events.find((e) => e.type === 'turn_end') as Extract<AgentEvent, { type: 'turn_end' }>;
  assert.strictEqual(turnEnd.reason, 'completed');
});

test('the read-only guard stops a runaway exploration loop early', async () => {
  let calls = 0;
  const provider = new ScriptedProvider((n) => {
    calls += 1;
    // a model that only ever reads — the classic token-burning loop
    return textCall('read_file', { path: `src/f${n}.ts` });
  });
  setProviderFactory(() => provider);

  const host = new FakeHost();
  // every read succeeds, so the model has no error to react to
  for (let i = 1; i <= 30; i += 1) {
    host.files.set(`src/f${i}.ts`, 'export const x = 1;');
  }
  const session = new AgentSession('build');
  const agent = new Agent(host, session);
  await agent.send('understand the whole project');

  assert.ok(calls <= 10, `expected the guard to stop the loop early, got ${calls} model calls`);
  const turnEnd = host.events.find((e) => e.type === 'turn_end') as Extract<AgentEvent, { type: 'turn_end' }>;
  assert.strictEqual(turnEnd.reason, 'stopped', 'the turn must end because of the read-only guard');
  const notice = host.events.find((e) => e.type === 'notice' && /read-only steps without any progress/i.test(e.message));
  assert.ok(notice, 'the user must be told why it stopped');
  const warning = host.events.find((e) => e.type === 'notice' && /telling the agent to wrap up/i.test(e.message));
  assert.ok(warning, 'the agent must get a wrap-up warning before the hard stop');
});

test('a write (or a checklist update) resets the read-only streak', async () => {
  let calls = 0;
  const provider = new ScriptedProvider((n) => {
    calls += 1;
    if (n % 3 === 1) {
      return textCall('read_file', { path: 'src/a.ts' });
    }
    if (n % 3 === 2) {
      return textCall('write_file', { path: `src/new${n}.ts`, content: 'export {};\n' });
    }
    return textCall('update_todos', { todos: [{ id: '1', content: 'Keep going', status: 'in_progress' }] });
  });
  setProviderFactory(() => provider);
  const host = new FakeHost();
  host.files.set('src/a.ts', 'export const a = 1;');
  const session = new AgentSession('build');
  const agent = new Agent(host, session);
  await agent.send('build a few files');

  const turnEnd = host.events.find((e) => e.type === 'turn_end') as Extract<AgentEvent, { type: 'turn_end' }>;
  assert.strictEqual(turnEnd.reason, 'max_steps', `the run should only stop at the step limit, got ${turnEnd.reason} after ${calls} calls`);
  assert.ok(calls > 8, 'work steps keep the loop alive past the read-only limit');
  assert.ok(host.files.size > 2, 'files were actually written');
});

test('context estimate is proportional to conversation size', () => {
  const small = estimateTokens('system', [{ role: 'user', content: 'hello' }]);
  const large = estimateTokens('system', [{ role: 'user', content: 'x'.repeat(4000) }]);
  assert.ok(large > small * 10, `${large} should be much larger than ${small}`);
});

// --------------------------------------------------------------------- runner

(async () => {
  let failed = 0;
  for (const { name, fn } of TESTS) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`  ✗ ${name}`);
      console.error(`    ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`\n${TESTS.length - failed}/${TESTS.length} tests passed`);
  process.exit(failed ? 1 : 0);
})();
