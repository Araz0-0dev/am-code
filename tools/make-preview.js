#!/usr/bin/env node
/**
 * Builds a standalone, interactive preview of the AM Code chat panel so it can be inspected in a
 * browser (or a file viewer) without installing the extension.
 *
 * It uses the *real* panel HTML/CSS/JS that the extension ships and fakes the VS Code host:
 * approvals, the checklist, mentions and the model list all behave like the real thing.
 *
 *   node tools/make-preview.js    ->  panel-preview.html   (two panes side by side)
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { createHost } = require('../test/vscode-mock');

const root = path.resolve(__dirname, '..');

// ------------------------------------------------------------------ 1. capture the real panel HTML
const host = createHost({ root: '/tmp/amcode-preview', diagnostics: [] });
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === 'vscode') return '__vscode_mock__';
  return originalResolve.call(this, request, parent, ...rest);
};
require.cache.__vscode_mock__ = { id: '__vscode_mock__', filename: '__vscode_mock__', loaded: true, exports: host.vscode };

const bundle = require(path.join(root, 'dist', 'extension.js'));
bundle.activate(host.context);

const iconFile = path.join(root, 'media', 'icon.png');
const iconData = fs.existsSync(iconFile) ? `data:image/png;base64,${fs.readFileSync(iconFile).toString('base64')}` : '';

const webview = {
  options: {},
  html: '',
  asWebviewUri: (uri) => ({ toString: () => iconData || `file://${uri.path}`, fsPath: uri.path, path: uri.path }),
  onDidReceiveMessage: () => ({ dispose: () => {} }),
  postMessage: () => Promise.resolve(true)
};
host.state.views[0].provider.resolveWebviewView({
  webview,
  visible: true,
  onDidChangeVisibility: () => ({ dispose: () => {} }),
  onDidDispose: () => ({ dispose: () => {} })
});
const panelHtml = webview.html;
if (!panelHtml || !panelHtml.includes('id="stream"')) {
  throw new Error('could not capture the panel HTML — run `node esbuild.js` first');
}

// ------------------------------------------------------------------ 2. demo content
const MODEL = {
  id: 'demo',
  name: 'GPT-4o mini',
  modelId: 'gpt-4o-mini',
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  hasKey: true,
  supportsTools: true
};

const WORKING = {
  models: [MODEL],
  activeModelId: 'demo',
  mode: 'build',
  busy: false,
  status: 'ready',
  title: 'Add a login endpoint',
  usage: { inputTokens: 18400, outputTokens: 3120 },
  steps: 6,
  maxSteps: 40,
  contextTokens: 21500,
  contextWindow: 128000,
  todos: [
    { id: '1', content: 'Read the existing auth code and route table', status: 'completed', note: '4 files' },
    { id: '2', content: 'Add POST /auth/login handler', status: 'completed', note: 'src/routes/auth.ts' },
    { id: '3', content: 'Verify passwords against the stored hash', status: 'in_progress' },
    { id: '4', content: 'Add integration tests', status: 'pending' },
    { id: '5', content: 'Update README with the new endpoint', status: 'pending' }
  ],
  items: [
    { kind: 'user', id: 'u1', text: 'Add a login endpoint with tests, please.', ts: 1 },
    { kind: 'assistant', id: 'a1', text: 'I will break this into steps first and tick them off as I go.', done: true, ts: 2 },
    {
      kind: 'tool',
      id: 'c1',
      name: 'update_todos',
      args: {},
      running: false,
      ok: true,
      summary: 'checklist 0/5 (Read the existing auth code and route table)',
      ts: 3
    },
    { kind: 'tool', id: 'c2', name: 'grep', args: {}, running: false, ok: true, summary: 'grep "router.post" — 12 matches in 5 files', ts: 4 },
    { kind: 'tool', id: 'c3', name: 'read_file', args: {}, running: false, ok: true, summary: 'read src/routes/auth.ts (86 lines)', ts: 5 },
    {
      kind: 'assistant',
      id: 'a2',
      text:
        'The router lives in `src/routes/auth.ts`, so I am adding the handler there:\n\n' +
        '```ts\nrouter.post("/auth/login", async (req, res) => {\n  const { email, password } = req.body;\n  const user = await users.findByEmail(email);\n  if (!user || !(await verify(password, user.hash))) {\n    return res.status(401).json({ error: "invalid credentials" });\n  }\n  res.json({ token: signToken(user.id) });\n});\n```\n\n' +
        'Next: password verification and the integration tests.',
      reasoning:
        'The route table already imports the users service, so I can reuse findByEmail instead of adding a new query layer. The existing meHandler shows the expected error shape.',
      done: true,
      ts: 6
    },
    {
      kind: 'permission',
      id: 'p1',
      request: {
        id: 'p1',
        toolName: 'edit_file',
        kind: 'write',
        title: 'Edit src/routes/auth.ts',
        detail: '',
        preview: {
          path: 'src/routes/auth.ts',
          before: 'router.get("/auth/me", requireAuth, meHandler);',
          after: 'router.post("/auth/login", loginHandler);\nrouter.get("/auth/me", requireAuth, meHandler);',
          isNew: false
        }
      },
      ts: 7
    },
    {
      kind: 'plan',
      id: 'pl1',
      plan: {
        summary: 'Add a login endpoint that verifies credentials and returns a JWT, plus integration tests.',
        steps: [
          { title: 'Add the login route', files: ['src/routes/auth.ts'], details: 'POST /auth/login validating the email and password, returning a signed token.' },
          { title: 'Add integration tests', files: ['test/auth.login.test.ts'] }
        ],
        openQuestions: ['Should failed logins be rate-limited now or in a follow-up?']
      },
      ts: 8
    },
    {
      kind: 'completion',
      id: 'z1',
      text: '**Done.** Login endpoint added in `src/routes/auth.ts`, 3 integration tests added — `npm test` passes (12/12).',
      ts: 9
    }
  ],
  autoApprove: { read: true, write: false, commands: false },
  workMode: 'review',
  showReasoning: true,
  workspaceName: 'demo-api',
  hasWorkspace: true,
  iconUri: iconData,
  version: '0.1.0'
};

const EMPTY = Object.assign({}, WORKING, {
  items: [],
  todos: [],
  usage: { inputTokens: 0, outputTokens: 0 },
  steps: 0,
  contextTokens: 0,
  models: [],
  activeModelId: undefined,
  title: 'New session'
});

// ------------------------------------------------------------------ 3. a tiny in-page host simulator
const SIMULATOR = `
(function () {
  var state = window.__AM_STATE;
  var FILES = ['src/routes/auth.ts','src/routes/users.ts','src/app.ts','src/db/users.ts','test/auth.me.test.ts','test/users.test.ts','package.json','README.md'];
  function send(msg) { window.dispatchEvent(new MessageEvent('message', { data: msg })); }
  function item(id) { for (var i = 0; i < state.items.length; i++) if (state.items[i].id === id) return state.items[i]; return null; }
  function patch(id, changes) {
    var it = item(id);
    if (!it) return;
    for (var k in changes) it[k] = changes[k];
    send({ type: 'upsert', item: it });
  }
  function simulate(msg) {
    switch (msg.type) {
      case 'ready': send({ type: 'state', state: state }); break;
      case 'setMode': state.mode = msg.mode; send({ type: 'state', state: state }); break;
      case 'setWorkMode':
        state.workMode = msg.mode;
        state.autoApprove = { read: true, write: msg.mode === 'autonomy', commands: msg.mode === 'autonomy' };
        state.showReasoning = msg.mode === 'review';
        send({ type: 'state', state: state });
        break;
      case 'permissionResponse': patch(msg.id, { decision: { allowed: msg.allowed, remember: msg.remember } }); break;
      case 'planResponse': patch(msg.id, { decision: { approved: msg.approved, feedback: msg.feedback } }); break;
      case 'askResponse': patch(msg.id, { answer: msg.answer }); break;
      case 'mentionFiles':
        send({ type: 'mentionResults', query: msg.query, files: FILES.filter(function (f) { return f.indexOf(msg.query) >= 0; }).slice(0, 10) });
        break;
      case 'listModelsInline':
        setTimeout(function () { send({ type: 'modelList', requestId: msg.requestId, models: ['gpt-4o-mini', 'gpt-4o', 'qwen2.5-coder:7b', 'deepseek-chat'] }); }, 400);
        break;
      case 'addModelInline':
        state.models = [{ id: 'added', name: msg.payload.name, modelId: msg.payload.modelId, provider: msg.payload.provider, baseUrl: msg.payload.baseUrl, hasKey: !!msg.payload.apiKey, supportsTools: true }];
        state.activeModelId = 'added';
        send({ type: 'modelSaved', ok: true, message: 'Saved (preview) — in VS Code this would also test the connection.' });
        send({ type: 'state', state: state });
        break;
      case 'send':
        state.items.push({ kind: 'user', id: 'u' + Date.now(), text: msg.text, ts: Date.now() });
        send({ type: 'upsert', item: state.items[state.items.length - 1] });
        send({ type: 'toast', message: 'Preview mode: no model is actually called.', level: 'info' });
        break;
      case 'stop':
        send({ type: 'busy', busy: false, status: 'ready' });
        break;
      case 'newSession':
      case 'clearSession':
        state.items = [];
        state.todos = [];
        send({ type: 'reset' });
        send({ type: 'state', state: state });
        break;
      default:
        console.log('[preview] panel posted:', msg);
    }
  }
  window.acquireVsCodeApi = function () {
    return {
      postMessage: function (msg) { setTimeout(function () { simulate(msg); }, 130); },
      getState: function () { return {}; },
      setState: function () {}
    };
  };
})();
`;

// ------------------------------------------------------------------ 4. assemble the preview page
const SCRIPT_OPEN = '<' + 'script>';
const SCRIPT_CLOSE = '<' + '/script>';
const paneHtml = (state) =>
  panelHtml.replace('<head>', `<head>${SCRIPT_OPEN}window.__AM_STATE=${JSON.stringify(state)};${SCRIPT_CLOSE}${SCRIPT_OPEN}${SIMULATOR}${SCRIPT_CLOSE}`);

const escapeForInline = (html) => JSON.stringify(html).replace(/<\//g, '<\\/');

const page = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AM Code — panel preview</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; padding: 20px; background: radial-gradient(1200px 600px at 50% -10%, #1b2433, #0d1016 60%);
    font-family: -apple-system, "Segoe UI", system-ui, sans-serif; color: #d7dce4;
  }
  h1 { font-size: 17px; margin: 0 0 4px; font-weight: 700; }
  p.lead { margin: 0 0 18px; color: #8b93a1; font-size: 12.5px; }
  .row { display: flex; gap: 18px; justify-content: center; align-items: flex-start; flex-wrap: wrap; }
  .col { display: flex; flex-direction: column; gap: 8px; }
  .label { font-size: 10.5px; letter-spacing: .7px; text-transform: uppercase; color: #8b93a1; font-weight: 700; padding-left: 2px; }
  iframe {
    width: 386px; height: 800px; border: 1px solid #2a3341; border-radius: 12px; background: #1f1f1f;
    box-shadow: 0 24px 70px rgba(0,0,0,.6);
  }
  .hint { margin-top: 16px; color: #8b93a1; font-size: 12px; text-align: center; }
  .hint kbd { background: #1b212c; border: 1px solid #2a3341; border-radius: 5px; padding: 1px 6px; font-size: 11px; }
</style>
</head>
<body>
  <h1>AM Code — chat panel preview</h1>
  <p class="lead">The real panel HTML/CSS/JS from the extension, with a simulated VS Code host. Approvals, checklists, mentions and menus are all clickable.</p>
  <div class="row">
    <div class="col"><div class="label">Working session</div><iframe id="pane-working" title="Working session"></iframe></div>
    <div class="col"><div class="label">First run (no model)</div><iframe id="pane-empty" title="First run"></iframe></div>
  </div>
  <div class="hint">Tip: type <kbd>@</kbd> for files, <kbd>/</kbd> for commands, or click the <kbd>Build</kbd> / <kbd>Auto</kbd> chips.</div>
  <script>
    var PANE_WORKING = ${escapeForInline(paneHtml(WORKING))};
    var PANE_EMPTY = ${escapeForInline(paneHtml(EMPTY))};
    document.getElementById('pane-working').srcdoc = PANE_WORKING;
    document.getElementById('pane-empty').srcdoc = PANE_EMPTY;
  </script>
</body>
</html>
`;

const outPath = path.join(root, 'panel-preview.html');
fs.writeFileSync(outPath, page, 'utf8');
console.log(`wrote ${path.relative(root, outPath)} (${(page.length / 1024).toFixed(1)} KB)`);
