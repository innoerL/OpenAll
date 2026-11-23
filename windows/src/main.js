const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, clipboard, nativeImage, shell, dialog, screen } = require('electron');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { JSONStore, ClipboardStore, SnippetStore, normalizeSettings, expandSnippet, snippetExpansionParts } = require('./stores');
const { commands, identity } = require('./search-engine');
const { previewLimit, previewKinds, fileEntry, filePreview, imageTypes, readPreviewImage } = require('./clipboard-files');
const { NativeBridge, WorkerClient, recognizeImage } = require('./native-services');
const { Updater }=require('./native-updater');
const { ShortcutRecording }=require('./native-shortcut-recording');
const { createGoldService, resourceDirectory }=require('./gold-service');
const { placement: goldPlacement, attachGoldWindow }=require('./gold-window');
const smokeMode=process.env.OPENALL_CI_SMOKE==='1';
const testMode=smokeMode||process.env.OPENALL_TEST_MODE==='1';
if(testMode){const isolated=process.env.OPENALL_TEST_USER_DATA||fs.mkdtempSync(path.join(os.tmpdir(),'openall-win-test-'));fs.mkdirSync(isolated,{recursive:true});app.setPath('userData',path.resolve(isolated));}
if(!testMode&&!app.requestSingleInstanceLock())app.exit(0);
app.on('second-instance',()=>{if(app.isReady())showPage('search').catch(notifyError);});
const store=new JSONStore(app.getPath('userData'));
let settings=normalizeSettings(store.read('settings',{}));
const clips=new ClipboardStore(store,()=>settings.clipboardPreferences);
const snippetStore=new SnippetStore(store);
const updater=new Updater(store,app.getVersion(),{launch:async file=>{if(testMode)throw Error('测试模式禁止启动安装器');if(process.platform!=='win32')throw Error('安装器仅适用于 Windows');const error=await shell.openPath(file);if(error)throw Error(error);}});
let ranking=store.read('search-ranking',{usage:{},rules:{}});
const native=new NativeBridge();
const inspectClipboardFile = process.platform === 'win32' ? file => {
 if (!native.child && testMode) native.start();
 return native.request('localPreviewType', {path:file});
} : undefined;
const windows=new Map(),windowContexts=new Map();
const workers=[];
let goldServiceReady,goldWindowController;
let searchWorker,backendWorker,imageWorker,tray,monitor,refreshTimer,searchStatus={},lastExternal={handle:'0',pid:0,name:''},pasteTarget=null,lastContentHash='',captureWrites=Promise.resolve(),capturePausedUntil=0,ocrQueue=Promise.resolve(),shortcutsStatus={};
let shortcutTestRegistration=false;
const shortcutRecording=new ShortcutRecording({suspend:()=>globalShortcut.unregisterAll(),resume:()=>{if(!app.isQuitting){const failed=applyShortcuts(settings);if(failed.length)notifyError(Error('快捷键恢复失败：'+failed.join('、')));}}});
const iconCache=new Map(),iconPending=new Map();
async function fileIcon(file,application=false,size='small'){if(!file)return '';const key=size+':'+(application?file.toLowerCase():path.extname(file).toLowerCase()||'<folder>');if(iconCache.has(key))return iconCache.get(key);if(iconPending.has(key))return iconPending.get(key);const request=app.getFileIcon(file,{size}).then(icon=>icon.isEmpty()?'':icon.toDataURL()).catch(()=>'').then(value=>{iconCache.set(key,value);iconPending.delete(key);if(iconCache.size>512)iconCache.delete(iconCache.keys().next().value);return value;});iconPending.set(key,request);return request;}
async function searchWithIcons(query){const results=await searchWorker.call('search',{query:String(query).slice(0,4096)});return Promise.all(results.map(async item=>['application','file'].includes(item.type)?{...item,icon:await fileIcon(item.value,item.type==='application')}:item));}
const testClipboard={text:'',html:'',image:null,files:[]};
const pageAliases={'金价':'gold','金价桌台':'gold','JSON 工具':'json','文本对比':'comparison','Markdown 编辑器':'markdown','结构化配置对比':'configDiff','SQL 参数还原':'sqlRestore','日志时间线':'logTimeline','执行计划阅读器':'explain','设置':'settings','剪贴板':'clipboard'};
const normalizePage=id=>pageAliases[id]||id||'search';
const transient=new Set(['search','clipboard','stack','selection']);
const getText=()=>testMode?testClipboard.text:clipboard.readText();
function putText(value){if(testMode){testClipboard.text=String(value);testClipboard.html='';testClipboard.image=null;testClipboard.files=[];}else clipboard.writeText(String(value));}
function broadcast(channel,...args){for(const win of windows.values())if(!win.isDestroyed())win.webContents.send(channel,...args);}
function changedClipboard(){broadcast('clipboard-changed',clips.list());broadcast('stack-changed',clips.stackInfo());}
function windowFor(event){return BrowserWindow.fromWebContents(event.sender);}
function currentContext(win){return windowContexts.get(win?.id)||{};}
function windowState(win){return {maximized:win.isMaximized(),resizable:win.isResizable()};}
function canReceivePaste(page){return page !== 'clipboardPreview' && !transient.has(page);}
function rememberTarget(){const focused=BrowserWindow.getFocusedWindow();const ctx=currentContext(focused);if(focused&&canReceivePaste(ctx.page)){pasteTarget={windowId:focused.id};return;}if(native.foreground.pid&&native.foreground.pid!==process.pid){lastExternal=native.foreground;pasteTarget={...lastExternal};}}
const clipboardShelfHeight = 300;
function dimensions(page){const sizes={search:[720,76],clipboard:[screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea.width,clipboardShelfHeight],stack:[340,174],clipboardPreview:[700,270],translate:[580,320],selection:[640,510],json:[960,600],comparison:[1040,600],configFormat:[960,420],sqlFormat:[960,420],markdown:[980,540],manual:[980,540],unicode:[800,380],id:[660,520],image:[900,540],converter:[980,610],settings:[930,560],configDiff:[1000,680],sqlRestore:[1000,530],logTimeline:[1000,680],explain:[1000,680]};return sizes[page]||[980,540];}
function position(win,page){const area=screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;const [width,height]=win.getSize();if(page==='clipboard')win.setBounds({x:area.x,y:area.y+area.height-height,width:area.width,height});else if(page==='stack')win.setPosition(area.x+area.width-width-24,area.y+24);else if(page==='search')win.setPosition(Math.round(area.x+(area.width-width)/2),Math.round(area.y+Math.max(80,area.height*.22)));else win.setPosition(Math.round(area.x+(area.width-width)/2),Math.round(area.y+(area.height-height)/2));}
async function getGoldService(){
 if(app.isQuitting)throw Error('OpenAll 正在退出');
 if(!goldServiceReady){
  goldServiceReady=createGoldService({
   dataDirectory:path.join(app.getPath('userData'),'gold-desk'),
   legacyDirectory:testMode?undefined:path.join(app.getPath('appData'),'GoldDesk'),
   fixture:testMode,settings:()=>settings,
  }).catch(error=>{goldServiceReady=undefined;throw error;});
 }
 const service=await goldServiceReady;
 if(app.isQuitting){service.dispose();throw Error('OpenAll 正在退出');}
 return service;
}
async function createWindow(rawPage,initialValue,options={}){
 let page=normalizePage(rawPage);if(['permissions','diagnostics','snippets','linkAliases','commandAliases'].includes(page)){initialValue=page;page='settings';}
 const gold=page==='gold'?await getGoldService():null;
 const existing=windows.get(page);
 if(existing&&!existing.isDestroyed()){
  if(initialValue!==undefined&&initialValue!==''){windowContexts.set(existing.id,{page,initialValue});existing.webContents.send('navigate',page,initialValue);}
  else if(transient.has(page))existing.webContents.send('navigate',page,initialValue);
  if(page==='search'){existing.setSize(720,76);position(existing,page);}if(page==='clipboard')position(existing,page);
  if(!options.hidden){if(gold)await goldWindowController.show();else {existing.show();existing.focus();}}return existing;
 }
 if(gold)gold.update('view','quotes');
 const [width,defaultHeight]=dimensions(page),isTransient=transient.has(page);
 const unicodeInput = page === 'unicode' ? (typeof initialValue === 'string' ? initialValue : initialValue?.text || '') : '';
 const height = page === 'unicode' ? (unicodeInput.length <= 240 && unicodeInput.split('\n',4).length <= 3 ? 306 : 440) : defaultHeight;
 const win=new BrowserWindow({width,height,...(gold?goldPlacement(gold):{}),minWidth:gold?345:page==='search'?720:page==='clipboard'?400:page==='stack'?340:page==='translate'?580:480,minHeight:gold?396:page==='search'?76:page==='clipboard'?clipboardShelfHeight:page==='stack'?174:page==='selection'||page==='clipboardPreview'?180:page==='translate'?320:300,
   frame:false,transparent:isTransient,backgroundColor:gold?gold.snapshot().theme.background:isTransient?'#00000000':settings.backgroundHex,show:false,title:gold?'OpenAll · 金价':page==='search'?'OpenAll':(commands.find(x=>x.id===page)?.title||'OpenAll'),
   skipTaskbar:isTransient,alwaysOnTop:gold?gold.snapshot().pinned:isTransient,resizable:!isTransient,hasShadow:true,icon:path.join(__dirname,'../assets/icon.png'),
   webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:!!gold,backgroundThrottling:false,additionalArguments:gold?['--openall-page=gold']:[]}});
 if(['configDiff','explain','logTimeline','sqlRestore'].includes(page))win.on('will-resize',()=>{win._manualReportHeight=true;});
 windows.set(page,win);windowContexts.set(win.id,{page,initialValue:initialValue??''});
 win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 win.webContents.on('will-navigate',(event,url)=>{if(gold||!url.startsWith('file://'))event.preventDefault();});
 win.on('focus',()=>{if(canReceivePaste(page))pasteTarget={windowId:win.id};});
 const updateWindowState=()=>{if(!win.webContents.isDestroyed())win.webContents.send('window-state',windowState(win));};
 win.on('maximize',updateWindowState);win.on('unmaximize',updateWindowState);
 win.on('blur',()=>{if(page==='search'&&!win._pinned&&!smokeMode)win.hide();});
 win.on('close',event=>{if(!app.isQuitting&&isTransient){event.preventDefault();win.hide();}});
 win.on('closed',()=>{if(windows.get(page)===win)windows.delete(page);windowContexts.delete(win.id);});
 if(gold){
  const controller=attachGoldWindow(win,gold,rail=>{windows.set('gold-rail',rail);windowContexts.set(rail.id,{page:'gold-rail'});rail.once('closed',()=>{if(windows.get('gold-rail')===rail)windows.delete('gold-rail');windowContexts.delete(rail.id);});});
  goldWindowController=controller;win.once('closed',()=>{if(goldWindowController===controller)goldWindowController=null;});
 }else position(win,page);
 try {await win.loadFile(gold?path.join(resourceDirectory('gold-ui'),'index.html'):path.join(__dirname,'index.html'),{query:{page}});}
 catch(error){win.destroy();throw error;}
 if(!options.hidden){if(gold)await goldWindowController.show();else {win.show();win.focus();}}return win;
}
async function showPage(page='search',initialValue){rememberTarget();return createWindow(page,initialValue);}
async function togglePage(page){const existing=windows.get(page);if(existing?.isVisible()){existing.hide();return;}await showPage(page);}
function applyShortcuts(next,{force=false}={}){
 if(testMode&&force)shortcutTestRegistration=true;
 if(testMode&&!shortcutTestRegistration){shortcutsStatus={search:true,clipboard:true,stack:true,selection:true};return [];}
 // 录制期间仅同步探测冲突，随即注销；异步保存结束前不会恢复按键响应。
 globalShortcut.unregisterAll();const failed=[],seen=new Set();
 for(const [key,page] of [['search','search'],['clipboard','clipboard'],['stack','stack'],['selection','selection']]){
  if(key==='search'&&next.searchShortcutMode==='double'){shortcutsStatus[key]=native.ready;continue;}
  const normalized=String(next[key]||'').toLowerCase();if(seen.has(normalized)){shortcutsStatus[key]=false;failed.push(key);continue;}seen.add(normalized);
  try{const callback=key==='selection'?()=>captureSelection().catch(error=>notifyError(error)):key==='stack'?()=>stackAction('start').catch(error=>notifyError(error)):()=>togglePage(page).catch(error=>notifyError(error));shortcutsStatus[key]=!!next[key]&&globalShortcut.register(next[key],()=>{if(!shortcutRecording.active)callback();});if(shortcutRecording.active)globalShortcut.unregister(next[key]);if(!shortcutsStatus[key])failed.push(key);}catch{shortcutsStatus[key]=false;failed.push(key);}
 }
 if(shortcutRecording.active)globalShortcut.unregisterAll();else if(clips.stack.active)registerStackPaste();return failed;
}
function registeredShortcuts(){return Object.fromEntries(['search','clipboard','stack','selection'].map(key=>[key,!(key==='search'&&settings.searchShortcutMode==='double')&&!!settings[key]&&globalShortcut.isRegistered(settings[key])]));}
function notifyError(error){broadcast('notice',error.message||String(error));}
function updateSearch(){return searchWorker?.call('settings',{settings,ranking,snippets:snippetStore.items});}
function saveRanking(){store.write('search-ranking',ranking);updateSearch();broadcast('search-updated',searchStatus);}
function recordUsage(item){const key=identity(item),old=ranking.usage[key];ranking.usage[key]={count:Math.min(1000,(old?.count||0)+1),lastUsed:Date.now()};if(Object.keys(ranking.usage).length>3000)ranking.usage=Object.fromEntries(Object.entries(ranking.usage).sort((a,b)=>b[1].lastUsed-a[1].lastUsed).slice(0,2400));saveRanking();}
function captureClipboard(change) {
 const files = change?.files;
 if (app.isQuitting || (!change && Date.now() < capturePausedUntil)) return;
 const pref = settings.clipboardPreferences;
 if (!pref.enabled || pref.pausedUntil && Date.now() < new Date(pref.pausedUntil).getTime()) return;
 const sourceName = BrowserWindow.getFocusedWindow() ? 'OpenAll' : native.foreground.name || lastExternal.name || '';
 if (pref.ignoreApplications.some(x => sourceName.toLowerCase().includes(path.basename(x).replace(/\.exe$/i, '').toLowerCase()))) return;
 const sourcePath = sourceName === 'OpenAll' ? process.execPath : native.foreground.exePath || lastExternal.exePath;
 try {
  let entry = fileEntry(files);
  if (!entry) {
   const formats = clipboard.availableFormats();
   if (formats.some(x => /hdrop|filenamew|filedrop/i.test(x))) return;
   const image = clipboard.readImage();
   if (!image.isEmpty()) {
    const bytes = image.toPNG();
    if (bytes.length > pref.maxItemBytes) return;
    const size = image.getSize(), thumbnail = image.resize({width:Math.min(480, size.width)}).toPNG().toString('base64');
    entry = {kind:'image', value:bytes.toString('base64'), thumbnail, title:`图片 · ${size.width} × ${size.height}`, width:size.width, height:size.height};
   } else {
    const text = clipboard.readText();
    if (!text || Buffer.byteLength(text) > pref.maxItemBytes) return;
    entry = {kind:/^https?:\/\/\S+$/i.test(text.trim()) ? 'link' : 'text', value:text, text, html:clipboard.readHTML(),
      rtf:formats.includes('Rich Text Format') ? clipboard.readRTF() : undefined};
   }
  }
  if (entry.kind === 'files' && Buffer.byteLength(entry.value) > pref.maxItemBytes) return;
  const hash = crypto.createHash('sha256').update(entry.kind + ':' + entry.value).digest('hex');
  if (hash === lastContentHash) return;
  lastContentHash = hash;
  // 先按通知顺序保存剪贴板快照。图标和文件类型查询可以晚于下一次复制完成。
  captureWrites = captureWrites.then(async () => {
   const record = await clips.add({...entry, sourceName});
   if (!record) return;
   changedClipboard();
   if (record.kind === 'image') queueOCR(record);
   Promise.all([fileIcon(sourcePath, true), record.kind === 'files' ? previewKinds(record.files, inspectClipboardFile) : undefined])
    .then(([sourceIcon, fileKinds]) => {
     if ((!sourceIcon && !fileKinds) || !clips.records.includes(record)) return;
     clips.change([record.id], current => {
      if (sourceIcon) current.sourceIcon = sourceIcon;
      if (fileKinds) current.fileKinds = fileKinds;
     });
     changedClipboard();
    }).catch(error => { searchStatus.clipboardError = error.message; });
  }).catch(error => {
   if (lastContentHash === hash) lastContentHash = '';
   searchStatus.clipboardError = error.message;
  });
 } catch (error) { searchStatus.clipboardError = error.message; }
}
function queueOCR(record){ocrQueue=ocrQueue.catch(()=>{}).then(async()=>{if(!clips.records.some(x=>x.id===record.id))return;const full=await clips.full(record.id);let image=nativeImage.createFromBuffer(Buffer.from(full.value,'base64'));const size=image.getSize();if(Math.max(size.width,size.height)>4000)image=image.resize(size.width>size.height?{width:4000}:{height:4000});const result=await recognizeImage(image.toPNG());clips.change([record.id],x=>{x.ocrText=result.text;x.recognizedText=result.text;});changedClipboard();}).catch(error=>{searchStatus.ocrError=error.message;});}
async function writeRecord(item,plain=false){
 const record=typeof item==='string'?await clips.full(item):item.hash?await clips.full(item.hash)||item:item;if(!record)return null;
 if(record.kind==='image'){
  const image=nativeImage.createFromBuffer(Buffer.from(record.value,'base64'));if(testMode){testClipboard.image=image;testClipboard.text='';testClipboard.html='';testClipboard.files=[];}else clipboard.writeImage(image);
 }else if(record.kind==='files'&&!plain&&(testMode||process.platform==='win32')){
  if(testMode){putText('');testClipboard.files=[...record.files];}
  else await native.request('writeFiles',{files:record.files});
 }
 else {const text=record.text??record.value??'';if(testMode)putText(text);else if(!plain&&record.html)clipboard.write({text,html:record.html,rtf:record.rtf||''});else putText(text);}
 const text=record.text??record.value??'';
 const kind=record.kind==='files'&&!plain?'files':record.kind==='image'?'image':/^https?:\/\/\S+$/i.test(text.trim())?'link':'text';
 const value=kind==='files'?record.files.join('\n'):kind==='image'?record.value:text;
 lastContentHash=crypto.createHash('sha256').update(kind+':'+value).digest('hex');
 return record;
}
async function pasteRecord(item,plain){
 const kind=typeof item==='string'?clips.records.find(row=>row.id===item)?.kind:item?.kind;
 plain??=kind!=='files'&&settings.clipboardPreferences.plainTextByDefault;
 const record=await writeRecord(item,plain);if(!record)return false;
 const target=pasteTarget;windows.get('clipboard')?.hide();windows.get('search')?.hide();
 if(target?.windowId){const win=BrowserWindow.fromId(target.windowId);if(win&&!win.isDestroyed()){
  win.show();win.focus();
  if(record.kind==='image')win.webContents.send('paste-image',{dataUrl:'data:image/png;base64,'+record.value});
  else win.webContents.send('paste-content',{text:record.text??record.value??'',html:plain?'':record.html||'',files:record.files||[]});
  return true;
 }}
 if(testMode)return true;
 if(!target?.handle||target.handle==='0')return false;
 await new Promise(resolve=>setTimeout(resolve,120));return native.request('paste',{handle:target.handle});
}
function registerStackPaste(){if(testMode||shortcutRecording.active)return;try{globalShortcut.unregister('Control+V');globalShortcut.register('Control+V',async()=>{if(shortcutRecording.active)return;rememberTarget();globalShortcut.unregister('Control+V');try{await stackAction('next');}catch(error){notifyError(error);}setTimeout(()=>{if(clips.stack.active)registerStackPaste();},250);});}catch(error){notifyError(error);}}
async function stackAction(action,payload={}){
 switch(action){case 'start':rememberTarget();clips.stack.active=true;registerStackPaste();await createWindow('stack');break;case 'stop':clips.stack.active=false;if(!testMode)globalShortcut.unregister('Control+V');break;case 'add':{let ids=payload.ids||[];if(payload.text){const item=await clips.add({kind:'text',value:String(payload.text),text:String(payload.text),sourceName:'OpenAll'});if(item)ids=[...ids,item.id];changedClipboard();}for(const id of ids)if(clips.records.some(x=>x.id===id)&&!clips.stack.ids.includes(id))clips.stack.ids.push(id);break;}case 'remove':{const ids=payload.ids||[payload.id||clips.stack.ids[payload.index]].filter(Boolean);clips.stack.ids=clips.stack.ids.filter(id=>!ids.includes(id));break;}case 'clear':clips.stack.ids=[];break;case 'next':{const id=clips.stack.ids.shift();if(id)await pasteRecord(id);if(!clips.stack.ids.length){clips.stack.active=false;if(!testMode)globalShortcut.unregister('Control+V');}break;}case 'move':{const from=payload.id?clips.stack.ids.indexOf(payload.id):Number(payload.index);if(from>=0&&from<clips.stack.ids.length){const [id]=clips.stack.ids.splice(from,1);clips.stack.ids.splice(Math.max(0,Math.min(clips.stack.ids.length,Number(payload.to)||0)),0,id);}break;}case 'reverse':clips.stack.ids.reverse();break;}
 const value=clips.stackInfo();broadcast('stack-changed',value);return value;
}
async function captureSelection(){
 rememberTarget();let text='';
 if(pasteTarget?.windowId){const win=BrowserWindow.fromId(pasteTarget.windowId);if(win)text=await win.webContents.executeJavaScript(`(() => {const e=document.activeElement;return window.OpenAllApp?.controller?.getSelection?.()??(e&&typeof e.selectionStart==='number'?e.value.slice(e.selectionStart,e.selectionEnd):getSelection().toString())})()`);}
 else if(!testMode&&pasteTarget?.handle){capturePausedUntil=Date.now()+1500;const selected=await native.request('captureSelection',{handle:pasteTarget.handle});if(selected.kind==='image'||selected.kind==='files'){await createWindow('selection',{...selected,summary:selected.kind==='image'?'选中的图片':`选中的文件 · ${selected.files.length} 项`});return selected;}text=selected.text||'';}
 else text=getText();
 if(!text)throw Error('未读取到选中内容，请先在原应用中选中文字。');
 await createWindow('selection',{kind:'text',text,summary:`选中的文本 · ${text.length} 字`});return {text};
}
async function openItem(item,event){if(!item||typeof item.value!=='string')return false;recordUsage(item);if(item.type==='tool'){await createWindow(item.value,item.initialValue);windows.get('search')?.hide();return true;}if(item.type==='snippet'){const snippet=snippetStore.items.find(x=>x.id===item.value);if(snippet)await pasteRecord({kind:'text',text:expandSnippet(snippet.body,getText()),value:''});return true;}if(item.type==='text'){putText(item.value);windows.get('search')?.hide();return true;}if(item.type==='url'){if(!/^https?:\/\//i.test(item.value))throw Error('仅允许 HTTP 或 HTTPS 地址');await shell.openExternal(item.value);}else if(['file','application'].includes(item.type)){const error=await shell.openPath(item.value);if(error)throw Error(error);}windows.get('search')?.hide();return true;}
function dataBuffer(dataUrl){const m=/^data:([^;,]+)?;base64,([\s\S]+)$/.exec(String(dataUrl));if(!m)throw Error('图片数据格式无效');if(m[2].length>134_000_000)throw Error('图片不能超过 100 MB');const bytes=Buffer.from(m[2],'base64');if(bytes.length>100_000_000)throw Error('图片不能超过 100 MB');return bytes;}
async function fileAction(event,action,payload={}){
 const win=windowFor(event);
 switch(action){
 case 'openImage':{const chosen=await dialog.showOpenDialog(win,{properties:['openFile'],filters:[{name:'图片',extensions:['png','jpg','jpeg','gif','webp','heic','heif','tif','tiff','bmp']}]});if(chosen.canceled)return null;const file=chosen.filePaths[0],stat=await fsp.stat(file);if(stat.size>100_000_000)throw Error('图片不能超过 100 MB');const bytes=await fsp.readFile(file),ext=path.extname(file).slice(1).toLowerCase();return {path:file,name:path.basename(file),dataUrl:`data:image/${ext==='jpg'?'jpeg':ext};base64,`+bytes.toString('base64')};}
 case 'readImageFile':case 'readImage':{if(payload.path){const stat=await fsp.stat(payload.path);if(stat.size>100_000_000)throw Error('图片不能超过 100 MB');const bytes=await fsp.readFile(payload.path),extension=path.extname(payload.path).slice(1).toLowerCase();return {dataUrl:`data:image/${extension==='jpg'?'jpeg':extension};base64,`+bytes.toString('base64'),path:payload.path,name:path.basename(payload.path)};}const image=testMode?testClipboard.image:clipboard.readImage();return image&&!image.isEmpty()?{dataUrl:image.toDataURL()}:null;}
 case 'copyImage':{const image=nativeImage.createFromBuffer(dataBuffer(payload.dataUrl));if(image.isEmpty())throw Error('无法读取图片');if(testMode){testClipboard.image=image;testClipboard.text='';testClipboard.html='';testClipboard.files=[];}else clipboard.writeImage(image);return true;}
 case 'encodeImage':return imageWorker.call('encode',{payload});
 case 'save':case 'saveText':{const result=await dialog.showSaveDialog(win,{defaultPath:path.basename(payload.name||'OpenAll.txt'),filters:payload.filters||[]});if(result.canceled)return {canceled:true};const bytes=payload.dataUrl?dataBuffer(payload.dataUrl):Buffer.from(String(payload.text??''));await fsp.writeFile(result.filePath,bytes);return {path:result.filePath,canceled:false};}
 case 'openText':case 'open':{const result=await dialog.showOpenDialog(win,{properties:['openFile']});if(result.canceled)return null;const file=result.filePaths[0];if((await fsp.stat(file)).size>32_000_000)throw Error('文本不能超过 32 MB');return {path:file,name:path.basename(file),text:await fsp.readFile(file,'utf8')};}
 case 'dataDirectory':await shell.openPath(app.getPath('userData'));return app.getPath('userData');
 case 'openSystemSettings':if(!/^ms-settings:[a-z0-9-]+$/i.test(payload.uri||''))throw Error('无效的系统设置地址');return shell.openExternal(payload.uri);
 case 'preview':{const error=await shell.openPath(payload.path);if(error)throw Error(error);return true;}
 case 'reveal':shell.showItemInFolder(payload.path);return true;
 case 'openWith':{if(process.platform==='win32'){const {spawn}=require('node:child_process');spawn('rundll32.exe',['shell32.dll,OpenAs_RunDLL',payload.path],{detached:true,windowsHide:false}).unref();return true;}return shell.openPath(payload.path);}
 case 'chooseApplication':{const result=await dialog.showOpenDialog(win,{properties:['openFile'],filters:[{name:'应用程序',extensions:['exe','lnk']}]});return result.canceled?null:{path:result.filePaths[0]};}
 case 'chooseFolder':{const result=await dialog.showOpenDialog(win,{properties:['openDirectory']});return result.canceled?null:{path:result.filePaths[0]};}
 default:throw Error('未知文件操作');
 }
}
async function windowAction(event,action,payload={}){
 const win=windowFor(event),ctx=currentContext(win);
 switch(action){case 'context':return {...ctx,pinned:!!win?._pinned};case 'windowState':return windowState(win);case 'shortcutRecording':if(ctx.page!=='settings'&&payload.active)throw Error('只能在设置窗口录制快捷键');if(payload.active)shortcutRecording.start(win);else if(win)shortcutRecording.stop(win);return {active:shortcutRecording.active,registered:registeredShortcuts()};case 'translation':if(ctx.page!=='translate'){if(payload.command==='release'&&(!win||win.isDestroyed()||!ctx.page))return true;throw Error('翻译窗口不匹配');}return require('./translation-window').translationAction(win,payload,{testMode});case 'close':win.close();return true;case 'minimize':win.minimize();return true;case 'maximize':if(win.isResizable()){win.isMaximized()?win.unmaximize():win.maximize();}return true;case 'pin':win._pinned=payload.pinned??!win._pinned;win.setAlwaysOnTop(win._pinned||transient.has(ctx.page));return win._pinned;case 'setTitle':win.setTitle(String(payload.title||'OpenAll'));return true;
 case 'resizeSearch':{if(ctx.page!=='search'&&!testMode)return false;const count=Math.max(0,Math.min(7,Number(payload.count)||0)),height=payload.idle?76:120+56*count;const bounds=win.getBounds();if(bounds.width!==720||bounds.height!==height)win.setBounds({...bounds,width:720,height},false);return {width:720,height};}
 case 'fitBackendReport':{
  if(!['configDiff','explain','logTimeline','sqlRestore'].includes(ctx.page)||win.isMaximized()||win.isFullScreen()||win._manualReportHeight)return false;
  const bounds=win.getBounds(),area=screen.getDisplayMatching(bounds).workArea;
  const height=Math.min(area.height,Math.max(320,Math.min(820,Math.ceil(Number(payload.height)||530))));
  if(Math.abs(height-bounds.height)>1)win.setBounds({...bounds,height,y:Math.max(area.y,Math.min(bounds.y,area.y+area.height-height))});
  return true;
 }
 case 'fitClipboardPreview':{
  if(ctx.page!=='clipboardPreview'||win.isMaximized())return false;
  const bounds=win.getBounds(),area=screen.getDisplayMatching(bounds).workArea;
  const height=Math.max(190,Math.min(area.height,680,Math.ceil(Number(payload.height)||270)));
  win.setBounds({...bounds,height,y:Math.max(area.y,Math.min(area.y+area.height-height,Math.round(bounds.y+(bounds.height-height)/2)))});
  return true;
 }
 case 'resize':{const width=Math.min(1800,Math.max(ctx.page==='stack'?340:480,Number(payload.width)||960)),height=Math.min(1200,Math.max(ctx.page==='search'?76:ctx.page==='stack'?174:ctx.page==='selection'?180:300,Number(payload.height)||640));if(ctx.page==='selection'){win.setMinimumSize(480,180);win.setMaximumSize(1800,1200);}win.setSize(width,height);if(ctx.page==='stack')position(win,'stack');return true;}
 case 'showClipboard':rememberTarget();await createWindow('clipboard');return true;case 'showSearch':return !!await showPage('search');case 'openSettings':await createWindow('settings',payload);return true;
 case 'checkUpdates':return updater.check(settings.updateFeedURL);case 'installUpdate':return updater.install();case 'rollbackUpdate':return updater.rollback();case 'updateStatus':return updater.status();
 case 'searchRules':{
   const rules=Object.entries(ranking.rules).map(([key,rule])=>({key,...rule}));
   return payload.includeUsage ? {rules,hasUsage:Object.keys(ranking.usage||{}).length>0} : rules;
 }
 case 'searchRule':{const item=payload.item;if(payload.action==='clearUsage')ranking.usage={};else if(item){const key=identity(item);if(payload.action==='reset')delete ranking.rules[key];else {const previous=ranking.rules[key]||{};const active=payload.action==='pin'?'pinned':'hidden';if(previous[active])delete ranking.rules[key];else ranking.rules[key]={...item,pinned:active==='pinned',hidden:active==='hidden'};}}saveRanking();return true;}
 case 'rescan':case 'refreshIndex':searchWorker.call('init',{settings,ranking,snippets:snippetStore.items,testMode}).catch(notifyError);return true;
 case 'testShortcuts':if(!testMode)throw Error('仅测试模式可用');return {failed:applyShortcuts(settings,{force:true}),registered:{...shortcutsStatus}};
 case 'smokeFixture':{if(!testMode)throw Error('仅测试模式可用');if(payload.fileDrops){for(const files of payload.fileDrops){if(fileEntry(files))captureClipboard({files});}await captureWrites;}if(payload.readFiles)return testClipboard.files;if(payload.clipboard){for(const entry of payload.clipboard)await clips.add({...entry,sourceName:'OpenAll 测试'});changedClipboard();}if(payload.search)await searchWorker.call('fixtures',{data:payload.search});if(payload.native&&process.platform==='win32'){if(!native.child)native.start();await native.waitUntilReady();}return true;}
 case 'menu':{const item=payload.item;Menu.buildFromTemplate([{label:'打开',click:()=>openItem(item,event).catch(notifyError)},{label:'置顶 / 取消置顶',click:()=>windowAction(event,'searchRule',{action:'pin',item})},{label:'隐藏此结果',click:()=>windowAction(event,'searchRule',{action:'hide',item})},...(item?.type==='file'||item?.type==='application'?[{label:'在资源管理器中显示',click:()=>shell.showItemInFolder(item.value)},{label:'指定应用打开…',click:()=>fileAction(event,'openWith',{path:item.value})}]:[])]).popup({window:win});return true;}
 default:throw Error('未知窗口操作');}
}
async function clipboardAction(event,action,payload={}){
 if(action==='fileIcon'){
   const detail = event.sender === windows.get('clipboardPreview')?.webContents;
   if ((!detail && event.sender !== windows.get('clipboard')?.webContents) || event.senderFrame !== event.sender.mainFrame) return null;
   const record=clips.records.find(item=>item.id===payload?.id), index=payload?.index;
   if(record?.kind!=='files'||!Array.isArray(record.files)||!Number.isInteger(index)||index<0||index>=Math.min(previewLimit,record.files.length))return null;
   const file = record.files[index];
   if (detail) {
     const bound = currentContext(windowFor(event)).initialValue;
     if (bound?.id !== record.id || bound.kind !== 'files' || record.files.length !== 1) return null;
     if (!imageTypes[path.extname(file).toLowerCase()]) return {kind:'file', icon:'', thumbnail:''};
   }
   const {kind,systemIcon,mime} = await filePreview(file,record.fileKinds?.[index],inspectClipboardFile);
   const [icon, image] = await Promise.all([
     !detail && systemIcon ? fileIcon(file,true,'normal') : '',
     mime ? readPreviewImage(file,mime) : null,
   ]);
   return {kind, icon, image, edge:detail ? 1280 : 320};
 }
 if(action==='setLayout'){
   if(!['cards','list'].includes(payload.layout))throw Error('未知的剪贴板布局');
   const previous=settings.clipboardPreferences.shelfLayout;
   settings.clipboardPreferences.shelfLayout=payload.layout;
   try{await store.write('settings',settings);}
   catch(error){if(settings.clipboardPreferences.shelfLayout===payload.layout)settings.clipboardPreferences.shelfLayout=previous;throw error;}
   broadcast('settings-changed',settings);
   return settings.clipboardPreferences.shelfLayout;
 }
 const ids=payload.ids||[payload.id||payload.hash].filter(Boolean),selected=ids.length?clips.records.filter(x=>ids.includes(x.id)||ids.includes(x.hash)):[];
 switch(action){case 'read':return clips.full(ids[0]);case 'delete':{const removable=selected.filter(x=>!x.favorite&&!x.tags?.length).map(x=>x.id);const list=await clips.delete(removable);changedClipboard();return list;}case 'clear':{const list=await clips.delete(clips.records.filter(x=>payload.includeFavorites||!x.favorite).map(x=>x.id));changedClipboard();return list;}
 case 'favorite':clips.change(ids,x=>{x.favorite=payload.value??!x.favorite;if(x.favorite&&!x.tags.includes('收藏'))x.tags.push('收藏');if(!x.favorite)x.tags=x.tags.filter(t=>t!=='收藏');});changedClipboard();return clips.list();
 case 'newTag':case 'renameTag':case 'deleteTag':case 'tagColor':{const pref=settings.clipboardPreferences,tag=String(payload.tag||'').trim(),name=String(payload.name||payload.tag||'').trim();if(action!=='deleteTag'&&(!name||name.length>30))throw Error('标签名称须为 1 至 30 个字');if(action==='newTag'){if(!pref.pinboards.includes(name))pref.pinboards.push(name);pref.pinboardColors[name]=payload.color||'blue';}else if(action==='renameTag'){if(pref.pinboards.includes(name)&&name!==tag)throw Error('标签已存在');pref.pinboards=pref.pinboards.map(x=>x===tag?name:x);pref.pinboardColors[name]=pref.pinboardColors[tag]||'blue';delete pref.pinboardColors[tag];clips.change(clips.records.map(x=>x.id),x=>{x.tags=x.tags.map(t=>t===tag?name:t);});}else if(action==='deleteTag'){pref.pinboards=pref.pinboards.filter(x=>x!==tag);delete pref.pinboardColors[tag];clips.change(clips.records.map(x=>x.id),x=>{x.tags=x.tags.filter(t=>t!==tag);x.favorite=x.tags.length>0;});}else pref.pinboardColors[tag]=String(payload.color||'blue');await store.write('settings',settings);broadcast('settings-changed',settings);changedClipboard();return settings;}
 case 'tag':clips.change(ids,x=>{x.tags=payload.remove?x.tags.filter(t=>t!==payload.tag):[...new Set([...x.tags,String(payload.tag)])];x.favorite=x.tags.length>0;});changedClipboard();return clips.list();
 case 'copy':case 'paste':{let record;if(selected.length===1)record=await clips.full(selected[0].id);else if(selected.length>1){const all=await Promise.all(selected.map(x=>clips.full(x.id)));if(all.every(x=>x.kind==='files')){const files=[...new Set(all.flatMap(x=>x.files||[]))];record={kind:'files',files,text:files.join('\n'),value:files.join('\n')};}else{const text=all.map(x=>x.text||x.value).join(payload.separator??'\n');record={kind:'text',text,value:text};}}if(!record)return false;if(action==='paste'&&settings.clipboardPreferences.directPaste)return pasteRecord(record,payload.plain?true:undefined);await writeRecord(record,!!payload.plain);return true;}
 case 'merge':{const records=await Promise.all(selected.map(x=>clips.full(x.id)));if(records.length<2||records.some(x=>x.kind==='image'))throw Error('请选择至少两条文本记录');const text=records.map(x=>x.text??x.value??'').join(payload.separator??'\n');const record=await clips.add({kind:'text',text,value:text,sourceName:'OpenAll',sourceIcon:await fileIcon(process.execPath,true)});if(!record)throw Error('合并内容超过剪贴板单条大小限制');changedClipboard();return record;}
 case 'editPaste':{const text=String(payload.text??'');if(Buffer.byteLength(text)>settings.clipboardPreferences.maxItemBytes)throw Error('文本超过剪贴板单条大小限制');return pasteRecord({kind:'text',text,value:text},true);}
 case 'selection':{
  const sender = windowFor(event);
  const context = currentContext(sender);
  const fromPreview = context.page === 'clipboardPreview';
  const record = fromPreview ? context.initialValue : await clips.full(ids[0]);
  if (!record?.kind || (fromPreview && record.id !== ids[0] && record.hash !== ids[0])) return false;
  let content;
  if (record.kind === 'files') content = {kind:'files', files:record.files};
  else if (record.kind === 'image') content = {kind:'image', dataUrl:record.dataUrl || 'data:image/png;base64,' + record.value};
  else content = {kind:'text', text:record.text ?? record.value};
  await createWindow('selection', content);
  if (fromPreview && currentContext(sender) === context) {
   windows.get('clipboard')?.hide();
   sender.close();
  }
  return true;
 }
 case 'drag':case 'startDrag':{const records=await Promise.all(selected.map(x=>clips.full(x.id)));const files=[];for(const record of records){if(record.kind==='files')files.push(...record.files);else if(record.kind==='image'){const file=path.join(clips.directory,record.hash+'.png');if(!fs.existsSync(file))await fsp.writeFile(file,Buffer.from(record.value,'base64'));files.push(file);}}if(!files.length)return false;const icon=nativeImage.createFromPath(path.join(__dirname,'../assets/icon.png')).resize({width:32,height:32});event.sender.startDrag({files:[...new Set(files)],icon});return true;}
 case 'preview':{const record=await clips.full(ids[0]);if(record)await createWindow('clipboardPreview',record);return !!record;}
 case 'pastePreview':{
  const context=currentContext(windowFor(event));
  if(context.page!=='clipboardPreview'||!context.initialValue?.kind)return false;
  return pasteRecord(context.initialValue);
 }
 case 'compare':{if(selected.length!==2)throw Error('请选择两条文本卡片');const values=await Promise.all(selected.map(x=>clips.full(x.id)));if(values.some(x=>x.kind==='image'||x.kind==='files'))throw Error('请选择两条文本卡片');await createWindow('comparison',{left:values[0].text||values[0].value,right:values[1].text||values[1].value});return true;}
 case 'snippet':{const record=await clips.full(ids[0]);if(!record||!record.text)throw Error('此卡片没有文本');const item=snippetStore.save({keyword:'clip'+Date.now().toString(36),name:record.title.slice(0,32),body:record.text});updateSearch();return item;}
 case 'ocr':{const record=await clips.full(ids[0]);if(record?.kind!=='image')throw Error('请选择图片');const result=await recognizeImage(Buffer.from(record.value,'base64'));clips.change(ids,x=>{x.ocrText=result.text;x.recognizedText=result.text;});changedClipboard();return result;}
 case 'openWith':{const record=await clips.full(ids[0]);if(!record?.files?.length)throw Error('请选择文件卡片');return fileAction(event,'openWith',{path:record.files[0]});}
 case 'openTool':{const record=await clips.full(ids[0]);await createWindow(payload.page||'json',record?.text||record?.value||'');return true;}
 default:throw Error('未知剪贴板操作');}
}
function registerIPC(){
 const trustedGold=(event,page='gold')=>{const win=windows.get(page);return !app.isQuitting&&win&&!win.isDestroyed()&&event.sender===win.webContents&&event.senderFrame===win.webContents.mainFrame;};
 const authorizeGold=(event,page)=>{if(!trustedGold(event,page))throw Error('金价操作仅允许对应工具页面的主框架调用');};
 ipcMain.handle('openall:gold-read',async event=>{authorizeGold(event);return (await getGoldService()).snapshot();});
 ipcMain.handle('openall:gold-action',async(event,name,payload)=>{
  authorizeGold(event);
  const service=await getGoldService();
  authorizeGold(event);
  const action=({'edge-setting':'edge','source-link':'source','open-source':'source','event-link':'event','quit-window':'close','theme':'appearance'})[name]||name;
  if(['pin','layout','currency','view','edge'].includes(action)){service.update(action,payload);goldWindowController.update(action);return service.snapshot();}
  if(action==='minimize'){windows.get('gold').minimize();return true;}
  if(action==='close'){windows.get('gold').close();return true;}
  if(action==='source')return service.openSource(payload);
  if(action==='event')return service.openEvent(payload);
  if(action==='appearance'){await createWindow('settings','appearance');return true;}
  if(action==='drag')return true;
  if(action==='recheck-network'){service.checkNetwork();return service.snapshot();}
  throw Error('未知金价操作');
 });
 ipcMain.handle('openall:gold-rail-read',async event=>{authorizeGold(event,'gold-rail');return (await getGoldService()).snapshot().theme;});
 ipcMain.handle('openall:gold-rail-expand',event=>{authorizeGold(event,'gold-rail');goldWindowController.expand();return true;});
 ipcMain.handle('get-settings',()=>settings);
 ipcMain.handle('set-settings',async(_event,next)=>{
   const old=settings, merged=normalizeSettings({...settings, ...next,
     clipboardPreferences:{...settings.clipboardPreferences, ...next?.clipboardPreferences}});
   const failed=applyShortcuts(merged);if(failed.length){applyShortcuts(old);return {ok:false,failed};}settings=merged;await store.write('settings',settings);if(!testMode)app.setLoginItemSettings({openAtLogin:!!settings.launchAtLogin});clips.cleanup();for(const open of windows.values())if(!transient.has(currentContext(open).page)&&!['gold','gold-rail'].includes(currentContext(open).page))open.setBackgroundColor(settings.backgroundHex);await goldServiceReady?.then(service=>service.publish());broadcast('settings-changed',settings);const changed=['chromeBookmarks','chromeHistory','chromePath','searchFiles','fileSearchFolders'].some(k=>JSON.stringify(old[k])!==JSON.stringify(settings[k]));if(changed)searchWorker.call('init',{settings,ranking,snippets:snippetStore.items,testMode}).catch(notifyError);else updateSearch();return {ok:true};});
 ipcMain.handle('search',(_event,query)=>searchWithIcons(query));
 ipcMain.handle('open',(event,item)=>openItem(item,event));
 ipcMain.handle('open-tool',(_event,page,value)=>createWindow(page,value).then(()=>true));
 ipcMain.handle('get-clipboard',()=>clips.list());
 ipcMain.handle('copy-item',(_event,item)=>writeRecord(item));
 ipcMain.handle('delete-item',async(_event,hash)=>{const record=clips.records.find(x=>x.hash===hash);const values=await clips.delete(record&&!record.favorite&&!record.tags?.length?[hash]:[]);changedClipboard();return values;});
 ipcMain.handle('copy-text',(_event,text)=>{putText(text);return true;});
 ipcMain.handle('read-text',()=>getText());
 ipcMain.handle('choose-file',event=>fileAction(event,'openText'));
 ipcMain.handle('file-action',fileAction);
 ipcMain.handle('window-action',windowAction);
 ipcMain.handle('clipboard-action',clipboardAction);
 ipcMain.handle('stack-action',(_event,action,payload)=>stackAction(action,payload));
 ipcMain.handle('selection-action',async(event,action,payload={})=>{if(action==='get')return currentContext(windowFor(event)).initialValue||{};if(action==='order'){if(payload.order){settings.actionOrder={...settings.actionOrder,[payload.category]:payload.order};await store.write('settings',settings);broadcast('settings-changed',settings);}return settings.actionOrder?.[payload.category]||[];}if(action==='capture')return captureSelection();if(action==='paste')return pasteRecord({kind:'text',text:String(payload.text||''),value:''});if(action==='tool'){await createWindow(payload.page,payload.text||payload);return true;}if(action==='copy'){putText(payload.text||'');return true;}if(action==='snippet'){const item=snippetStore.save({keyword:'selected'+Date.now().toString(36),name:String(payload.text||'').slice(0,32),body:payload.text});updateSearch();return item;}throw Error('未知选中内容操作');});
 ipcMain.handle('snippets-action',(_event,action,payload={})=>{if(action==='list')return snippetStore.items;if(action==='save'){const item=snippetStore.save(payload);updateSearch();return item;}if(action==='delete'){const items=snippetStore.remove(payload.id);updateSearch();return items;}if(action==='expand'){const item=snippetStore.items.find(x=>x.id===payload.id);const expand=payload.parts?snippetExpansionParts:expandSnippet;return expand(payload.body??item?.body??'',getText());}throw Error('未知片段操作');});
 ipcMain.handle('diagnostics',()=>({version:app.getVersion(),platform:process.platform,arch:process.arch,shortcuts:shortcutsStatus,shortcutRecording:shortcutRecording.active,registeredShortcuts:registeredShortcuts(),nativeReady:native.ready,nativeError:native.error,clipboardCount:clips.records.length,snippetCount:snippetStore.items.length,stack:clips.stackInfo(),index:searchStatus,applications:searchStatus.apps||0,files:searchStatus.files||0,profiles:searchStatus.profiles||0,indexing:searchStatus.indexing||false,memoryMB:Math.round(process.memoryUsage().rss/1048576),updates:updater.status(),dataDirectory:app.getPath('userData')}));
 ipcMain.handle('ocr',async(_event,payload)=>recognizeImage(dataBuffer(payload.dataUrl)));
 ipcMain.handle('backend-task',(_event,action,args)=>backendWorker.call(action,{args}));
}
app.whenReady().then(async()=>{
 searchWorker=new WorkerClient('search-worker.js',60000);backendWorker=new WorkerClient('native-task-worker.js',30000);imageWorker=new WorkerClient('native-image-worker.js',60000);workers.push(searchWorker,backendWorker,imageWorker);
 searchWorker.on('index',status=>{searchStatus=status;broadcast('search-updated',status);});
 native.on('foreground',value=>{if(value.pid!==process.pid&&value.pid!==native.child?.pid&&value.handle!=='0')lastExternal=value;});
 native.on('ready',()=>{if(settings.searchShortcutMode==='double')shortcutsStatus.search=true;});
 if(!testMode)native.on('clipboard',captureClipboard);
 native.on('doubleTap',modifier=>{if(shortcutRecording.allowsDoubleTap()&&settings.searchShortcutMode==='double'&&modifier===settings.doubleTap)togglePage('search').catch(notifyError);});
 registerIPC();
 const initialIndex=searchWorker.call('init',{settings,ranking,snippets:snippetStore.items,testMode});if(testMode)await initialIndex;else initialIndex.catch(notifyError);
 if(smokeMode){const win=await createWindow('search','',{hidden:true}),errors=[];win.webContents.on('preload-error',(_event,_file,error)=>errors.push(error.message));win.webContents.on('render-process-gone',(_event,details)=>errors.push(details.reason));const timeout=setTimeout(()=>app.exit(1),180000);try{win.show();await require('./ci-smoke')(win,path.resolve(process.env.OPENALL_SMOKE_OUTPUT||path.join(app.getPath('userData'),'smoke')),app.getVersion(),errors);clearTimeout(timeout);app.exit(0);}catch(error){console.error(error.stack);clearTimeout(timeout);app.exit(1);}return;}
 if(!testMode){native.start();applyShortcuts(settings);monitor=setInterval(()=>{if(!native.ready)captureClipboard();},500);refreshTimer=setInterval(()=>searchWorker.call('init',{settings,ranking,snippets:snippetStore.items,testMode}).catch(notifyError),90000);}
 const icon=nativeImage.createFromPath(path.join(__dirname,'../assets/icon.png')).resize({width:16,height:16});tray=new Tray(icon);tray.setToolTip('OpenAll');tray.setContextMenu(Menu.buildFromTemplate([{label:'打开搜索',click:()=>showPage('search')},{label:'剪贴板抽屉',click:()=>showPage('clipboard')},{label:'复制堆栈',click:()=>stackAction('start')},{label:'对选中内容操作',click:()=>captureSelection().catch(notifyError)},{type:'separator'},{label:'设置…',click:()=>createWindow('settings')},{label:'退出 OpenAll',click:()=>{app.isQuitting=true;app.quit();}}]));tray.on('click',()=>showPage('search'));
 await createWindow('search');
}).catch(error=>{console.error(error.stack);app.exit(1);});
app.on('window-all-closed',()=>{});
let flushedBeforeQuit=false;app.on('before-quit',event=>{app.isQuitting=true;if(!flushedBeforeQuit){event.preventDefault();Promise.allSettled([captureWrites.then(()=>store.flush()),goldServiceReady?.then(service=>{goldWindowController?.dispose();service.dispose();})]).finally(()=>{flushedBeforeQuit=true;app.quit();});}});
app.on('will-quit',()=>{clearInterval(monitor);clearInterval(refreshTimer);globalShortcut.unregisterAll();native.stop();for(const worker of workers)worker.close();});
