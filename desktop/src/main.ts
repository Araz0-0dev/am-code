/**
 * AM Code — desktop app (Windows / Linux / macOS).
 *
 * The window shows the very same panel as the VS Code extension; the difference is this process
 * provides the host: settings on disk, secrets via Electron safeStorage, files, commands, MCP
 * servers and the tool runner.
 */

import { BrowserWindow, Menu, MenuItemConstructorOptions, app, dialog, nativeTheme, shell } from 'electron';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { activate, deactivate } from '@amcode/extension';
import { SecretStorageLike, createVscodeShim, globToRegExp } from './vscode-shim';

const PRODUCT = 'AM Code';

// Windows needs a stable AppUserModelId, otherwise the window is grouped under "Electron" and the
// taskbar entry (and its icon) can be missing entirely.
if (process.platform === 'win32') {
  app.setAppUserModelId('dev.amcode.desktop');
}

process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error('AM Code unhandled rejection:', reason);
});

// ---------------------------------------------------------------------------- single instance

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// ---------------------------------------------------------------------------- paths & state

function userDir(): string {
  const dir = process.env.AMCODE_USER_DIR || app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const settingsPath = () => path.join(userDir(), 'settings.json');
const secretsPath = () => path.join(userDir(), 'secrets.json');
const logPath = () => path.join(userDir(), 'am-code.log');
const boundsPath = () => path.join(userDir(), 'window.json');

function log(line: string): void {
  const stamped = `[${new Date().toISOString()}] ${line}\n`;
  try {
    fs.appendFileSync(logPath(), stamped, 'utf8');
  } catch {
    /* ignore */
  }
  process.stdout.write(stamped);
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown): void {
  try {
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  } catch (err) {
    log(`failed to write ${file}: ${String(err)}`);
  }
}

/** Secrets are encrypted with the OS keychain through safeStorage when it is available. */
function createSecretStorage(): SecretStorageLike {
  const raw = readJson<Record<string, string>>(secretsPath(), {});
  const cache = new Map<string, string>(Object.entries(raw));
  const persist = () => writeJson(secretsPath(), Object.fromEntries(cache));
  const enc = (value: string): string => {
    try {
      return require('electron').safeStorage.isEncryptionAvailable()
        ? `enc:${require('electron').safeStorage.encryptString(value).toString('base64')}`
        : `plain:${Buffer.from(value, 'utf8').toString('base64')}`;
    } catch {
      return `plain:${Buffer.from(value, 'utf8').toString('base64')}`;
    }
  };
  const dec = (stored: string): string => {
    try {
      if (stored.startsWith('enc:')) {
        return require('electron').safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
      }
      return Buffer.from(stored.replace(/^plain:/, ''), 'base64').toString('utf8');
    } catch (err) {
      log(`failed to decrypt a secret: ${String(err)}`);
      return '';
    }
  };
  return {
    async get(key) {
      const value = cache.get(key);
      return value ? dec(value) : undefined;
    },
    async store(key, value) {
      cache.set(key, enc(value));
      persist();
    },
    async delete(key) {
      cache.delete(key);
      persist();
    }
  };
}

// ---------------------------------------------------------------------------- workspace folder

function pickWorkspaceFolder(): string | undefined {
  const fromEnv = process.env.AMCODE_WORKSPACE;
  if (fromEnv && fs.existsSync(fromEnv) && fs.statSync(fromEnv).isDirectory()) {
    return path.resolve(fromEnv);
  }
  const settings = readJson<Record<string, unknown>>(settingsPath(), {});
  const configured = typeof settings.__workspace === 'string' ? (settings.__workspace as string) : undefined;
  if (configured && fs.existsSync(configured)) {
    return configured;
  }
  const cli = process.argv
    .slice(1)
    .filter((arg) => !arg.startsWith('-') && arg !== '.' && !arg.endsWith('.js'))
    .find((arg) => fs.existsSync(arg) && fs.statSync(arg).isDirectory());
  if (cli) {
    return path.resolve(cli);
  }
  const home = app.getPath('documents') || app.getPath('home');
  return fs.existsSync(home) ? home : process.cwd();
}

function setWorkspaceFolder(folder: string): void {
  const settings = readJson<Record<string, unknown>>(settingsPath(), {});
  settings.__workspace = folder;
  writeJson(settingsPath(), settings);
}

// ---------------------------------------------------------------------------- app

const workspaceRoot = pickWorkspaceFolder();
const secrets = createSecretStorage();
let shim: ReturnType<typeof createVscodeShim> | undefined;
let mainWindow: BrowserWindow | undefined;
let lastLayout: 'auto' | 'panel' | 'ultra' = 'ultra';

function extensionVersion(): string {
  try {
    const candidates = [
      path.join(__dirname, '..', 'package.json'),
      path.join(app.getAppPath(), 'package.json')
    ];
    for (const candidate of candidates) {
      const pkg = readJson<{ productVersion?: string; version?: string }>(candidate, {});
      const version = pkg.productVersion ?? pkg.version;
      if (version) {
        return version;
      }
    }
  } catch {
    /* ignore */
  }
  return '0.2.0';
}

async function boot(): Promise<void> {
  const extensionRoot = path.resolve(__dirname, '..');
  const iconPng = path.join(extensionRoot, 'media', 'icon.png');

  chromeGuardIpc();

  shim = createVscodeShim({
    root: workspaceRoot,
    configPath: settingsPath(),
    secrets,
    version: extensionVersion(),
    iconPath: fs.existsSync(iconPng) ? iconPng : path.join(extensionRoot, 'build', 'icon.png'),
    log,
    onStatusBar: (text, tooltip) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('amcode:status-bar', { text, tooltip });
        mainWindow.setTitle(text ? `${PRODUCT} — ${text.replace(/\$\([^)]*\)\s*/g, '')}` : PRODUCT);
      }
    },
    onHtml: (html) => {
      void html;
    }
  });

  // The panel is built while the provider registers itself — activate() sets up everything.
  try {
    activate(shim.extensionContext as never);
  } catch (err) {
    log(`failed to activate the agent: ${String(err)}`);
    dialog.showErrorBox(PRODUCT, `The agent failed to start:\n${String(err)}`);
  }

  nativeTheme.themeSource = 'dark';
  const bounds = readJson<{ width?: number; height?: number; x?: number; y?: number }>(boundsPath(), {});
  mainWindow = new BrowserWindow({
    width: Math.max(720, bounds.width ?? 1280),
    height: Math.max(560, bounds.height ?? 880),
    x: bounds.x,
    y: bounds.y,
    minWidth: 560,
    minHeight: 480,
    show: false,
    title: PRODUCT,
    backgroundColor: '#0f0f11',
    autoHideMenuBar: false,
    skipTaskbar: false,
    icon: fs.existsSync(iconPng) ? iconPng : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });
  shim.api.__amcode.setMainWindow(mainWindow);

  const view = shim.api.__amcode.getWebview();
  const html = view?.webview.html ?? '<!DOCTYPE html><body style="font:14px sans-serif;color:#ddd;background:#101010">AM Code failed to build the panel.</body>';
  const panelFile = path.join(app.getPath('temp'), `am-code-panel-${process.pid}.html`);
  fs.writeFileSync(panelFile, html, 'utf8');

  // Dev helper: AMCODE_SCREENSHOT=/tmp/shot.png renders the panel once and exits.
  mainWindow.webContents.on('did-finish-load', () => {
    if (!shim) {
      return;
    }
    // everything the agent posted before the document existed is flushed now
    shim.api.__amcode.markPanelReady();
    shim.api.__amcode.sendToPanel({ type: 'focusComposer' });
    const click = process.env.AMCODE_CLICK;
    if (click) {
      setTimeout(() => {
        mainWindow?.webContents
          .executeJavaScript(click)
          .then((result) => log(`click: ${String(result)}`))
          .catch((err) => log(`click failed: ${String(err)}`));
      }, 2200);
    }
    const drive = process.env.AMCODE_DRIVE;
    if (drive) {
      setTimeout(() => {
        const script = `(() => { const i = document.getElementById('input'); i.value = ${JSON.stringify(drive)}; i.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('btnSend').click(); return 'sent'; })()`;
        mainWindow?.webContents.executeJavaScript(script).then((result) => log(`drive: ${result}`)).catch((err) => log(`drive failed: ${String(err)}`));
      }, 2500);
    }
    const screen = process.env.AMCODE_SCREEN;
    if (screen === 'mcp') {
      shim.api.__amcode.sendToPanel({ type: 'mcpShow' });
    } else if (screen === 'models') {
      shim.api.__amcode.sendToPanel({ type: 'modelsShow' });
    }
  });

  // Dev hooks: exercise the in-app prompt bridge and the real quit path.
  if (process.env.AMCODE_TEST_PROMPT) {
    setTimeout(() => {
      void (async () => {
        const answer = await shim!.api.window.showInputBox({
          title: 'AM Code — test prompt',
          prompt: 'This input box lives inside the app (type something and press Enter)',
          value: 'hello from the panel'
        } as never);
        log(`test prompt answered: ${String(answer)}`);
      })();
    }, Number(process.env.AMCODE_TEST_PROMPT_DELAY ?? 3200));
  }
  if (process.env.AMCODE_QUIT_AFTER) {
    setTimeout(() => {
      log('quit hook: closing the window');
      mainWindow?.close();
    }, Number(process.env.AMCODE_QUIT_AFTER));
  }

  const screenshotTarget = process.env.AMCODE_SCREENSHOT;
  if (screenshotTarget) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        void (async () => {
          if (process.env.AMCODE_DEBUG_DUMP) {
            try {
              const dump = await mainWindow!.webContents.executeJavaScript(
                `JSON.stringify({layout: document.body.dataset.layout, bar: document.querySelector('.composer .bar2') ? document.querySelector('.composer .bar2').innerText : null, mode: (document.getElementById('btnMode')||{}).innerText, chip: (document.getElementById('btnModelChip')||{}).innerText, attach: (document.getElementById('btnAttach')||{}).innerText, ws: (document.getElementById('statusRow')||{}).innerText})`
              );
              log(`dump: ${dump}`);
            } catch (err) {
              log(`dump failed: ${String(err)}`);
            }
          }
          try {
            const image = await mainWindow!.webContents.capturePage();
            fs.writeFileSync(screenshotTarget, image.toPNG());
            log(`screenshot written → ${screenshotTarget}`);
          } catch (err) {
            log(`screenshot failed: ${String(err)}`);
          }
          app.exit(0);
        })();
      }, Number(process.env.AMCODE_SCREENSHOT_DELAY ?? 5000));
    });
  }

  await mainWindow.loadFile(panelFile);

  const showWindow = (why: string) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    if (!mainWindow.isVisible()) {
      mainWindow.show();
    }
    mainWindow.focus();
    log(`window shown (${why})`);
  };

  mainWindow.once('ready-to-show', () => {
    showWindow('ready-to-show');
    // push the first state so the panel is live immediately
    const root = shim?.api.__amcode.getRoot();
    log(`${PRODUCT} ${extensionVersion()} started — workspace: ${root}`);
  });

  // belt and braces: a slow/blocked renderer must never leave an invisible process behind
  const showTimer = setTimeout(() => showWindow('watchdog'), 4000);
  showTimer.unref?.();

  const saveBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized() || mainWindow.isFullScreen()) {
      return;
    }
    writeJson(boundsPath(), mainWindow.getBounds());
  };
  mainWindow.on('resized', saveBounds);
  mainWindow.on('moved', saveBounds);

  if (process.env.AMCODE_DEBUG_DUMP) {
    mainWindow.webContents.on('console-message', (_event, level, message, line, source) => {
      log(`renderer[${level}] ${message} (${source}:${line})`);
    });
  }


  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = undefined;
  });

  installMenu();
}

/** The renderer may only send panel messages to the agent — nothing else. */
function chromeGuardIpc(): void {
  const { ipcMain } = require('electron') as typeof import('electron');
  ipcMain.on('amcode:fromPanel', (_event: unknown, message: unknown) => {
    try {
      if (process.env.AMCODE_DEBUG_DUMP) {
        log(`panel → host: ${JSON.stringify((message as { type?: string })?.type ?? message).slice(0, 120)} (webview: ${Boolean(shim?.api.__amcode.hasWebview())})`);
      }
      const type = (message as { type?: string })?.type ?? '';
      // answers to an in-app prompt belong to the host (they resolve a pending VS Code style call)
      if (type === 'inlinePromptResult' && shim?.api.__amcode.settlePrompt(message as { id?: unknown; value?: unknown })) {
        return;
      }
      const result = shim?.api.__amcode.receiveMessage(message) as unknown;
      void Promise.resolve(result).catch((err) => log(`panel handling failed: ${String(err)}`));
    } catch (err) {
      log(`panel message failed: ${String(err)}`);
    }
  });
  ipcMain.handle('amcode:context', async () => ({
    product: PRODUCT,
    version: extensionVersion(),
    workspace: shim?.api.__amcode.getRoot(),
    settingsPath: settingsPath(),
    logPath: logPath()
  }));
}

function sendLayout(layout: 'auto' | 'panel' | 'ultra'): void {
  lastLayout = layout;
  const settings = readJson<Record<string, unknown>>(settingsPath(), {});
  const agentcode = (settings.agentcode as Record<string, unknown>) ?? {};
  agentcode.interfaceLayout = layout;
  settings.agentcode = agentcode;
  writeJson(settingsPath(), settings);
  shim?.api.__amcode.receiveMessage({ type: 'setLayout', layout });
}

function installMenu(): void {
  const run = (id: string) => () => {
    void shim?.api.commands.executeCommand(id);
  };
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Folder…',
          accelerator: 'Ctrl+K Ctrl+O',
          click: async () => {
            const picked = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory'], title: 'Choose a project folder' });
            if (!picked.canceled && picked.filePaths[0]) {
              setWorkspaceFolder(picked.filePaths[0]);
              shim?.api.__amcode.setWorkspaceFolder(picked.filePaths[0]);
              shim?.setWorkspaceRoot(picked.filePaths[0]);
              // in-app confirmation instead of a system dialog
              shim?.api.__amcode.sendToPanel({
                type: 'toast',
                message: `Workspace: ${picked.filePaths[0]}`,
                level: 'ok'
              });
              shim?.api.__amcode.receiveMessage({ type: 'refreshWorkspace' });
            }
          }
        },
        { label: 'New Session', accelerator: 'Ctrl+N', click: run('agentcode.newSession') },
        { label: 'Export Session…', click: run('agentcode.exportSession') },
        { type: 'separator' },
        { label: 'Open Settings File', click: () => shell.openPath(settingsPath()) },
        { label: 'Open Log File', click: () => shell.openPath(logPath()) },
        { type: 'separator' },
        { label: 'Token Saver…', click: () => shim?.api.__amcode.sendToPanel({ type: 'settingsShow', tab: 'tokens' }) },
        { label: 'Settings…', accelerator: 'Ctrl+,', click: () => shim?.api.__amcode.sendToPanel({ type: 'settingsShow', tab: 'general' }) },
        { type: 'separator' },
        { role: 'quit', label: 'Exit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Undo Last Agent Edit', accelerator: 'Ctrl+Alt+Z', click: run('agentcode.undoLastChange') }
      ]
    },
    {
      label: 'Agent',
      submenu: [
        // every model action happens in the app itself — no input-box windows
        { label: 'Add Model…', click: () => shim?.api.__amcode.sendToPanel({ type: 'modelsShow', open: 'add' }) },
        { label: 'Manage Models…', click: () => shim?.api.__amcode.sendToPanel({ type: 'modelsShow' }) },
        { label: 'MCP Servers…', accelerator: 'Ctrl+Alt+M', click: () => shim?.api.__amcode.sendToPanel({ type: 'mcpShow' }) },
        { label: 'Refresh MCP Servers', click: run('agentcode.refreshMcp') },
        { type: 'separator' },
        { label: 'Plan Mode', click: run('agentcode.plan') },
        { label: 'Build Mode', click: run('agentcode.build') },
        { label: 'Toggle Plan/Build', click: run('agentcode.toggleMode') },
        { label: 'Toggle High Autonomy', click: run('agentcode.toggleAutoApprove') },
        { type: 'separator' },
        { label: 'Add Project Rules (.agentcode/rules.md)', click: run('agentcode.initProject') },
        { label: 'Compact Conversation', click: run('agentcode.compactSession') },
        { label: 'Test Active Model', click: run('agentcode.testModel') }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Full window layout', type: 'radio', checked: lastLayout === 'ultra', click: () => sendLayout('ultra') },
        { label: 'Side panel layout', type: 'radio', checked: lastLayout === 'panel', click: () => sendLayout('panel') },
        { label: 'Automatic', type: 'radio', checked: lastLayout === 'auto', click: () => sendLayout('auto') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Telegram — @AM0_0dev', click: () => void shell.openExternal('https://t.me/AM0_0dev') },
        { label: 'Open Settings folder', click: () => void shell.openPath(userDir()) },
        { type: 'separator' },
        { label: `About ${PRODUCT}`, click: () => shim?.api.__amcode.sendToPanel({ type: 'settingsShow', tab: 'interface' }) }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
  }
});

/** Everything that must stop before the process may exit. */
let shuttingDown = false;
function shutdown(reason: string): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  log(`shutting down (${reason})`);
  try {
    shim?.api.__amcode.cancelPrompts();
  } catch {
    /* ignore */
  }
  try {
    // closes every MCP stdio server and stops the agent's background work
    deactivate?.();
  } catch (err) {
    log(`deactivate failed: ${String(err)}`);
  }
  try {
    shim?.api.__amcode.dispose();
  } catch (err) {
    log(`dispose failed: ${String(err)}`);
  }
  try {
    // last resort: anything the shim spawned (terminals, stray servers)
    shim?.api.__amcode.killChildren();
  } catch {
    /* ignore */
  }
}

app.on('before-quit', () => shutdown('before-quit'));
app.on('will-quit', () => {
  shutdown('will-quit');
  // if a child process refuses to die, do not keep a zombie in the task manager
  setTimeout(() => process.exit(0), 1500).unref?.();
});

app.on('window-all-closed', () => {
  shutdown('window-all-closed');
  app.quit();
});

app.whenReady().then(boot).catch((err) => {
  log(`boot failed: ${String(err)}`);
  dialog.showErrorBox(PRODUCT, String(err));
  app.quit();
});

void createHash; // keep the import stable across builds
void globToRegExp; // exported helper reused by the tool runner shim
