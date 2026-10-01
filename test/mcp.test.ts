/* MCP client tests: real stdio server process + real HTTP server. Run with: npm test */
import * as assert from 'assert';
import * as http from 'http';
import * as path from 'path';
import { AddressInfo } from 'net';
import { Agent, AgentHost, AgentRunOptions, HostContext } from '../src/core/agent';
import { McpManager } from '../src/core/mcpClient';
import { matchesToolFilter, mcpResultToText, mcpToolName, parseMcpToolName } from '../src/core/mcp';
import { setProviderFactory } from '../src/core/providers';
import { AgentSession } from '../src/core/session';
import type {
  AgentEvent,
  ChatRequest,
  McpServerConfig,
  ModelConfig,
  PermissionDecision,
  PermissionRequest,
  Plan,
  PlanDecision,
  Provider,
  ProviderStreamEvent,
  AskUserAnswer,
  AskUserRequest,
  ToolCall,
  ToolOutcome
} from '../src/core/types';

const TESTS: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  TESTS.push({ name, fn });
}

// The suite is bundled into a temp dir before it runs, so resolve the fixture against the repo root
// (npm test always runs with the package root as cwd).
const FIXTURE = path.resolve(process.cwd(), 'test', 'fixtures', 'mcp-server.js');
assert.ok(require('fs').existsSync(FIXTURE), `fixture missing: ${FIXTURE}`);

const stdioServer: McpServerConfig = {
  id: 'echo',
  name: 'Echo server',
  transport: 'stdio',
  command: process.execPath,
  args: [FIXTURE],
  enabled: true
};

function managerFor(servers: McpServerConfig[], logs: string[] = []) {
  const list = () => servers;
  return new McpManager({
    getServers: list,
    log: (serverId, level, message) => logs.push(`${level}:${serverId}:${message}`)
  });
}

// --------------------------------------------------------------------------- helpers

test('MCP tool names round-trip and can not be confused with builtin tools', () => {
  const exposed = mcpToolName('github', 'create_issue');
  assert.strictEqual(exposed, 'mcp__github__create_issue');
  assert.deepStrictEqual(parseMcpToolName(exposed), { serverId: 'github', tool: 'create_issue' });
  assert.strictEqual(parseMcpToolName('read_file'), undefined);
  assert.strictEqual(parseMcpToolName('mcp__broken'), undefined);
});

test('tool filters support wildcards', () => {
  assert.ok(matchesToolFilter('read_file', undefined));
  assert.ok(matchesToolFilter('read_file', ['read_*']));
  assert.ok(!matchesToolFilter('write_file', ['read_*']));
  assert.ok(matchesToolFilter('search', ['search', 'read_*']));
});

test('MCP results are flattened into model readable text', () => {
  const text = mcpResultToText({ content: [{ type: 'text', text: 'hello' }, { type: 'image', mimeType: 'image/png', data: 'x'.repeat(10) }] });
  assert.ok(text.includes('hello'));
  assert.ok(text.includes('image/png'));
  assert.strictEqual(mcpResultToText({ content: [] }), '(empty result)');
});

// --------------------------------------------------------------------------- stdio

test('connects to a real stdio MCP server and lists its tools', async () => {
  const logs: string[] = [];
  const mcp = managerFor([stdioServer], logs);
  try {
    const statuses = await mcp.refresh();
    assert.strictEqual(statuses.length, 1);
    assert.strictEqual(statuses[0].state, 'ready', statuses[0].error);
    assert.strictEqual(statuses[0].toolCount, 3, JSON.stringify(statuses[0]));
    assert.strictEqual(statuses[0].serverName, 'am-code-test-server');
    assert.strictEqual(statuses[0].serverVersion, '1.2.3');

    const defs = mcp.toolDefinitions();
    assert.strictEqual(defs.length, 3);
    const echo = defs.find((d) => d.name === 'mcp__echo__echo_text');
    assert.ok(echo, 'echo tool must be exposed');
    assert.strictEqual(echo!.kind, 'exec', 'a state changing MCP tool must go through the permission gate');
    assert.ok(echo!.description.includes('Echo server'), 'description must name the server');
    const readOnly = defs.find((d) => d.name === 'mcp__echo__read_only_info');
    assert.strictEqual(readOnly!.kind, 'read', 'readOnlyHint tools must be treated as read-only');
    assert.ok(logs.some((l) => l.includes('connected')), 'connection must be logged');
  } finally {
    mcp.dispose();
  }
});

test('calls MCP tools and reports failures', async () => {
  const mcp = managerFor([stdioServer]);
  try {
    await mcp.refresh();
    const ok = await mcp.callTool('mcp__echo__echo_text', { text: 'hi there' });
    assert.strictEqual(ok.ok, true);
    assert.ok(ok.content.includes('echo: hi there'), ok.content);

    const broken = await mcp.callTool('mcp__echo__always_fails', {});
    assert.strictEqual(broken.ok, false);
    assert.ok(broken.content.includes('nope'), broken.content);

    const unknown = await mcp.callTool('mcp__echo__does_not_exist', {});
    assert.strictEqual(unknown.ok, false);

    const offline = await mcp.callTool('mcp__nope__tool', {});
    assert.strictEqual(offline.ok, false);
    assert.ok(offline.content.toLowerCase().includes('not connected'));
  } finally {
    mcp.dispose();
  }
});

test('a broken server is reported instead of crashing the agent', async () => {
  const mcp = managerFor([
    { id: 'bad', name: 'Broken', transport: 'stdio', command: 'definitely-not-a-real-binary-xyz', args: [], enabled: true },
    stdioServer
  ]);
  try {
    const statuses = await mcp.refresh();
    const bad = statuses.find((s) => s.id === 'bad')!;
    assert.strictEqual(bad.state, 'error');
    assert.ok(bad.error && bad.error.length > 5, 'the failure reason must be surfaced in the UI');
    const good = statuses.find((s) => s.id === 'echo')!;
    assert.strictEqual(good.state, 'ready', 'one broken server must not stop the others');
    assert.strictEqual(mcp.toolDefinitions().length, 3);
  } finally {
    mcp.dispose();
  }
});

test('the test button reports the server name, version and tool count', async () => {
  const mcp = managerFor([stdioServer]);
  try {
    const result = await mcp.test(stdioServer);
    assert.strictEqual(result.ok, true, result.message);
    assert.ok(result.message.includes('am-code-test-server'), result.message);
    assert.deepStrictEqual(result.tools.sort(), ['always_fails', 'echo_text', 'read_only_info']);

    const failure = await mcp.test({ ...stdioServer, id: 'bad2', command: 'definitely-not-a-real-binary-xyz' });
    assert.strictEqual(failure.ok, false);
  } finally {
    mcp.dispose();
  }
});

test('disabled and filtered servers do not leak tools', async () => {
  const servers: McpServerConfig[] = [{ ...stdioServer, enabled: false }];
  const mcp = managerFor(servers);
  try {
    await mcp.refresh();
    assert.strictEqual(mcp.toolDefinitions().length, 0, 'a disabled server contributes nothing');
    assert.strictEqual(mcp.statuses()[0].state, 'disabled');

    servers[0] = { ...stdioServer, toolFilter: ['read_*'] };
    await mcp.refresh();
    const defs = mcp.toolDefinitions();
    assert.deepStrictEqual(defs.map((d) => d.name), ['mcp__echo__read_only_info']);
  } finally {
    mcp.dispose();
  }
});

// --------------------------------------------------------------------------- http

function startHttpMcpServer(): Promise<{ url: string; close: () => void; calls: string[] }> {
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const message = JSON.parse(body || '{}') as { id?: number; method?: string; params?: Record<string, unknown> };
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      calls.push(message.method ?? '');
      const send = (result: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
      };
      if (message.method === 'initialize') {
        send({ protocolVersion: '2025-06-18', serverInfo: { name: 'http-test', version: '9.9' }, capabilities: {} });
      } else if (message.method === 'tools/list') {
        send({ tools: [{ name: 'remote_echo', description: 'Echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] });
      } else if (message.method === 'tools/call') {
        send({ content: [{ type: 'text', text: `remote: ${String((message.params?.arguments as Record<string, unknown>)?.text ?? '')}` }] });
      } else {
        res.writeHead(404).end('{}');
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}/mcp`, close: () => server.close(), calls });
    });
  });
}

test('connects to a remote streamable-HTTP MCP server', async () => {
  const server = await startHttpMcpServer();
  const remote: McpServerConfig = { id: 'remote', name: 'Remote', transport: 'http', url: server.url, enabled: true };
  const mcp = managerFor([remote]);
  try {
    const statuses = await mcp.refresh();
    assert.strictEqual(statuses[0].state, 'ready', statuses[0].error);
    assert.deepStrictEqual(mcp.toolDefinitions().map((d) => d.name), ['mcp__remote__remote_echo']);
    assert.ok(server.calls.includes('initialize'));
    const outcome = await mcp.callTool('mcp__remote__remote_echo', { text: 'ping' });
    assert.ok(outcome.ok && outcome.content.includes('remote: ping'), outcome.content);
  } finally {
    mcp.dispose();
    server.close();
  }
});

// --------------------------------------------------------------------------- agent integration

class TinyHost implements AgentHost {
  readonly events: AgentEvent[] = [];
  readonly toolCalls: ToolCall[] = [];
  constructor(private readonly extraTools: () => ReturnType<McpManager['toolDefinitions']>) {}
  emit(event: AgentEvent): void {
    this.events.push(event);
  }
  async executeTool(call: ToolCall): Promise<ToolOutcome> {
    this.toolCalls.push(call);
    return { ok: true, content: 'tool-ok', summary: 'ran tool' };
  }
  async requestPermission(_request: PermissionRequest): Promise<PermissionDecision> {
    return { allowed: true };
  }
  async approvePlan(_id: string, _plan: Plan): Promise<PlanDecision> {
    return { approved: true };
  }
  async askUser(_request: AskUserRequest): Promise<AskUserAnswer> {
    return { answer: 'yes' };
  }
  async getApiKey(): Promise<string | undefined> {
    return 'key';
  }
  async collectContext(): Promise<HostContext> {
    return { rulesFiles: [], cwd: process.cwd(), workspaceName: 'test', os: process.platform, today: '2026-01-01' };
  }
  getOptions(): AgentRunOptions {
    return {
      model: { id: 'm', name: 'M', provider: 'openai', baseUrl: 'http://localhost/v1', modelId: 'm' } as ModelConfig,
      toolCallMode: 'native',
      maxSteps: 6,
      softStepBudget: 0,
      strictChecklist: false,
      alwaysPlan: false,
      enableWebTools: false,
      subagents: false,
      customInstructions: '',
      thinkingBudgetHint: 'low',
      responseLanguage: 'auto',
      includeOpenFileContext: false,
      includeDiagnostics: false
    };
  }
  onModeChanged(): void {}
  onTodosChanged(): void {}
  save(): void {}
  getExtraTools() {
    return this.extraTools();
  }
}

test('MCP tools reach the model and their calls are routed through the host', async () => {
  const mcp = managerFor([stdioServer]);
  try {
    await mcp.refresh();
    const host = new TinyHost(() => mcp.toolDefinitions());
    let seenTools: string[] = [];
    const provider: Provider = {
      id: 'openai',
      // eslint-disable-next-line require-yield
      async *streamChat(req: ChatRequest): AsyncGenerator<ProviderStreamEvent> {
        seenTools = req.tools.map((t) => t.name);
        if (seenTools.includes('mcp__echo__echo_text') && req.messages.filter((m) => m.role === 'tool').length === 0) {
          yield { type: 'tool_call', call: { id: 'c1', name: 'mcp__echo__echo_text', args: { text: 'x' } } };
          yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
          return;
        }
        yield { type: 'text', text: 'All done.' };
        yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
      }
    };
    setProviderFactory(() => provider);

    const agent = new Agent(host, new AgentSession('build'));
    await agent.send('use the echo tool');

    assert.ok(seenTools.includes('mcp__echo__echo_text'), 'the MCP tool must be offered to the model');
    assert.ok(seenTools.includes('read_file'), 'builtin tools must stay available');
    const toolEnd = host.events.find((e) => e.type === 'tool_end' && (e as { name: string }).name === 'mcp__echo__echo_text');
    assert.ok(toolEnd, 'the MCP tool call must be executed through the host');
    assert.strictEqual(host.toolCalls.length, 1);
  } finally {
    mcp.dispose();
    setProviderFactory(() => {
      throw new Error('provider factory reset');
    });
  }
});

// --------------------------------------------------------------------------- runner

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
  console.log(`\n${TESTS.length - failed}/${TESTS.length} MCP tests passed`);
  if (failed) {
    process.exit(1);
  }
})();
