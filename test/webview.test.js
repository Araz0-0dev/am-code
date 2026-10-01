/**
 * Renders the real chat panel (HTML + CSS + JS produced by the extension) inside jsdom and
 * drives the UI the way a user would: the welcome screen, the in-panel "connect a model" form,
 * the Review/Autonomy cards, the composer, @-mentions, the todo panel and the permission card.
 */
const assert = require('assert');
const Module = require('module');
const path = require('path');
const { JSDOM } = require('jsdom');
const { createHost } = require('./vscode-mock');

const TESTS = [];
const test = (name, fn) => TESTS.push({ name, fn });

const ROOT = path.resolve(__dirname, '..');
let host;

function installVscodeMock() {
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, ...rest) {
    if (request === 'vscode') return '__vscode_mock__';
    return originalResolve.call(this, request, parent, ...rest);
  };
  require.cache.__vscode_mock__ = { id: '__vscode_mock__', filename: '__vscode_mock__', loaded: true, exports: host.vscode };
}

const MODEL = {
  id: 'test-model',
  name: 'Test Model',
  provider: 'openai',
  baseUrl: 'http://127.0.0.1:9/v1',
  modelId: 'test-model-id',
  contextWindow: 32000,
  supportsTools: true
};

/** openPanel(config, secrets) — `configuration.state` is merged into the state the host posts. */
async function openPanel(configuration = {}, secrets = {}) {
  host = createHost({ root: path.resolve('/tmp/agentcode-fixture'), diagnostics: [] });
  installVscodeMock();
  delete require.cache[path.join(ROOT, 'dist', 'extension.js')];
  for (const [key, value] of Object.entries(configuration)) {
    if (key !== 'state') host.setConfig(key, value);
  }
  for (const [key, value] of Object.entries(secrets)) host.state.secrets.set(key, value);

  const bundle = require(path.join(ROOT, 'dist', 'extension.js'));
  bundle.activate(host.context);
  await new Promise((resolve) => setImmediate(resolve));

  const posted = [];
  const webview = {
    options: {},
    html: '',
    asWebviewUri: (uri) => ({ toString: () => `vscode-webview://test${uri.path}`, fsPath: uri.fsPath, path: uri.path }),
    onDidReceiveMessage(cb) { this._cb = cb; return { dispose: () => {} }; },
    postMessage(message) { posted.push(message); if (this._onPost) this._onPost(message); return Promise.resolve(true); }
  };
  host.state.views[0].provider.resolveWebviewView({
    webview,
    visible: true,
    onDidChangeVisibility: () => ({ dispose: () => {} }),
    onDidDispose: () => ({ dispose: () => {} })
  });

  if (configuration.state) {
    const original = webview.postMessage.bind(webview);
    webview.postMessage = (message) => {
      if (message && message.type === 'state') {
        Object.assign(message.state, configuration.state);
      }
      return original(message);
    };
  }

  const dom = new JSDOM(webview.html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.acquireVsCodeApi = () => ({
        postMessage: (message) => {
          posted.push(message);
          setImmediate(() => { webview._cb(message); });
        },
        getState: () => ({}),
        setState: () => {}
      });
    }
  });
  const { window } = dom;
  webview._onPost = (message) => window.dispatchEvent(new window.MessageEvent('message', { data: message }));
  if (!window.requestAnimationFrame) window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  const send = async (message) => {
    await webview._cb(message);
    window.dispatchEvent(new window.MessageEvent('message', { data: message }));
  };
  await tick(80);
  const onHostMessage = (message) => window.dispatchEvent(new window.MessageEvent('message', { data: message }));
  return { webview, window, document: window.document, send, posted, onHostMessage };
}

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

/** The most recent state the host pushed (tests tweak one field and send it back). */
function lastState(panel, patch = {}) {
  const states = panel.posted.filter((m) => m.type === 'state');
  const base = states.length ? states[states.length - 1].state : {};
  return JSON.parse(JSON.stringify(base));
}

// --------------------------------------------------------------------------- tests

test('welcome screen renders the AM Code hero, both work cards and the model form', async () => {
  const panel = await openPanel();
  const { document } = panel;
  assert.ok(document.querySelector('.hero h1').textContent.includes('AM Code'), 'hero title');
  assert.strictEqual(document.querySelectorAll('.workCard').length, 2, 'two autonomy cards');
  assert.ok(document.querySelector('.workCard.selected .wcTitle').textContent.includes('Review first'));
  assert.ok(document.querySelector('#modelForm'), 'the model form must be visible when no model is configured');
  assert.ok(document.querySelector('#mfBase') && document.querySelector('#mfModel') && document.querySelector('#mfKey'));
  assert.ok(document.querySelector('.tips'), 'shortcut hints');

  // the panel asks the extension for state on load
  await tick(10);
  assert.ok(panel.posted.some((m) => m.type === 'ready'), 'the webview must send "ready"');
  assert.ok(panel.posted.every((m) => typeof m.type === 'string'));
});

test('the in-panel model form saves the model through the extension', async () => {
  const panel = await openPanel();
  const { document } = panel;
  document.querySelector('#mfName').value = 'My GPT';
  document.querySelector('#mfBase').value = 'http://127.0.0.1:9/v1';
  document.querySelector('#mfModel').value = 'gpt-4o-mini';
  document.querySelector('#mfKey').value = 'sk-123';
  document.querySelector('#mfContext').value = '64000';

  const form = document.querySelector('#modelForm');
  form.dispatchEvent(new panel.window.Event('submit', { bubbles: true, cancelable: true }));
  await tick(300);

  const saved = host.state.configuration['models'];
  assert.ok(Array.isArray(saved) && saved.length === 1, 'the model must be persisted');
  assert.strictEqual(saved[0].name, 'My GPT');
  assert.strictEqual(saved[0].modelId, 'gpt-4o-mini');
  assert.strictEqual(saved[0].contextWindow, 64000);
  assert.strictEqual(host.state.secrets.get(`agentcode.apiKey.${saved[0].id}`), 'sk-123');
  assert.strictEqual(host.state.configuration['activeModel'], saved[0].id);

  // the panel switches to the ready state: the form is replaced and the model is selectable
  assert.ok(!document.querySelector('#modelForm'), 'the form is replaced once a model exists');
  assert.ok(document.querySelector('#model').textContent.includes('My GPT'), document.querySelector('#model').innerHTML);
  const feedback = panel.posted.filter((m) => m.type === 'modelSaved').pop();
  assert.ok(feedback, 'the panel is told the outcome of the connection test');
});

test('the autonomy cards and the composer chips post the right settings', async () => {
  const panel = await openPanel();
  const { document } = panel;
  document.querySelector('.workCard[data-work="autonomy"]').click();
  await tick(40);
  assert.strictEqual(host.state.configuration['workMode'], 'autonomy');
  assert.strictEqual(host.state.configuration['autoApproveWrite'], true);
  assert.strictEqual(host.state.configuration['autoApproveCommands'], true);
  assert.strictEqual(host.state.configuration['showReasoning'], false);

  document.querySelector('.workCard[data-work="review"]').click();
  await tick(40);
  assert.strictEqual(host.state.configuration['workMode'], 'review');
  assert.strictEqual(host.state.configuration['autoApproveWrite'], false);

  // composer chips open menus that post mode/autonomy changes
  document.querySelector('#btnMode').click();
  const menu = document.querySelector('.menu.popup');
  assert.ok(menu && menu.textContent.includes('Plan') && menu.textContent.includes('Build'), 'mode menu');
  menu.querySelector('[data-pick="plan"]').click();
  await tick(40);
  assert.ok(panel.posted.some((m) => m.type === 'setMode' && m.mode === 'plan'));
});

test('sending a message needs a model, typing / shows the command palette, @ lists files', async () => {
  // no model configured -> the composer refuses and points at the form
  const empty = await openPanel();
  empty.document.querySelector('#input').value = 'hello there';
  empty.document.querySelector('#btnSend').click();
  await tick(20);
  assert.ok(!empty.posted.some((m) => m.type === 'send'), 'must not send without a model');
  assert.ok(empty.document.querySelector('.toast'), 'shows a toast instead');

  // with a model: send works, slash + mention menus show up
  const panel = await openPanel({ models: [MODEL], activeModel: 'test-model' });
  const { document } = panel;
  assert.ok(!document.querySelector('#modelForm'), 'form hidden once a model exists');
  assert.strictEqual(document.querySelector('#model').value, 'test-model');

  const input = document.querySelector('#input');
  input.value = '/';
  input.dispatchEvent(new panel.window.Event('input', { bubbles: true }));
  await tick(10);
  const slash = document.querySelector('#slashMenu');
  assert.ok(!slash.hidden && slash.textContent.includes('/plan'), 'slash menu lists commands');
  slash.querySelector('[data-cmd="/plan"]').click();
  await tick(20);
  assert.ok(panel.posted.some((m) => m.type === 'setMode' && m.mode === 'plan'));

  input.value = 'look at @src/';
  input.dispatchEvent(new panel.window.Event('input', { bubbles: true }));
  await tick(150);
  assert.ok(panel.posted.some((m) => m.type === 'mentionFiles' && m.query === 'src/'), 'asks the host for files');
  await panel.send({ type: 'mentionResults', query: 'src/', files: ['src/app.ts', 'src/index.ts'] });
  await tick(10);
  const mention = document.querySelector('#mentionMenu');
  assert.ok(!mention.hidden && mention.textContent.includes('src/app.ts'), 'mention menu shows files');

  input.value = 'do the thing';
  input.dispatchEvent(new panel.window.Event('input', { bubbles: true }));
  document.querySelector('#btnSend').click();
  await tick(240);
  const sent = panel.posted.find((m) => m.type === 'send');
  assert.ok(sent && sent.text === 'do the thing', 'the prompt is sent');
});

test('the Stop button only shows while the agent is running (idle never shows both buttons)', async () => {
  const panel = await openPanel({ models: [MODEL], activeModel: 'test-model' });
  const { document, window } = panel;
  const send = document.querySelector('#btnSend');
  const stop = document.querySelector('#btnStop');

  // the CSS must make the `hidden` attribute win over the component display rules
  assert.ok(/\[hidden\](,|\s*\{)/.test(panel.webview.html), 'the panel CSS must neutralise [hidden]');
  assert.ok(panel.webview.html.includes('.hidden { display: none !important; }') || panel.webview.html.includes('.hidden{display:none!important}'),
    'the panel CSS must define .hidden');

  const visible = (node) => window.getComputedStyle(node).display !== 'none';
  assert.strictEqual(stop.hidden, true, 'Stop starts hidden');
  assert.strictEqual(visible(stop), false, 'Stop must not be rendered while idle');
  assert.strictEqual(visible(send), true, 'Send is visible while idle');

  await panel.send({ type: 'busy', busy: true, status: 'step 2/40 · thinking', steps: 2, maxSteps: 40 });
  await tick(20);
  assert.strictEqual(visible(stop), true, 'Stop appears while running');
  assert.strictEqual(visible(send), false, 'Send is replaced by Stop while running');
  assert.ok(document.querySelector('#steps').textContent.includes('2/40'), 'the step chip follows the live status');

  await panel.send({ type: 'busy', busy: false, status: 'ready' });
  await tick(20);
  assert.strictEqual(visible(stop), false, 'Stop disappears when the turn ends');
  assert.strictEqual(visible(send), true, 'Send comes back when the turn ends');
  assert.ok(document.querySelector('#statusLine').textContent.includes('ready'));
});

test('renders the task checklist with ticks, tool rows and the completion card', async () => {
  const panel = await openPanel({ models: [MODEL], activeModel: 'test-model' });
  const { document } = panel;
  await panel.send({
    type: 'state',
    state: {
      models: [{ id: 'test-model', name: 'Test Model', modelId: 'test-model-id', provider: 'openai', baseUrl: 'x', hasKey: true, supportsTools: true }],
      activeModelId: 'test-model',
      mode: 'build',
      busy: true,
      status: 'step 2/40 · thinking',
      title: 'demo',
      usage: { inputTokens: 1200, outputTokens: 340 },
      steps: 2,
      maxSteps: 40,
      contextTokens: 9000,
      contextWindow: 32000,
      todos: [
        { id: '1', content: 'Create the route', status: 'completed', note: 'src/routes.ts' },
        { id: '2', content: 'Add a test', status: 'in_progress' },
        { id: '3', content: 'Update docs', status: 'pending' }
      ],
      items: [],
      autoApprove: { read: true, write: false, commands: false },
      workMode: 'review',
      showReasoning: true,
      workspaceName: 'demo',
      hasWorkspace: true,
      iconUri: 'vscode-webview://test/icon.png',
      version: '0.1.0'
    }
  });
  await tick(20);
  const items = document.querySelectorAll('.todoItem');
  assert.strictEqual(items.length, 3);
  assert.ok(items[0].className.includes('done'), 'completed item is ticked');
  assert.ok(items[1].className.includes('active'), 'in-progress item is highlighted');
  assert.ok(document.querySelector('.todoHead .count').textContent.includes('1/3'));
  assert.ok(document.querySelector('#usage').textContent.includes('1.5k'), document.querySelector('#usage').textContent);
  assert.ok(document.querySelector('#statusLine').textContent.includes('thinking'));

  // task rows + streaming assistant text
  await panel.send({ type: 'upsert', item: { kind: 'tool', id: 'c1', name: 'edit_file', args: {}, running: true, ts: 1 } });
  await panel.send({ type: 'upsert', item: { kind: 'tool', id: 'c1', name: 'edit_file', args: {}, running: false, ok: true, summary: 'edited src/routes.ts (+4/−2 lines)', ts: 1 } });
  await panel.send({ type: 'upsert', item: { kind: 'assistant', id: 'a1', text: 'Working on it', done: false, ts: 2 } });
  await panel.send({ type: 'delta', id: 'a1', channel: 'text', text: ' — done soon.' });
  await panel.send({ type: 'upsert', item: { kind: 'completion', id: 'z1', text: '**Done.** Changed `src/routes.ts`.', ts: 3 } });
  await tick(20);
  const toolRow = document.querySelector('.toolRow');
  assert.ok(toolRow && toolRow.className.includes('ok'), 'tool row shows success');
  assert.ok(toolRow.textContent.includes('edit_file') && toolRow.textContent.includes('src/routes.ts'));
  assert.ok(document.querySelector('.assistant .md').textContent.includes('done soon'), 'streamed text is appended');
  const completion = document.querySelector('.completion');
  assert.ok(completion && completion.textContent.includes('Task completed'));
  assert.ok(completion.querySelector('code.inline'), 'markdown code renders inside the summary');
});

test('permission cards approve / reject and the plan card sends feedback', async () => {
  const panel = await openPanel({ models: [MODEL], activeModel: 'test-model' });
  const { document } = panel;
  await panel.send({
    type: 'upsert',
    item: {
      kind: 'permission',
      id: 'p1',
      request: {
        id: 'p1',
        toolName: 'edit_file',
        kind: 'write',
        title: 'Edit src/app.ts',
        detail: '',
        preview: { path: 'src/app.ts', before: 'const a = 1;', after: 'const a = 2;', isNew: false }
      },
      ts: 1
    }
  });
  await tick(15);
  const card = document.querySelector('.card');
  assert.ok(card.textContent.includes('Edit src/app.ts'));
  assert.ok(card.querySelector('.diff .del').textContent.includes('const a = 1;'), 'removed line shown');
  assert.ok(card.querySelector('.diff .ins').textContent.includes('const a = 2;'), 'added line shown');
  card.querySelector('[data-act="approve"]').click();
  await tick(15);
  assert.ok(panel.posted.some((m) => m.type === 'permissionResponse' && m.allowed === true && m.id === 'p1'));

  await panel.send({
    type: 'upsert',
    item: {
      kind: 'plan',
      id: 'pl1',
      plan: { summary: 'Add a login endpoint', steps: [{ title: 'Add route', files: ['src/routes.ts'] }] },
      ts: 2
    }
  });
  await tick(15);
  const planCard = document.querySelectorAll('.card')[1];
  assert.ok(planCard.textContent.includes('Add a login endpoint'));
  planCard.querySelector('.feedbackBox').value = 'use a different file';
  planCard.querySelector('[data-act="rejectPlan"]').click();
  await tick(15);
  const response = panel.posted.find((m) => m.type === 'planResponse');
  assert.strictEqual(response.approved, false);
  assert.strictEqual(response.feedback, 'use a different file');
});

test('the Models page adds, edits, tests, keys and removes models in one screen', async () => {
  const panel = await openPanel({ models: [MODEL], activeModel: 'test-model' },
    { [`agentcode.apiKey.${MODEL.id}`]: 'sk-existing' });
  const { document, posted } = panel;

  // the "+" button opens the full-panel models screen
  document.querySelector('#btnAddModel').click();
  await tick(40);
  const page = document.querySelector('#modelsPage');
  assert.ok(page && !page.hidden, 'the models screen opens');
  assert.ok(page.textContent.includes('Test Model'), 'existing models are listed');
  assert.ok(page.textContent.includes('active'), 'the active model is marked');
  assert.ok(page.textContent.includes('@AM0_0dev'), 'the author credit is shown');
  assert.ok(page.querySelector('#mfForm'), 'the add/edit form lives in the same screen');

  // edit an existing model (no one-question-at-a-time wizards)
  page.querySelector('[data-mact="edit"]').click();
  await tick(30);
  assert.ok(document.querySelector('#mfName').value === 'Test Model', 'the form is prefilled for editing');
  document.querySelector('#mfName').value = 'Renamed Model';
  document.querySelector('#mfContext').value = '64000';
  document.querySelector('#mfForm').dispatchEvent(new panel.window.Event('submit', { bubbles: true, cancelable: true }));
  await tick(120);
  const saved = host.state.configuration['models'][0];
  assert.strictEqual(saved.name, 'Renamed Model', 'the edit is persisted');
  assert.strictEqual(saved.contextWindow, 64000);
  assert.strictEqual(host.state.configuration['models'].length, 1, 'editing must not create a duplicate');

  // set a key + test connection + remove all go through the host
  await panel.send({ type: 'modelKeySaved', message: 'API key saved.' });
  await panel.send({ type: 'modelSaved', ok: true, message: 'Ready · OK in 12 ms' });
  await tick(20);
  assert.ok(document.querySelector('#mfStatus').textContent.includes('Ready'), 'the status line reports the test result');

  // key + remove use inline rows (VS Code webviews and Electron have no window.prompt/confirm)
  document.querySelector('#modelsPage [data-mact="key"]').click();
  const keyField = document.querySelector('#keyInput');
  assert.ok(keyField, 'an inline key field appears instead of a prompt');
  keyField.value = 'sk-inline';
  document.querySelector('[data-mact="keySave"]').click();
  await tick(20);
  const keyMsg = posted.filter((m) => m.type === 'setModelKey').pop();
  assert.strictEqual(keyMsg.apiKey, 'sk-inline');
  assert.strictEqual(keyMsg.id, MODEL.id);

  document.querySelector('#modelsPage [data-mact="remove"]').click();
  assert.ok(document.querySelector('[data-mact="removeYes"]'), 'removing asks for an inline confirmation');
  document.querySelector('[data-mact="removeYes"]').click();
  await tick(20);
  assert.ok(posted.some((m) => m.type === 'removeModel' && m.id === MODEL.id), 'the removal is posted');

  await panel.send({ type: 'modelsShow' });
  await tick(20);
  assert.ok(panel.posted.some((m) => m.type === 'openSettings') === false);
  const closeBtn = document.querySelector('#btnCloseModels');
  assert.ok(closeBtn, 'the screen can be closed');
  closeBtn.click();
  await tick(20);
  assert.strictEqual(document.querySelector('#modelsPage').hidden, true, 'closing hides the screen');

  // the gear menu routes to the same screen
  document.querySelector('#btnSettings').click();
  await tick(20);
  const menu = document.querySelector('.menu.popup');
  assert.ok(menu && menu.textContent.includes('Models'), 'the settings menu offers Models');
  menu.querySelector('[data-pick="models"]').click();
  await tick(30);
  assert.strictEqual(document.querySelector('#modelsPage').hidden, false, 'the menu re-opens the models screen');
});

test('opening a popup menu does not break the / and @ composer menus', async () => {
  const panel = await openPanel({ models: [MODEL], activeModel: 'test-model' });
  const { document } = panel;
  document.querySelector('#btnSettings').click();
  await tick(20);
  assert.ok(document.querySelector('.menu.popup'), 'a popup opened');
  assert.ok(document.querySelector('#slashMenu'), 'the slash menu node survives');
  assert.ok(document.querySelector('#mentionMenu'), 'the mention menu node survives');

  const input = document.querySelector('#input');
  input.value = '/';
  input.dispatchEvent(new panel.window.Event('input', { bubbles: true }));
  await tick(20);
  assert.ok(!document.querySelector('#slashMenu').hidden, 'slash commands still work after a popup');
  assert.ok(document.querySelector('#slashMenu').textContent.includes('/compact'));

  input.value = 'look at @pack';
  input.dispatchEvent(new panel.window.Event('input', { bubbles: true }));
  await tick(150);
  await panel.send({ type: 'mentionResults', query: 'pack', files: ['package.json'] });
  await tick(20);
  assert.ok(!document.querySelector('#mentionMenu').hidden, 'mentions still work after a popup');
});

test('the logo and the author credit are part of the panel chrome', async () => {
  const panel = await openPanel({ models: [MODEL], activeModel: 'test-model' });
  const { document } = panel;
  const logo = document.querySelector('#brandIcon');
  assert.ok(logo, 'the brand logo is rendered');
  assert.ok(String(logo.getAttribute('src')).length > 50, 'the logo source is inlined by the host');
  assert.ok(document.querySelector('#brandVer').textContent.includes('0.1'), 'the version is shown');
  document.querySelector('#btnAddModel').click();
  await tick(30);
  assert.ok(document.querySelector('#modelsPage .credit').textContent.includes('@AM0_0dev'), 'credit in the models screen footer');
});

test('the MCP screen adds, tests, toggles and removes servers in one place', async () => {
  const panel = await openPanel({ models: [MODEL] });
  const { document, posted } = panel;

  // the + menu routes to the MCP tab, and the settings gear too
  document.querySelector('#btnAttach').click();
  const menu = document.querySelector('.menu.popup');
  assert.ok(menu, 'the + button opens the add menu');
  menu.querySelector('[data-pick="mcp"]').click();
  const page = document.querySelector('#modelsPage');
  assert.strictEqual(page.hidden, false, 'the settings overlay opens on the MCP tab');
  assert.ok(page.querySelector('[data-ovtab="mcp"].active'), 'the MCP tab is selected');
  assert.ok(page.querySelector('#msForm'), 'the MCP form lives in the same screen');
  assert.ok(page.querySelector('#msPreset'), 'presets are offered');
  assert.ok(page.querySelector('#msTransport') && page.querySelector('#msName') && page.querySelector('#msSecret'));

  // transport switch hides the stdio fields
  const transport = page.querySelector('#msTransport');
  transport.value = 'http';
  transport.dispatchEvent(new panel.window.Event('change', { bubbles: true }));
  assert.strictEqual(page.querySelector('#msCommand').closest('.field').hidden, true, 'command field hidden for http');
  assert.strictEqual(page.querySelector('#msUrl').closest('.field').hidden, false, 'url field shown for http');
  transport.value = 'stdio';
  transport.dispatchEvent(new panel.window.Event('change', { bubbles: true }));

  // a preset fills the form
  const preset = page.querySelector('#msPreset');
  preset.value = '0';
  preset.dispatchEvent(new panel.window.Event('change', { bubbles: true }));
  assert.ok(page.querySelector('#msCommand').value === 'npx', 'preset filled the command');
  assert.ok(page.querySelector('#msArgs').value.includes('server-filesystem'), 'preset filled the arguments');

  // saving posts the payload
  page.querySelector('#msName').value = 'My Tools';
  page.querySelector('#msArgs').value = '-y my-mcp --port 9';
  page.querySelector('#msFilter').value = 'read_*';
  page.querySelector('#msAuto').checked = true;
  page.querySelector('#msForm').dispatchEvent(new panel.window.Event('submit', { bubbles: true, cancelable: true }));
  await tick(40);
  const saved = posted.filter((m) => m.type === 'saveMcpServer').pop();
  assert.ok(saved, 'saveMcpServer was posted');
  assert.strictEqual(saved.payload.name, 'My Tools');
  assert.strictEqual(saved.payload.argsText, '-y my-mcp --port 9');
  assert.strictEqual(saved.payload.toolFilterText, 'read_*');
  assert.strictEqual(saved.payload.autoApproveTools, true);

  // the saved server renders with its tools and per-row actions
  await panel.send({
    type: 'state',
    state: Object.assign({}, lastState(panel), {
      mcp: [
        {
          id: 'my-tools',
          name: 'My Tools',
          transport: 'stdio',
          enabled: true,
          state: 'ready',
          target: 'npx -y my-mcp --port 9',
          toolCount: 2,
          tools: ['read_file', 'search'],
          serverName: 'am-code-test-server',
          serverVersion: '1.2.3'
        }
      ],
      mcpWithSecret: ['my-tools']
    })
  });
  const row = document.querySelector('#modelsPage [data-mcp="my-tools"]');
  assert.ok(row, 'the server row is rendered');
  assert.ok(row.textContent.includes('ready'), 'state badge');
  assert.ok(row.textContent.includes('2 tools'));
  assert.ok(row.querySelector('.mcpTools').textContent.includes('read_file'));
  assert.ok(row.querySelector('[data-smact="toggle"]'));
  assert.ok(row.querySelector('[data-smact="test"]'));
  assert.ok(row.querySelector('[data-smact="remove"]'));

  row.querySelector('[data-smact="toggle"]').click();
  await tick(20);
  const toggled = posted.filter((m) => m.type === 'toggleMcp').pop();
  assert.strictEqual(toggled.id, 'my-tools');
  assert.strictEqual(toggled.enabled, false);

  // the host pushes state again (toggle round-trip) and the edit form must prefill from the config
  await panel.send({
    type: 'state',
    state: Object.assign({}, lastState(panel), {
      mcp: [
        {
          id: 'my-tools',
          name: 'My Tools',
          transport: 'stdio',
          enabled: false,
          state: 'disabled',
          target: 'npx -y my-mcp --port 9',
          toolCount: 0,
          tools: []
        }
      ],
      mcpServers: [
        {
          id: 'my-tools',
          name: 'My Tools',
          transport: 'stdio',
          command: 'npx',
          argsText: '-y my-mcp --port 9',
          envText: 'TOKEN=',
          toolFilterText: 'read_*',
          autoApproveTools: true,
          enabled: false,
          hasSecret: true
        }
      ],
      mcpWithSecret: ['my-tools']
    })
  });
  document.querySelector('#modelsPage [data-smact="edit"]').click();
  assert.strictEqual(document.querySelector('#msName').value, 'My Tools', 'the form is prefilled for editing');
  assert.strictEqual(document.querySelector('#msCommand').value, 'npx', 'the command is prefilled');
  assert.strictEqual(document.querySelector('#msArgs').value, '-y my-mcp --port 9');
  assert.strictEqual(document.querySelector('#msFilter').value, 'read_*');
  assert.ok(document.querySelector('#msAuto').checked, 'auto-approve is prefilled');
  assert.ok(document.querySelector('#msForm').textContent.includes('Edit MCP server'));

  document.querySelector('#modelsPage [data-smact="test"]').click();
  await tick(20);
  assert.ok(posted.some((m) => m.type === 'testMcp' && m.id === 'my-tools'), 'test posts the server id');
});

test('session tabs, status line and the full-window layout are driven by state', async () => {
  const panel = await openPanel({ models: [MODEL] });
  const { document, posted } = panel;

  await panel.send({
    type: 'state',
    state: Object.assign({}, lastState(panel), {
      layout: 'ultra',
      sessions: [
        { id: 's1', title: 'Fix the parser', active: true, mode: 'build', updatedAt: 2 },
        { id: 's2', title: 'Old session', active: false, mode: 'plan', updatedAt: 1 }
      ],
      git: { available: true, branch: 'main', dirty: true },
      workspaceName: 'my-repo',
      mcp: [{ id: 'x', name: 'X', transport: 'stdio', enabled: true, state: 'ready', target: 'npx x', toolCount: 3, tools: [] }]
    })
  });

  assert.strictEqual(document.body.dataset.layout, 'ultra', 'the ultra layout is applied');
  const tabs = document.querySelectorAll('#tabbar .tab');
  assert.strictEqual(tabs.length, 2, 'both sessions are shown as tabs');
  assert.ok(document.querySelector('#tabbar .tab.active').textContent.includes('Fix the parser'));
  assert.ok(document.querySelector('#btnTabNew'), 'the + tab button exists');

  document.querySelectorAll('#tabbar .tab')[1].click();
  await tick(20);
  const opened = posted.filter((m) => m.type === 'openSession').pop();
  assert.strictEqual(opened.id, 's2');

  const status = document.querySelector('#statusRow').textContent;
  assert.ok(status.includes('my-repo'), status);
  assert.ok(status.includes('main'), status);
  assert.ok(status.includes('MCP'), status);
  assert.ok(status.includes('3 tools'), status);

  // switching layout from the Interface screen posts setLayout
  document.querySelector('#btnSettings').click();
  document.querySelector('.menu.popup [data-pick="interface"]').click();
  const card = document.querySelector('#modelsPage [data-layout="panel"]');
  assert.ok(card, 'layout cards are rendered');
  card.click();
  await tick(20);
  const layoutMsg = posted.filter((m) => m.type === 'setLayout').pop();
  assert.strictEqual(layoutMsg.layout, 'panel');
  assert.ok(document.querySelector('#modelsPage').textContent.includes('AM Code'), 'about section');
  assert.ok(document.querySelector('#modelsPage .credit').textContent.includes('@AM0_0dev'));
});

test('the Tokens screen shows the saver state, live numbers and posts changes', async () => {
  const panel = await openPanel({ models: [MODEL], tokenSaver: 'balanced' });
  const { document, posted } = panel;

  document.querySelector('#btnSettings').click();
  document.querySelector('.menu.popup [data-pick="interface"]').click();
  const tokensTab = document.querySelector('#modelsPage [data-ovtab="tokens"]');
  assert.ok(tokensTab, 'the Tokens tab exists');
  tokensTab.click();
  await tick(40);

  const page = document.querySelector('#modelsPage');
  assert.ok(page.textContent.includes('Token saver'));
  assert.strictEqual(page.querySelectorAll('[data-tsmode]').length, 3, 'off / balanced / aggressive');
  assert.ok(page.querySelector('[data-tsmode="balanced"]').classList.contains('selected'));
  assert.ok(page.querySelector('#tsDedupe') && page.querySelector('#tsImages'), 'the toggles are there');
  assert.ok(page.querySelector('#tsPreview'), 'sessions can be analysed on demand');

  // switching mode posts the setting
  page.querySelector('[data-tsmode="aggressive"]').click();
  await tick(20);
  const modeMsg = posted.filter((m) => m.type === 'setTokenSaver' && m.mode).pop();
  assert.strictEqual(modeMsg.mode, 'aggressive');

  // saving the fine-grained options posts each key
  page.querySelector('#tsKeep').value = '9';
  page.querySelector('#tsMax').value = '900';
  page.querySelector('#tsSave').click();
  await tick(20);
  const keys = posted.filter((m) => m.type === 'setTokenSaver' && m.key).map((m) => m.key);
  assert.ok(keys.includes('tokenSaverKeepRecent'), JSON.stringify(keys));
  assert.ok(keys.includes('tokenSaverMaxToolChars'));
  assert.ok(keys.includes('tokenSaverDedupe'));

  // live numbers land in the screen and in the status line
  await panel.send({
    type: 'tokenStats',
    stats: { mode: 'balanced', beforeTokens: 42000, afterTokens: 18000, savedTokens: 24000, savedPercent: 57, messagesTouched: 9, notes: ['7 large tool results digested (head + tail kept)'] }
  });
  const live = document.querySelector('#modelsPage').textContent;
  assert.ok(live.includes('24.0k'), live.slice(0, 200));
  assert.ok(live.includes('57%'), 'the percentage is shown');
  assert.ok(document.querySelector('#statusRow').textContent.includes('saved 24.0k'), 'the status line gained a saver chip');

  // analysing the session asks the host
  document.querySelector('#tsPreview').click();
  await tick(20);
  assert.ok(posted.some((m) => m.type === 'previewCompression'));

  // with the saver off, the chip disappears
  await panel.send({ type: 'state', state: Object.assign({}, lastState(panel), { tokenSaver: { mode: 'off', keepRecent: 6, maxToolResultChars: 1400, dedupeToolResults: true, dropOldImages: true } }) });
  assert.ok(!document.querySelector('#statusRow [data-act="tokens"]'), 'no saver chip when it is off');
});

test('the first run opens the in-app model screen (never an OS dialog)', async () => {
  const panel = await openPanel({ models: [], needsModel: true });
  const { document, posted } = panel;
  await tick(60);
  const page = document.querySelector('#modelsPage');
  assert.ok(!page.hidden, 'the settings overlay opens itself');
  assert.ok(page.textContent.includes('Add'), page.textContent.slice(0, 80));
  assert.ok(page.querySelector('#mfName'), 'the add-model form is on screen');
  assert.ok(document.querySelector('#toasts').textContent.includes('Welcome'), 'a welcome toast explains what to do');
});

test('host prompts are answered inside the panel (input and pick)', async () => {
  const panel = await openPanel({ models: [MODEL] });
  const { document, posted } = panel;

  panel.onHostMessage({ type: 'inlinePrompt', prompt: { id: 7, kind: 'input', title: 'AM Code — API key', prompt: 'Paste the key', password: true } });
  await tick(20);
  const host = document.querySelector('#promptHost');
  assert.ok(!host.hidden, 'the prompt card is visible');
  assert.ok(host.textContent.includes('Paste the key'));
  const input = document.querySelector('#promptInput');
  assert.ok(input, 'there is a text field');
  assert.strictEqual(input.type, 'password');
  input.value = 'sk-test-123';
  document.querySelector('#promptOk').click();
  await tick(20);
  const answered = posted.filter((m) => m.type === 'inlinePromptResult').pop();
  assert.strictEqual(answered.id, 7);
  assert.strictEqual(answered.value, 'sk-test-123');
  assert.ok(host.hidden, 'the card closes after the answer');

  panel.onHostMessage({ type: 'inlinePrompt', prompt: { id: 8, kind: 'pick', title: 'Tool calling?', items: [{ label: 'Yes — native' }, { label: 'No — text protocol' }] } });
  await tick(20);
  const items = document.querySelectorAll('#promptHost .promptItem');
  assert.strictEqual(items.length, 2);
  items[1].click();
  await tick(20);
  const pick = posted.filter((m) => m.type === 'inlinePromptResult').pop();
  assert.strictEqual(pick.id, 8);
  assert.strictEqual(pick.value, 'No — text protocol');
  assert.ok(document.querySelector('#promptHost').hidden);
});

test('game engine MCP presets are offered (Godot, Unity, Unreal)', async () => {
  const panel = await openPanel({ models: [MODEL] });
  const { document, window: page } = panel;
  document.querySelector('#btnSettings').click();
  document.querySelector('.menu.popup [data-pick="interface"]').click();
  document.querySelector('#modelsPage [data-ovtab="mcp"]').click();
  await tick(40);
  const select = document.querySelector('#msPreset');
  assert.ok(select, 'the preset picker exists');
  const labels = [...select.options].map((option) => option.textContent).join('|');
  assert.ok(labels.includes('Godot'), labels);
  assert.ok(labels.includes('Unity'), labels);
  assert.ok(labels.includes('Unreal'), labels);

  const godotOption = [...select.options].find((option) => option.textContent.includes('Godot'));
  select.value = godotOption.value;
  select.dispatchEvent(new page.Event('change', { bubbles: true }));
  await tick(30);
  const command = document.querySelector('#msCommand');
  const args = document.querySelector('#msArgs');
  assert.ok(command && command.value.length > 0, 'the Godot preset fills the command in');
  assert.ok(args.value.includes('godot-mcp-server'), args ? args.value : '');
  assert.ok(document.querySelector('#msEnv').value.includes('GODOT_PATH'), 'env vars come with the preset');
});

test('the General screen edits agent settings from inside the panel' , async () => {
  const panel = await openPanel({ models: [MODEL], maxSteps: 40, autoApproveWrite: false, customInstructions: '' });
  const { document, posted } = panel;

  document.querySelector('#btnSettings').click();
  document.querySelector('.menu.popup [data-pick="interface"]').click();
  document.querySelector('#modelsPage [data-ovtab="general"]').click();
  await tick(40);

  const page = document.querySelector('#modelsPage');
  assert.ok(page.textContent.includes('Agent behaviour'), page.textContent.slice(0, 120));
  assert.ok(page.querySelector('#set_maxSteps'), 'the step limit is editable');
  assert.strictEqual(page.querySelector('#set_maxSteps').value, '40');
  assert.ok(page.querySelector('[data-set="autoApproveWrite"]'), 'permission toggles are there');
  assert.strictEqual(page.querySelector('[data-set="autoApproveWrite"]').checked, false);
  assert.ok(page.querySelector('#set_customInstructions'), 'custom instructions are editable');

  page.querySelector('[data-set="autoApproveWrite"]').checked = true;
  page.querySelector('#set_maxSteps').value = '12';
  page.querySelector('#set_customInstructions').value = 'Always run typecheck.';
  page.querySelector('#setSave').click();
  await tick(30);

  const postedSettings = posted.filter((m) => m.type === 'setSetting');
  assert.ok(postedSettings.length >= 3, JSON.stringify(postedSettings.map((m) => m.key)));
  const write = postedSettings.find((m) => m.key === 'autoApproveWrite');
  const steps = postedSettings.find((m) => m.key === 'maxSteps');
  const instructions = postedSettings.find((m) => m.key === 'customInstructions');
  assert.strictEqual(write.value, true);
  assert.strictEqual(steps.value, 12);
  assert.strictEqual(instructions.value, 'Always run typecheck.');
  assert.ok(document.querySelector('#setStatus').textContent.includes('saved'));
});

test('the welcome hero uses the AM Code wordmark when the host provides it' , async () => {
  const panel = await openPanel({ models: [MODEL] });
  await panel.send({
    type: 'state',
    state: Object.assign({}, lastState(panel), {
      wordmark: '<svg class="wordmarkSvg" viewBox="0 0 10 10"><rect x="1" y="1" width="8" height="8"/></svg>'
    })
  });
  const mark = panel.document.querySelector('.heroMark svg');
  assert.ok(mark, 'the wordmark SVG is rendered in the hero');
  assert.ok(panel.document.querySelector('.hero h1.srOnly'), 'the text title stays for screen readers');
  assert.ok(panel.document.querySelector('.workChips .workChip'), 'compact work chips exist for the wide layout');
});

// --------------------------------------------------------------------------- runner

(async () => {
  let failed = 0;
  for (const { name, fn } of TESTS) {
    host = createHost({ root: path.resolve('/tmp/agentcode-fixture'), diagnostics: [] });
    installVscodeMock();
    delete require.cache[path.join(ROOT, 'dist', 'extension.js')];
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`  ✗ ${name}`);
      console.error(`    ${err && err.stack ? err.stack.split('\n').slice(0, 5).join('\n    ') : String(err)}`);
    }
  }
  console.log(`\n${TESTS.length - failed}/${TESTS.length} webview tests passed`);
  process.exit(failed ? 1 : 0);
})();
