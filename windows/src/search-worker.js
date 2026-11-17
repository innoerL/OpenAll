const { parentPort } = require('node:worker_threads');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const engine = require('./search-engine');
const {NativeFileSearch,mergeFiles}=require('./native-file-search');
const fileSearch=new NativeFileSearch();
const indexedCache=new Map(),fileInFlight=new Set();let fileTimer=null,latestFileKey='',isolated=false;
let generation=0,settings={},ranking={},snippets=[],profiles=[],status={indexing:false,apps:0,files:0,bookmarks:0,profiles:0,errors:[]};
let data={apps:[],files:[],bookmarks:[],history:[]};
const pause=()=>new Promise(resolve=>setImmediate(resolve));
function announce(){status={...status,apps:data.apps.length,files:data.files.length,bookmarks:data.bookmarks.length,profiles:profiles.length};parentPort.postMessage({event:'index',data:status});}
async function walk(root,maxDepth,limit,make,gen){const out=[],queue=[[root,0]];let processed=0;while(queue.length&&out.length<limit&&generation===gen){const [folder,depth]=queue.shift();let entries;try{entries=await fsp.readdir(folder,{withFileTypes:true});}catch{if(depth===0)status.errors.push(root);continue;}for(const entry of entries){if(entry.name.startsWith('.')||entry.isSymbolicLink())continue;const value=path.join(folder,entry.name);const item=make(entry,value,folder);if(item)out.push(item);if(entry.isDirectory()&&depth<maxDepth)queue.push([value,depth+1]);if(out.length>=limit)break;}if(++processed%20===0)await pause();}return out;}
async function index(next,testMode=false){const gen=++generation;settings=next;isolated=testMode;clearTimeout(fileTimer);indexedCache.clear();latestFileKey='';status.indexing=true;status.errors=[];announce();
 if(testMode){status.indexing=false;announce();return;}
 const roots=[process.env.APPDATA&&path.join(process.env.APPDATA,'Microsoft','Windows','Start Menu','Programs'),process.env.PROGRAMDATA&&path.join(process.env.PROGRAMDATA,'Microsoft','Windows','Start Menu','Programs')].filter(Boolean);
 const apps=[];for(const root of roots)apps.push(...await walk(root,6,10000,(e,value)=>!e.isDirectory()&&/\.(lnk|exe|url)$/i.test(e.name)?{type:'application',title:e.name.replace(/\.(lnk|exe|url)$/i,''),detail:'应用 · '+value,value,rank:70,symbol:'app'}:null,gen));
 if(gen!==generation)return;data.apps=apps;
 const base=next.chromePath?path.resolve(next.chromePath.replace(/^~/,os.homedir())):path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData/Local'),'Google/Chrome/User Data');
 profiles=[];const bookmarks=[];
 if(next.chromeBookmarks||next.chromeHistory){try{const chosen=['Bookmarks','History'].includes(path.basename(base))?path.dirname(base):base;const dirs=/^(Default|Profile \d+)$/.test(path.basename(chosen))?[chosen]:(await fsp.readdir(chosen,{withFileTypes:true})).filter(d=>d.isDirectory()&&/^(Default|Profile \d+)$/.test(d.name)).map(d=>path.join(chosen,d.name));for(const folder of dirs){profiles.push(folder);if(next.chromeBookmarks)try{const raw=JSON.parse(await fsp.readFile(path.join(folder,'Bookmarks'),'utf8'));const visit=node=>{if(node?.type==='url'&&/^https?:\/\//i.test(node.url||''))bookmarks.push({type:'url',title:node.name||node.url,detail:'Chrome 书签 · '+path.basename(folder)+' · '+node.url,value:node.url,rank:55,symbol:'bookmark'});for(const child of node?.children||[])visit(child);};for(const node of Object.values(raw.roots||{}))visit(node);}catch{}}}catch{status.errors.push(base);}}
 if(gen!==generation)return;data.bookmarks=bookmarks;announce();
 const files=[];if(next.searchFiles){const known=process.platform==='win32'?await fileSearch.knownFolders():null;if(gen!==generation)return;const paths=Array.isArray(next.fileSearchFolders)&&next.fileSearchFolders.length?next.fileSearchFolders:known?.paths?.length?known.paths:['Desktop','Documents','Downloads','Pictures','Videos'].map(x=>path.join(os.homedir(),x));status.fileRoots=paths;for(const root of paths){files.push(...await walk(root,10,Math.max(0,100000-files.length),(entry,value,folder)=>({type:'file',title:entry.name,detail:(entry.isDirectory()?'文件夹':'文件')+' · '+folder,value,isDirectory:entry.isDirectory(),rank:58,symbol:entry.isDirectory()?'folder':'file'}),gen));if(files.length>=100000)break;}}
 if(gen!==generation)return;data.files=files;status.indexing=false;announce();
}
async function history(query){if(!settings.chromeHistory||query.length<2)return [];const list=[];for(const folder of profiles){try{let rows;const filename=path.join(folder,'History');try{const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(filename,{readOnly:true});try{db.exec('PRAGMA busy_timeout=50');rows=db.prepare('SELECT title,url FROM urls WHERE hidden=0 ORDER BY last_visit_time DESC LIMIT 5000').all();}finally{db.close();}}catch{const init=await require('sql.js')();const bytes=await fsp.readFile(filename);if(bytes.length>150_000_000)continue;const db=new init.Database(bytes);try{const result=db.exec('SELECT title,url FROM urls WHERE hidden=0 ORDER BY last_visit_time DESC LIMIT 5000')[0];rows=(result?.values||[]).map(([title,url])=>({title,url}));}finally{db.close();}}for(const row of rows)if(/^https?:\/\//i.test(row.url||'')&&(engine.matches(row.title||'',query,settings.pinyinEnabled)||row.url.toLowerCase().includes(query))){list.push({type:'url',title:row.title||row.url,detail:'Chrome 历史 · '+path.basename(folder),value:row.url,rank:30,symbol:'history'});if(list.length>=60)return list;}}catch{}}return list;}
// 系统索引只在停止输入后查询；首屏立即使用本地缓存，慢查询完成后再更新结果。
function systemFiles(raw) {
 clearTimeout(fileTimer);latestFileKey='';
 if(isolated||process.platform!=='win32'||!settings.searchFiles)return [];
 const entered=String(raw).trim(),exact=entered.startsWith('='),query=(exact?entered.slice(1):entered).trim();
 if(!query||/^[?？;]/.test(query)||/^(应用|书签|历史|翻译|translate)\s/.test(query))return [];
 const reserved=engine.commands.flatMap(c=>[c.title,...c.keywords,...(settings.commandAliases?.[c.id]||[])]),filter=engine.fileRequest(query,reserved);
 if(!filter&&query.length<2)return [];
 const request={...(filter||{term:query,kind:'all'}),exact,limit:200,...(settings.fileSearchFolders?.length?{folders:settings.fileSearchFolders}:{})},key=JSON.stringify(request),cached=indexedCache.get(key);latestFileKey=key;
 if(cached&&cached.expires>Date.now())return cached.items;
 if(fileInFlight.has(key))return [];
 const gen=generation;
 fileTimer=setTimeout(async()=>{
   fileInFlight.add(key);let result;try{result=await fileSearch.query(request);}finally{fileInFlight.delete(key);}if(gen!==generation||!settings.searchFiles)return;
   indexedCache.set(key,{items:result.items||[],expires:Date.now()+10000});if(indexedCache.size>50)indexedCache.delete(indexedCache.keys().next().value);
   status.systemIndex={available:result.available,indexedOnly:true,truncated:result.truncated,code:result.code,reason:result.reason};
   if(latestFileKey===key)announce();
 },150);
 return [];
}
parentPort.on('close',()=>{clearTimeout(fileTimer);fileSearch.close();});
parentPort.on('message',async message=>{try{let result;switch(message.action){case 'init':ranking=message.ranking||{};snippets=message.snippets||[];await index(message.settings,message.testMode);result=status;break;case 'settings':settings=message.settings;ranking=message.ranking||ranking;snippets=message.snippets||snippets;result=true;break;case 'fixtures':data={...data,...message.data};announce();result=true;break;case 'search':{const q=String(message.query).replace(/^=/,'').replace(/^(历史|书签|应用) /,'').toLowerCase();data.history=await history(q);const extra=systemFiles(message.query);result=engine.search(message.query,{...data,files:mergeFiles(extra,data.files)},settings,ranking,snippets);break;}case 'status':result=status;break;default:throw Error('未知搜索操作');}parentPort.postMessage({id:message.id,result});}catch(error){parentPort.postMessage({id:message.id,error:error.message});}});
