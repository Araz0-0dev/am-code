/**
 * End-to-end tests against fake HTTP endpoints that speak the real wire protocols
 * (OpenAI-compatible SSE and Anthropic /v1/messages SSE). These exercise the actual
 * fetch + streaming + tool-call parsing code paths, no mocks inside the providers.
 */
import * as assert from 'assert';
import * as http from 'http';
import { AddressInfo } from 'net';
import { Agent, AgentHost, AgentRunOptions, HostContext } from '../src/core/agent';
import { AnthropicProvider } from '../src/core/providers/anthropic';
import { AgentSession } from '../src/core/session';
import type { AgentEvent, AskUserAnswer, ModelConfig, PermissionDecision, PlanDecision, ToolCall } from '../src/core/types';

const TESTS: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  TESTS.push({ name, fn });
}

function sseChunk(res: http.ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

interface FakeServer {
  url: string;
  requests: { body: any; headers: http.IncomingHttpHeaders }[];
  close: () => Promise<void>;
}

async function startServer(handler: (body: any, res: http.ServerResponse, index: number, headers: http.IncomingHttpHeaders) => void): Promise<FakeServer> {
  const requests: FakeServer['requests'] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      let body: any = {};
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        body = { raw };
      }
      requests.push({ body, headers: req.headers });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      handler(body, res, requests.length, req.headers);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      })
  };
}

class Host implements AgentHost {
  events: AgentEvent[] = [];
  files = new Map<string, string>();
  saves = 0;

  emit(event: AgentEvent): void {
    this.events.push(event);
  }

  async executeTool(call: ToolCall) {
    if (call.name === 'write_file') {
      this.files.set(String(call.args.path), String(call.args.content));
      return { ok: true, content: `Created ${call.args.path}`, summary: `created ${call.args.path}` };
    }
    if (call.name === 'read_file') {
      const path = String(call.args.path);
      const content = this.files.get(path);
      return content === undefined
        ? { ok: false, content: `File not found: ${path}`, summary: 'not found' }
        : { ok: true, content: content, summary: `read ${path}` };
    }
    return { ok: true, content: `ok:${call.name}`, summary: call.name };
  }

  async requestPermission(): Promise<PermissionDecision> {
    return { allowed: true };
  }

  async approvePlan(): Promise<PlanDecision> {
    return { approved: true };
  }

  async askUser(): Promise<AskUserAnswer> {
    return { answer: 'yes' };
  }

  async getApiKey(): Promise<string | undefined> {
    return 'sk-test';
  }

  async collectContext(): Promise<HostContext> {
    return { rulesFiles: [], cwd: '/tmp/p', workspaceName: 'p', os: 'linux', today: '2026-09-30' };
  }

  getOptions(): AgentRunOptions {
    return {
      model: MODEL,
      toolCallMode: 'native',
      maxSteps: 20,
      strictChecklist: true,
      alwaysPlan: false,
      enableWebTools: false,
      subagents: false,
      customInstructions: '',
      thinkingBudgetHint: 'medium',
      responseLanguage: 'auto',
      includeOpenFileContext: false,
      includeDiagnostics: false
    };
  }

  onModeChanged(): void {}
  onTodosChanged(): void {}
  save(): void {
    this.saves += 1;
  }
}

let MODEL: ModelConfig;

// --------------------------------------------------------------------------- tests

test('OpenAI-compatible endpoint: streams tool calls (split across chunks) and drives the loop', async () => {
  const server = await startServer((body, res, index) => {
    if (index === 1) {
      assert.strictEqual(body.model, 'fake-gpt');
      assert.ok(Array.isArray(body.tools) && body.tools.length > 5, 'tools must be sent');
      assert.ok(body.tools.some((t: any) => t.function.name === 'update_todos'));
      assert.strictEqual(body.stream, true);
      assert.ok(body.messages.some((m: any) => m.role === 'system'));
      res.write(
        `data: ${JSON.stringify({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'update_todos', arguments: '{"todos":[{"id":"1","content":"Create' }
                  }
                ]
              }
            }
          ]
        })}\n\n`
      );
      res.write(
        `data: ${JSON.stringify({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: ' hello.js","status":"in_progress"}]}' } }
                ]
              }
            }
          ]
        })}\n\n`
      );
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ usage: { prompt_tokens: 120, completion_tokens: 30 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    if (index === 2) {
      // the model writes the file with a plain function call in one piece
      const toolResult = body.messages.find((m: any) => m.role === 'tool' && m.tool_call_id === 'call_1');
      assert.ok(toolResult, 'the tool result for call_1 must be in the transcript');
      assert.ok(String(toolResult.content).includes('Checklist updated'), String(toolResult.content));
      sseChunk(res, {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_2',
                  type: 'function',
                  function: { name: 'write_file', arguments: JSON.stringify({ path: 'hello.js', content: 'console.log(1)\n' }) }
                }
              ]
            }
          }
        ]
      });
      sseChunk(res, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    if (index === 3) {
      sseChunk(res, {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'call_3', type: 'function', function: { name: 'attempt_completion', arguments: '{"result":"all done"}' } }
              ]
            }
          }
        ]
      });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    if (index === 4) {
      sseChunk(res, {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_4',
                  type: 'function',
                  function: {
                    name: 'update_todos',
                    arguments: JSON.stringify({ todos: [{ id: '1', content: 'Create hello.js', status: 'completed', note: 'written' }] })
                  }
                }
              ]
            }
          }
        ]
      });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    sseChunk(res, {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, id: 'call_5', type: 'function', function: { name: 'attempt_completion', arguments: '{"result":"hello.js created"}' } }]
          }
        }
      ]
    });
    sseChunk(res, { choices: [{ index: 0, delta: { content: '' }, finish_reason: 'tool_calls' }] });
    res.write('data: [DONE]\n\n');
    res.end();
  });

  MODEL = { id: 'fake', name: 'Fake GPT', provider: 'openai', baseUrl: server.url, modelId: 'fake-gpt', contextWindow: 64000 };
  const host = new Host();
  const session = new AgentSession('build');
  const agent = new Agent(host, session);
  await agent.send('create hello.js');

  try {
    assert.strictEqual(host.files.get('hello.js'), 'console.log(1)\n');
    assert.strictEqual(server.requests.length, 5, 'the agent must have made 5 model calls');
    const completions = host.events.filter((e) => e.type === 'tool_end' && e.name === 'attempt_completion') as Extract<
      AgentEvent,
      { type: 'tool_end' }
    >[];
    assert.strictEqual(completions.length, 2);
    assert.strictEqual(completions[0].ok, false, 'first completion must be blocked by the checklist gate');
    assert.strictEqual(completions[1].ok, true);
    assert.strictEqual(session.usage.inputTokens, 120, 'usage from the stream must be recorded');
    assert.strictEqual(session.usage.outputTokens, 30);
    const auth = server.requests[0].headers['authorization'];
    assert.strictEqual(auth, 'Bearer sk-test', 'API key must be sent as a bearer token');
  } finally {
    await server.close();
  }
});

test('OpenAI-compatible endpoint: plain text stream (no tools) becomes the answer', async () => {
  const server = await startServer((_body, res) => {
    sseChunk(res, { choices: [{ index: 0, delta: { content: 'Hello ' } }] });
    sseChunk(res, { choices: [{ index: 0, delta: { content: 'world' } }] });
    sseChunk(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    res.write('data: [DONE]\n\n');
    res.end();
  });
  MODEL = { id: 'fake2', name: 'Fake', provider: 'openai', baseUrl: server.url, modelId: 'm' };
  const host = new Host();
  const session = new AgentSession('build');
  const agent = new Agent(host, session);
  await agent.send('say hi');
  try {
    const turnEnd = host.events.find((e) => e.type === 'turn_end') as Extract<AgentEvent, { type: 'turn_end' }>;
    assert.strictEqual(turnEnd.reason, 'completed');
    assert.strictEqual(turnEnd.text, 'Hello world');
    const assistant = session.messages.find((m) => m.role === 'assistant');
    assert.strictEqual(assistant?.content, 'Hello world');
  } finally {
    await server.close();
  }
});

test('Anthropic provider parses message_start / tool_use / input_json_delta / message_delta', async () => {
  const evt = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
  let seenHeaders: http.IncomingHttpHeaders = {};
  const server = await startServer((body, res, _index, headers) => {
    seenHeaders = headers;
    assert.strictEqual(Number(body.max_tokens) > 0, true);
    assert.ok(typeof body.system === 'string' && body.system.length > 0, 'system prompt must be hoisted');
    assert.ok(Array.isArray(body.tools));
    res.write(evt({ type: 'message_start', message: { usage: { input_tokens: 42, output_tokens: 1 } } }));
    res.write(evt({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file' } }));
    res.write(evt({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"src/' } }));
    res.write(evt({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'a.ts"}' } }));
    res.write(evt({ type: 'content_block_stop', index: 0 }));
    res.write(evt({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 17 } }));
    res.write(evt({ type: 'message_stop' }));
    res.end();
  });

  const model: ModelConfig = { id: 'claude', name: 'Claude', provider: 'anthropic', baseUrl: server.url, modelId: 'claude-x', maxTokens: 1000 };
  const provider = new AnthropicProvider();
  const calls: ToolCall[] = [];
  let usage = { inputTokens: 0, outputTokens: 0 };
  for await (const event of provider.streamChat({
    model,
    system: 'You are a test.',
    messages: [{ role: 'user', content: 'read the file' }],
    tools: [
      {
        name: 'read_file',
        description: 'read',
        kind: 'read',
        schema: { type: 'object', properties: { path: { type: 'string', description: 'p' } }, required: ['path'] }
      }
    ],
    apiKey: 'sk-ant',
    maxTokens: 1000
  })) {
    if (event.type === 'tool_call' && event.call) {
      calls.push(event.call);
    }
    if (event.type === 'done' && event.usage) {
      usage = event.usage;
    }
  }
  try {
    assert.strictEqual(seenHeaders['x-api-key'], 'sk-ant');
    assert.strictEqual(seenHeaders['anthropic-version'], '2023-06-01');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].name, 'read_file');
    assert.strictEqual(calls[0].args.path, 'src/a.ts');
    assert.deepStrictEqual(usage, { inputTokens: 42, outputTokens: 17 });
  } finally {
    await server.close();
  }
});

test('a broken endpoint produces a helpful error instead of hanging', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'unknown model' } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  MODEL = { id: 'bad', name: 'Bad', provider: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, modelId: 'nope' };
  const host = new Host();
  const session = new AgentSession('build');
  const agent = new Agent(host, session);
  await agent.send('hi');
  await new Promise((resolve) => server.close(resolve));
  const error = host.events.find((e) => e.type === 'error') as Extract<AgentEvent, { type: 'error' }> | undefined;
  assert.ok(error, 'an error event is expected');
  assert.ok(/404/.test(error!.message), error!.message);
  assert.ok(/Base URL|Model ID/.test(error!.message), 'the error should hint at the configuration');
  const turnEnd = host.events.find((e) => e.type === 'turn_end') as Extract<AgentEvent, { type: 'turn_end' }>;
  assert.strictEqual(turnEnd.reason, 'error');
});

// --------------------------------------------------------------------------- runner

(async () => {
  let failed = 0;
  for (const { name, fn } of TESTS) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`  ✗ ${name}`);
      console.error(`    ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    }
  }
  console.log(`\n${TESTS.length - failed}/${TESTS.length} provider tests passed`);
  process.exit(failed ? 1 : 0);
})();
