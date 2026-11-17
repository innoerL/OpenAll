const { contextBridge, ipcRenderer } = require('electron');
const backend = require('./backend');
const diff = require('../assets/diff-core');
const subscribe=(channel,fn)=>{const handler=(_event,...args)=>fn(...args);ipcRenderer.on(channel,handler);return ()=>ipcRenderer.removeListener(channel,handler);};
contextBridge.exposeInMainWorld('openall', {
  diff:{align:diff.align},
  backend:{configDiff:backend.configDiff,parseLogs:backend.parseLogs,logFields:backend.logFields,logGroups:backend.logGroups,restoreSQL:backend.restoreSQL,explain:backend.explain},
  backendTask:(action,args)=>ipcRenderer.invoke('backend-task',action,args),
  settings:()=>ipcRenderer.invoke('get-settings'),saveSettings:value=>ipcRenderer.invoke('set-settings',value),
  search:query=>ipcRenderer.invoke('search',query),open:item=>ipcRenderer.invoke('open',item),
  openTool:(page,initialValue)=>ipcRenderer.invoke('open-tool',page,initialValue),
  windowAction:(action,payload)=>ipcRenderer.invoke('window-action',action,payload),
  history:()=>ipcRenderer.invoke('get-clipboard'),copyItem:item=>ipcRenderer.invoke('copy-item',item),deleteItem:hash=>ipcRenderer.invoke('delete-item',hash),
  clipboardAction:(action,payload)=>ipcRenderer.invoke('clipboard-action',action,payload),
  copyText:text=>ipcRenderer.invoke('copy-text',text),readText:()=>ipcRenderer.invoke('read-text'),chooseFile:()=>ipcRenderer.invoke('choose-file'),
  fileAction:(action,payload)=>ipcRenderer.invoke('file-action',action,payload),
  stack:(action,payload)=>ipcRenderer.invoke('stack-action',action,payload),selection:(action,payload)=>ipcRenderer.invoke('selection-action',action,payload),
  snippets:(action,payload)=>ipcRenderer.invoke('snippets-action',action,payload),diagnostics:()=>ipcRenderer.invoke('diagnostics'),ocr:payload=>ipcRenderer.invoke('ocr',payload),
  onWindowState:fn=>subscribe('window-state',fn),
  onNavigate:fn=>subscribe('navigate',fn),onClipboard:fn=>subscribe('clipboard-changed',fn),onSearchUpdated:fn=>subscribe('search-updated',fn),
  onPaste:fn=>subscribe('paste-content',fn),onPasteImage:fn=>subscribe('paste-image',fn),onSettingsChanged:fn=>subscribe('settings-changed',fn),onStackChanged:fn=>subscribe('stack-changed',fn),onNotice:fn=>subscribe('notice',fn)
});
