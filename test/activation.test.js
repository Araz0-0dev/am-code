/**
 * Loads the *bundled* extension (dist/extension.js) against a mocked `vscode` module and
 * drives a full user flow:
 *   1. activation must not throw and must register every contributed command
 *   2. adding a model through the wizard must persist models + API key
 *   3. sending a prompt must start the agent, hit the (fake) model endpoint and render
 *      the checklist + tool calls into the webview
 */
const assert = require('assert');
const http = require('http');
const Module = require('module');
const path = require('path');
const { createHost } = require('./vscode-mock');

const TESTS = [];
const test = (name, fn) => TESTS.push({ name, fn });

const ROOT = path.resolve(__dirname, '..');
let host;

// --------------------------------------------------------------------------- mock wiring

function installVscodeMock() {
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, ...rest) {
    if (request === 'vscode') {
      return '__vscode_mock__';
    }
    return originalResolve.call(this, request, parent, ...rest);
  };
  require.cache.__vscode_mock__ = { id: '__vscode_mock__', filename: '__vscode_mock__', loaded: true, exports: host.vscode };
}

function makeWebview() {
  return {
    options: {},
    html: '',
    messages: [],
    asWebviewUri(uri) {
      return { toString: () => `vscode-webview://test/${uri.path}`, fsPath: uri.fsPath, path: uri.path };
    },
    onDidReceiveMessage(cb) {
      this._cb = cb;
      return { dispose: () => {} };
    },
    postMessage(message) {
      this.messages.push(message);
      return Promise.resolve(true);
    }
  };
}

async function startModelServer() {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      send({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'update_todos', arguments: JSON.stringify({ todos: [{ id: '1', content: 'Say hello', status: 'in_progress' }] }) }
                }
              ]
            }
          }
        ]
      });
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/v1` };
}

async function startChatOnlyServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      requests.push(raw);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'سلام! هر وقت خواستی بگو چه کاری انجام بدم.' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/v1`, requests };
}

// --------------------------------------------------------------------------- tests

async function bootstrap(configuration = {}, secrets = {}) {
  for (const [key, value] of Object.entries(configuration)) {
    host.setConfig(key, value);
  }
  for (const [key, value] of Object.entries(secrets)) {
    host.state.secrets.set(key, value);
  }
  const bundle = require(path.join(ROOT, 'dist', 'extension.js'));
  assert.doesNotThrow(() => bundle.activate(host.context));
  await new Promise((resolve) => setImmediate(resolve));
  return bundle;
}

function resolveView() {
  const webview = makeWebview();
  host.state.views[0].provider.resolveWebviewView({
    webview,
    visible: true,
    onDidChangeVisibility: () => ({ dispose: () => {} }),
    onDidDispose: () => ({ dispose: () => {} })
  });
  return webview;
}

test('extension activates, registers every command and shows the status bar', async () => {
  await bootstrap();

  const expected = [
    'agentcode.openChat',
    'agentcode.newSession',
    'agentcode.addModel',
    'agentcode.editModel',
    'agentcode.removeModel',
    'agentcode.setApiKey',
    'agentcode.selectModel',
    'agentcode.testModel',
    'agentcode.toggleMode',
    'agentcode.undoLastChange',
    'agentcode.showDiff',
    'agentcode.initProject',
    'agentcode.addSelectionToChat',
    'agentcode.explainSelection',
    'agentcode.fixSelection',
    'agentcode.compactSession',
    'agentcode.exportSession',
    'agentcode.showStatus',
    'agentcode.switchSession'
  ];
  for (const id of expected) {
    assert.ok(host.state.commands.has(id), `command ${id} must be registered`);
  }
  assert.ok(host.state.views.length === 1, 'the chat webview must be registered');
  assert.strictEqual(host.state.views[0].id, 'agentcode.chat');
  assert.ok(host.state.statusBars.length === 1 && host.state.statusBars[0].visible, 'status bar item visible');
  assert.ok(host.state.statusBars[0].text.includes('AM Code'), host.state.statusBars[0].text);
  assert.ok(host.state.log.output.some((line) => line.includes('activated')), 'output channel should log activation');
});

test('the model wizard persists a model (Base URL + Model ID) and its API key', async () => {
  await bootstrap();
  const inputs = ['Local Qwen', 'http://127.0.0.1:9/v1', 'qwen2.5-coder:7b', 'sk-local'];
  const picks = [
    { label: 'OpenAI-compatible', value: 'openai' },
    undefined, // "type a model id manually" -> the mock returns the first item
    { label: 'Yes — native tool calling (recommended)', value: true },
    { label: 'No', value: false }
  ];
  let inputStep = 0;
  let pickStep = 0;
  host.vscode.window.showInputBox = async () => inputs[inputStep++];
  host.vscode.window.showQuickPick = async (items) => {
    const scripted = picks[pickStep++];
    return scripted === undefined ? items[0] : scripted;
  };

  await host.state.commands.get('agentcode.addModel')();

  const models = host.state.configuration['models'];
  assert.ok(Array.isArray(models) && models.length === 1, 'one model must be saved');
  assert.strictEqual(models[0].name, 'Local Qwen');
  assert.strictEqual(models[0].modelId, 'qwen2.5-coder:7b');
  assert.strictEqual(models[0].baseUrl, 'http://127.0.0.1:9/v1');
  assert.strictEqual(models[0].provider, 'openai');
  assert.strictEqual(models[0].supportsTools, true);
  assert.strictEqual(host.state.configuration['activeModel'], models[0].id);
  assert.strictEqual(host.state.secrets.get(`agentcode.apiKey.${models[0].id}`), 'sk-local');
});

test('sending a prompt runs the agent loop and renders checklist + tool rows in the webview', async () => {
  const { server, url } = await startModelServer();
  const model = {
    id: 'test-model',
    name: 'Test Model',
    provider: 'openai',
    baseUrl: url,
    modelId: 'test-model-id',
    maxTokens: 256,
    contextWindow: 32000
  };
  await bootstrap({ models: [model], activeModel: 'test-model' }, { 'agentcode.apiKey.test-model': 'sk-test' });

  const webview = resolveView();
  assert.ok(webview.html.includes('AM Code') && webview.html.includes('Content-Security-Policy'), 'the webview HTML must be built');
  assert.ok(/script-src 'nonce-/.test(webview.html), 'CSP must allow our nonce');

  await webview._cb({ type: 'ready' });
  const initial = webview.messages.find((m) => m.type === 'state');
  assert.ok(initial && initial.state.models.length === 1, 'the initial state must list the model');
  assert.strictEqual(initial.state.hasWorkspace, true);
  assert.strictEqual(initial.state.mode, 'build');

  await webview._cb({ type: 'send', text: 'say hello' });
  for (let i = 0; i < 60; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const done = webview.messages.some((m) => m.type === 'busy' && m.busy === false);
    if (done) {
      break;
    }
  }

  const kinds = webview.messages.map((m) => (m.type === 'upsert' ? m.item.kind : m.type));
  assert.ok(kinds.includes('user'), 'the user message must be echoed');
  assert.ok(kinds.includes('assistant'), 'an assistant message must be streamed');
  assert.ok(kinds.includes('tool'), 'the tool call row must be rendered');

  const toolItem = webview.messages.map((m) => (m.type === 'upsert' ? m.item : null)).filter((i) => i && i.kind === 'tool').pop();
  assert.strictEqual(toolItem.name, 'update_todos');
  assert.strictEqual(toolItem.ok, true);

  const saved = host.context.globalState.get('agentcode.sessions.v1', []);
  assert.ok(saved.length >= 1, 'the session must be saved');
  assert.strictEqual(saved[0].todos.length, 1);
  assert.strictEqual(saved[0].todos[0].content, 'Say hello');
  assert.strictEqual(saved[0].todos[0].status, 'in_progress');

  await webview._cb({ type: 'stop' });
  await webview._cb({ type: 'setMode', mode: 'plan' });
  assert.strictEqual(host.state.statusBars[0].text.includes('PLAN'), true, `status bar: ${host.state.statusBars[0].text}`);
  await webview._cb({ type: 'clearSession' });
  await webview._cb({ type: 'newSession' });
  await server.close();
});

test('webview messages that need a model/workspace fail soft (no crash)', async () => {
  await bootstrap();
  const webview = resolveView();
  for (const message of [
    { type: 'compact' },
    { type: 'undo' },
    { type: 'selectModel', id: 'does-not-exist' },
    { type: 'showDiff', path: 'nope.ts', content: '' },
    { type: 'openFile', path: 'missing.ts' },
    { type: 'permissionResponse', id: 'unknown', allowed: true },
    { type: 'planResponse', id: 'unknown', approved: true },
    { type: 'askResponse', id: 'unknown', answer: 'x' },
    { type: 'unknown-type' }
  ]) {
    await webview._cb(message);
  }
  assert.ok(true, 'no exception escaped');
});

test('a plain question costs exactly one model call and the turn ends cleanly', async () => {
  const { server, url, requests } = await startChatOnlyServer();
  const model = {
    id: 'chat-model',
    name: 'Chat Model',
    provider: 'openai',
    baseUrl: url,
    modelId: 'chat-model-id',
    maxTokens: 128,
    contextWindow: 32000
  };
  await bootstrap({ models: [model], activeModel: 'chat-model' }, { 'agentcode.apiKey.chat-model': 'sk-test' });

  const webview = resolveView();
  await webview._cb({ type: 'ready' });
  await webview._cb({ type: 'send', text: 'سلام، آماده‌ای؟' });

  for (let i = 0; i < 60; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (webview.messages.some((m) => m.type === 'busy' && m.busy === false)) break;
  }
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.strictEqual(requests.length, 1, `a greeting must hit the model once, got ${requests.length}`);
  const busySeq = webview.messages.filter((m) => m.type === 'busy').map((m) => m.busy);
  assert.strictEqual(busySeq[busySeq.length - 1], false, 'the panel must be told the turn ended (Stop button hides)');
  const toolRows = webview.messages.filter((m) => m.type === 'upsert' && m.item.kind === 'tool');
  assert.strictEqual(toolRows.length, 0, 'no tool rows for small talk');
  const assistant = webview.messages.filter((m) => m.type === 'upsert' && m.item.kind === 'assistant').pop();
  assert.ok(assistant && assistant.item.done === true, 'the assistant message must be closed');
  await server.close();
});

// --------------------------------------------------------------------------- runner

(async () => {
  let failed = 0;
  for (const { name, fn } of TESTS) {
    const fresh = createHost({
      root: path.resolve('/tmp/agentcode-fixture'),
      diagnostics: []
    });
    host = fresh;
    installVscodeMock();
    delete require.cache[path.join(ROOT, 'dist', 'extension.js')];
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`  ✗ ${name}`);
      console.error(`    ${err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n    ') : String(err)}`);
    }
  }
  console.log(`\n${TESTS.length - failed}/${TESTS.length} activation tests passed`);
  process.exit(failed ? 1 : 0);
})();
