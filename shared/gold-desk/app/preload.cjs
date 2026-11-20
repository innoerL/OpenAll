const { contextBridge, ipcRenderer } = require('electron');
const prefix = 'openall-gold:';
const invoke = (name, ...args) => ipcRenderer.invoke(prefix + name, ...args);
const send = (name, ...args) => ipcRenderer.send(prefix + name, ...args);
function watch(name, listener) {
  const callback = (_event, ...args) => listener(...args);
  ipcRenderer.on(prefix + name, callback);
  return () => ipcRenderer.removeListener(prefix + name, callback);
}

contextBridge.exposeInMainWorld('goldDesk', {
  read: () => invoke('read-snapshot'),
  watch: listener => watch('snapshot', listener),
  setLayout: combined => invoke('layout', combined),
  setCurrency: currency => invoke('currency', currency),
  theme: () => invoke('theme'),
  setView: view => invoke('view', view),
  toggleEdge: () => invoke('edge-setting'),
  watchEdge: listener => watch('edge-motion', listener),
  pin: () => invoke('pin'),
  minimize: () => send('minimize'),
  quit: () => send('quit-window'),
  openSource: key => send('source-link', key),
  openEvent: url => send('event-link', url),
});

for (const event of ['online', 'offline']) {
  window.addEventListener(event, () => send('recheck-network'));
}
