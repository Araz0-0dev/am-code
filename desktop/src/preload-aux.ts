/** Preload shared by the small helper windows: quick picker, input box and the terminal. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pickerApi', {
  picked: (index) => ipcRenderer.send('picked', index),
  cancelled: () => ipcRenderer.send('cancelled'),
  value: (value) => ipcRenderer.send('value', value)
});

contextBridge.exposeInMainWorld('terminalApi', {
  run: (command) => ipcRenderer.send('terminal-run', command)
});

ipcRenderer.on('terminal-line', (_event, line) => {
  window.postMessage({ line: String(line) }, '*');
});
