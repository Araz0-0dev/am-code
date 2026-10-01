/**
 * Preload for the main window: gives the panel the tiny API surface a VS Code webview has
 * (`acquireVsCodeApi`) plus a status-bar badge, so the exact same panel code runs unchanged.
 */
const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('acquireVsCodeApi', () => ({
  postMessage: (message) => ipcRenderer.send('amcode:fromPanel', message),
  getState: () => ({}),
  setState: () => {}
}));

/**
 * Host → panel. The panel listens with `window.addEventListener('message')`, and with
 * contextIsolation on, a postMessage fired from the preload's world does not reach it —
 * so we dispatch the event inside the page's own world instead.
 */
ipcRenderer.on('amcode:host-message', (_event, message) => {
  try {
    const json = JSON.stringify(message ?? null);
    webFrame.executeJavaScript(
      `window.dispatchEvent(new MessageEvent('message', { data: ${json} }));`,
      false
    );
  } catch (err) {
    console.error('AM Code: failed to deliver a host message', err);
  }
});

ipcRenderer.on('amcode:status-bar', (_event, payload) => {
  let badge = document.getElementById('amcode-status');

  // The desktop app has no VS Code status bar, so we render one as a small floating chip.
  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'amcode-status';
    badge.style.cssText = [
      'position:fixed',
      'top:8px',
      'right:12px',
      'z-index:9999',
      'font:11.5px/1.4 -apple-system,"Segoe UI",system-ui,sans-serif',
      'color:#9d9d9d',
      'background:rgba(255,255,255,.05)',
      'border:1px solid rgba(255,255,255,.10)',
      'border-radius:999px',
      'padding:3px 10px',
      'pointer-events:none',
      'max-width:60vw',
      'overflow:hidden',
      'text-overflow:ellipsis',
      'white-space:nowrap'
    ].join(';');
    document.body.appendChild(badge);
  }
  const text = String((payload && payload.text) || '').replace(/\$\([^)]*\)\s*/g, '');
  badge.textContent = text;
  badge.style.display = text ? 'block' : 'none';
});

// Chromium in Electron has no window.prompt; the panel uses inline inputs instead, but a few
// built-in flows (export path etc.) may still ask — answer with a null-safe stub.
if (typeof window.prompt !== 'function') {
  window.prompt = () => null;
}

ipcRenderer.invoke('amcode:context').then((info) => {
  document.documentElement.setAttribute('data-amcode-desktop', '1');
  window.__amCodeDesktop = info;
});
