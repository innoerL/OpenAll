const { contextBridge, ipcRenderer } = require('electron');
const subscribe=(channel,fn)=>{const handler=(_event,...args)=>fn(...args);ipcRenderer.on(channel,handler);return ()=>ipcRenderer.removeListener(channel,handler);};
// 金价和贴边条沿用宿主预加载，只注入当前页面所需的最小能力。
if (process.isMainFrame !== false && process.argv.includes('--openall-page=gold')) {
  contextBridge.exposeInMainWorld('openallGold', {
    read: () => ipcRenderer.invoke('openall:gold-read'),
    watch: fn => subscribe('openall:gold-snapshot', fn),
    action: (name, payload) => ipcRenderer.invoke('openall:gold-action', name, payload),
    watchEdge: fn => subscribe('openall:gold-edge', fn),
  });
} else if (process.isMainFrame !== false && process.argv.includes('--openall-page=gold-rail')) {
  contextBridge.exposeInMainWorld('openallGoldRail', {
    read: () => ipcRenderer.invoke('openall:gold-rail-read'),
    watch: fn => subscribe('openall:gold-rail-theme', fn),
    expand: () => ipcRenderer.invoke('openall:gold-rail-expand'),
  });
} else if (process.isMainFrame !== false) {
const backend = require('./backend');
const diff = require('../assets/diff-core');
// 每个窗口依次读取和解码可见图片，避免快速滚动时同时保留多张原图。
let nextFileIcon = Promise.resolve(), thumbnailWorker;
const { pathToFileURL } = require('node:url');
const thumbnailWorkerURL = pathToFileURL(require('node:path').join(__dirname, 'clipboard-thumbnail-worker.js'));
function decodeThumbnail(image, edge) {
  thumbnailWorker ??= new Worker(thumbnailWorkerURL);
  const worker = thumbnailWorker;
  return new Promise(resolve => {
    const timer = setTimeout(failed, 15000);
    function finish(value) {
      clearTimeout(timer);
      worker.onmessage = worker.onerror = null;
      resolve(value);
    }
    function failed() {
      worker.terminate();
      thumbnailWorker = undefined;
      finish('');
    }
    worker.onmessage = event => finish(event.data);
    worker.onerror = failed;
    const {bytes, mime} = image;
    try { worker.postMessage({bytes, mime, edge}, [bytes.buffer]); } catch { failed(); }
  });
}
async function readFileIcon(payload) {
  const result = await ipcRenderer.invoke('clipboard-action', 'fileIcon', payload);
  if (!result) return null;
  let thumbnail = '';
  if (result.image) {
    try { thumbnail = await decodeThumbnail(result.image, result.edge); } catch { }
  }
  return {kind:result.kind, icon:result.icon, thumbnail};
}
function clipboardAction(action, payload) {
  if (action !== 'fileIcon') return ipcRenderer.invoke('clipboard-action', action, payload);
  const request = nextFileIcon.then(() => readFileIcon(payload));
  nextFileIcon = request.catch(() => {});
  return request;
}
contextBridge.exposeInMainWorld('openall', {
  diff:{align:diff.align},
  backend:{configDiff:backend.configDiff,parseLogs:backend.parseLogs,logFields:backend.logFields,logGroups:backend.logGroups,restoreSQL:backend.restoreSQL,explain:backend.explain},
  backendTask:(action,args)=>ipcRenderer.invoke('backend-task',action,args),
  settings:()=>ipcRenderer.invoke('get-settings'),saveSettings:value=>ipcRenderer.invoke('set-settings',value),
  search:query=>ipcRenderer.invoke('search',query),open:item=>ipcRenderer.invoke('open',item),
  openTool:(page,initialValue)=>ipcRenderer.invoke('open-tool',page,initialValue),
  windowAction:(action,payload)=>ipcRenderer.invoke('window-action',action,payload),
  history:()=>ipcRenderer.invoke('get-clipboard'),copyItem:item=>ipcRenderer.invoke('copy-item',item),deleteItem:hash=>ipcRenderer.invoke('delete-item',hash),
  clipboardAction,
  copyText:text=>ipcRenderer.invoke('copy-text',text),readText:()=>ipcRenderer.invoke('read-text'),chooseFile:()=>ipcRenderer.invoke('choose-file'),
  fileAction:(action,payload)=>ipcRenderer.invoke('file-action',action,payload),
  stack:(action,payload)=>ipcRenderer.invoke('stack-action',action,payload),selection:(action,payload)=>ipcRenderer.invoke('selection-action',action,payload),
  snippets:(action,payload)=>ipcRenderer.invoke('snippets-action',action,payload),diagnostics:()=>ipcRenderer.invoke('diagnostics'),ocr:payload=>ipcRenderer.invoke('ocr',payload),
  onWindowState:fn=>subscribe('window-state',fn),
  onNavigate:fn=>subscribe('navigate',fn),onClipboard:fn=>subscribe('clipboard-changed',fn),onSearchUpdated:fn=>subscribe('search-updated',fn),
  onPaste:fn=>subscribe('paste-content',fn),onPasteImage:fn=>subscribe('paste-image',fn),onSettingsChanged:fn=>subscribe('settings-changed',fn),onStackChanged:fn=>subscribe('stack-changed',fn),onNotice:fn=>subscribe('notice',fn)
});
}
