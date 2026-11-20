const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('edgeRail', {
  open: () => ipcRenderer.send('openall-gold:rail-expand'),
});
