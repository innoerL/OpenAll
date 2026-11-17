'use strict';
const {spawn}=require('node:child_process');
const {EventEmitter}=require('node:events');
const readline=require('node:readline');
const fs=require('node:fs');
const path=require('node:path');
const {documents,images,matchesFile}=require('./search-engine');

// SQL 标识符来自固定模板；用户文本只作为转义后的字符串字面量。
const sqlString=value=>"'"+String(value).replace(/'/g,"''")+"'";
const literalPattern=value=>String(value).replace(/[\[\]%_]/g,character=>({'[':'[[]',']':'[]]','%':'[%]','_':'[_]'})[character]);
function normalizeRequest(input={}){
  const term=String(input.term??'');if(term.length>512||/[\u0000-\u001f]/.test(term))throw Error('文件搜索词不能超过 512 字符或包含控制字符');
  const kind=input.kind||'all';if(!['all','documents','images','extension'].includes(kind))throw Error('未知文件搜索类型');
  const extension=String(input.extension||'').replace(/^\./,'').toLowerCase();if(kind==='extension'&&(!/^[a-z0-9_+][a-z0-9_+.-]{0,31}$/.test(extension)||extension.endsWith('.')))throw Error('无效的文件后缀');
  const folders=(input.folders||[]).map(value=>String(value));if(folders.length>32||folders.some(value=>value.length>4096||/[\u0000-\u001f]/.test(value)||!path.win32.isAbsolute(value)))throw Error('搜索目录必须是有效的 Windows 绝对路径');
  return {term,kind,extension,exact:input.exact===true,limit:Math.max(1,Math.min(1000,Math.floor(Number(input.limit)||200))),folders};
}
function buildQuery(input={}){
  const request=normalizeRequest(input),clauses=["System.ItemUrl LIKE 'file:%'"];
  if(request.term)clauses.push('System.FileName '+(request.exact?'= '+sqlString(request.term):'LIKE '+sqlString('%'+literalPattern(request.term)+'%')));
  const suffixes=request.kind==='documents'?[...documents]:request.kind==='images'?[...images]:request.kind==='extension'?[request.extension]:[];
  if(suffixes.length)clauses.push('('+suffixes.map(suffix=>'System.FileName LIKE '+sqlString('%.'+literalPattern(suffix))).join(' OR ')+')');
  // SCOPE 只在用户明确限定目录时加入；默认覆盖 SystemIndex 中全部可访问文件。
  if(request.folders.length)clauses.push('('+request.folders.map(folder=>{const normalized=folder.replace(/\\/g,'/');return 'SCOPE = '+sqlString('file:'+(/^[a-z]:\/$/i.test(normalized)?normalized:normalized.replace(/\/$/,'')));}).join(' OR ')+')');
  return 'SELECT TOP '+(request.limit+1)+' System.ItemPathDisplay, System.FileName, System.ItemType, System.FileAttributes FROM SYSTEMINDEX WHERE '+clauses.join(' AND ')+' ORDER BY System.FileName ASC';
}
function normalizeRows(rows,input={}){
  const request=normalizeRequest(input),seen=new Set(),items=[];
  for(const row of rows||[]){const value=String(row.path||row['System.ItemPathDisplay']||'');if(!value||!path.win32.isAbsolute(value))continue;const title=String(row.name||row['System.FileName']||path.win32.basename(value)),attributes=Number(row.attributes??row['System.FileAttributes']??0),isDirectory=(attributes&16)!==0||row.itemType==='Directory';const key=value.toLowerCase();if(seen.has(key))continue;seen.add(key);
    const item={type:'file',title,value,isDirectory,detail:(isDirectory?'文件夹':'文件')+' · '+path.win32.dirname(value),rank:58,symbol:isDirectory?'folder':'file',source:'windows-search'};
    if(!matchesFile(item,request))continue;if(request.term&&(request.exact?title.toLocaleLowerCase()!==request.term.toLocaleLowerCase():!title.toLocaleLowerCase().includes(request.term.toLocaleLowerCase())))continue;items.push(item);
  }
  return {items:items.slice(0,request.limit),truncated:items.length>request.limit||(rows||[]).length>request.limit};
}
function mergeFiles(primary=[],fallback=[]){const seen=new Set();return [...primary,...fallback].filter(item=>{const key=String(item.value||'').toLowerCase();if(!key||seen.has(key))return false;seen.add(key);return true;});}
const unavailable=(code,reason)=>({available:false,source:'windows-search',indexedOnly:true,items:[],truncated:false,code,reason});

class NativeFileSearch extends EventEmitter{
  constructor(options={}){super();this.platform=options.platform||process.platform;this.spawn=options.spawn||spawn;this.transport=options.transport;this.timeout=options.timeout||7000;this.pending=new Map();this.counter=0;this.child=null;this.closed=false;this.negative=null;this.status=unavailable('not-queried','尚未查询 Windows Search');}
  start(){
    if(this.child||this.closed||this.platform!=='win32')return;
    let script=path.join(__dirname,'native-file-search.ps1').replace('app.asar'+path.sep,'app.asar.unpacked'+path.sep);if(!fs.existsSync(script))script=path.join(__dirname,'native-file-search.ps1');
    const executable=path.win32.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    const child=this.spawn(executable,['-NoLogo','-NoProfile','-NonInteractive','-STA','-ExecutionPolicy','Bypass','-File',script],{windowsHide:true,stdio:['pipe','pipe','pipe']});this.child=child;
    child.on('error',error=>this.fail(error,child));child.on('exit',()=>this.fail(Error('Windows Search 后台进程已退出'),child));child.stdin.on('error',error=>this.fail(error,child));child.stderr.on('data',chunk=>{this.lastError=String(chunk).slice(-2000);});
    readline.createInterface({input:child.stdout}).on('line',line=>{try{const message=JSON.parse(line.replace(/^\uFEFF/,'')),entry=this.pending.get(message.id);if(!entry)return;this.pending.delete(message.id);clearTimeout(entry.timer);message.error?entry.reject(Error(message.error)):entry.resolve(message.result);}catch(error){this.lastError=error.message;}});
  }
  fail(error,child=this.child){if(child!==this.child)return;this.child=null;for(const entry of this.pending.values()){clearTimeout(entry.timer);entry.reject(error);}this.pending.clear();child?.kill();}
  request(action,payload={}){
    if(this.closed)return Promise.reject(Error('文件搜索已关闭'));if(this.transport)return this.transport(action,payload);
    if(this.platform!=='win32')return Promise.reject(Error('此平台没有 Windows Search'));
    this.start();if(!this.child)return Promise.reject(Error('Windows Search 后台进程未启动'));if(this.pending.size>=4)return Promise.reject(Object.assign(Error('文件查询繁忙，当前使用本地索引'),{code:'query-busy'}));
    return new Promise((resolve,reject)=>{const id=++this.counter,timer=setTimeout(()=>this.fail(Error('Windows Search 查询超时，当前使用本地索引')),this.timeout);this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({id,action,payload})+'\n');});
  }
  async knownFolders(){try{return await this.request('knownFolders');}catch(error){return {available:false,paths:[],folders:[],errors:[error.message],code:this.platform==='win32'?'known-folders-unavailable':'unsupported-platform'};}}
  async query(input={}){
    let request,sql;try{request=normalizeRequest(input);sql=buildQuery(request);}catch(error){return unavailable('invalid-query',error.message);}
    if(this.platform!=='win32'&&!this.transport)return unavailable('unsupported-platform','此平台没有 Windows Search，使用本地文件索引');
    if(this.negative&&this.negative.until>Date.now())return this.negative.result;
    let result;try{const response=await this.request('query',{sql,limit:request.limit});result=response.available?{...response,...normalizeRows(response.rows,request),rows:undefined,source:'windows-search',indexedOnly:true}:unavailable(response.code||'provider-unavailable',response.reason||'Windows Search 不可用，使用本地文件索引');}
    catch(error){result=unavailable(error.code==='query-busy'?'query-busy':'query-unavailable',error.message);}
    this.status=result;if(result.available)this.negative=null;else if(result.code!=='query-busy')this.negative={until:Date.now()+10000,result};this.emit('status',result);return result;
  }
  async probe(){return this.query({term:'OpenAll-Index-Probe-'+require('node:crypto').randomUUID(),exact:true,limit:1});}
  close(){this.closed=true;this.fail(Error('文件搜索已关闭'));}
}
module.exports={NativeFileSearch,normalizeRequest,buildQuery,normalizeRows,mergeFiles,literalPattern,sqlString};
