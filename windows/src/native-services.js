const { EventEmitter } = require('node:events');
const { spawn, execFile } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const readline = require('node:readline');

// 原生助手仅交换 JSON 数据，不拼接用户内容为 PowerShell 代码。
class NativeBridge extends EventEmitter {
 constructor({spawnProcess=spawn,platform=process.platform,readyTimeout=45000,operationTimeout=8000}={}){super();this.spawnProcess=spawnProcess;this.platform=platform;this.readyTimeout=readyTimeout;this.operationTimeout=operationTimeout;this.child=null;this.pending=new Map();this.counter=0;this.ready=false;this.error='';this.startupFailure=null;this.startup={stage:'not-started',elapsedMS:0,pid:null};this.foreground={handle:'0',pid:0,name:''};}
 start(){
  if(this.platform!=='win32'||this.child)return this.child;
  let script=path.join(__dirname,'native-bridge.ps1').replace('app.asar'+path.sep,'app.asar.unpacked'+path.sep);if(!fs.existsSync(script))script=path.join(__dirname,'native-bridge.ps1');
  this.ready=false;this.error='';this.startupFailure=null;this.startedAt=Date.now();this.startup={stage:'spawn',elapsedMS:0,pid:null};
  const child=this.child=this.spawnProcess('powershell.exe',['-NoProfile','-NonInteractive','-STA','-ExecutionPolicy','Bypass','-File',script],{windowsHide:true,stdio:['pipe','pipe','pipe']});this.startup.pid=child.pid||null;
  child.on('error',error=>{if(this.child!==child)return;this.error=error.message;this.startupFailure=error;this.fail(error);this.emit('startup-failed',error);});
  child.on('exit',(code,signal)=>{if(this.child!==child)return;this.child=null;this.ready=false;this.startup={...this.startup,elapsedMS:Date.now()-this.startedAt,exitCode:code,signal};const error=Error(`Windows 原生助手已退出（code=${code}, signal=${signal||'none'}, stage=${this.startup.stage}）${this.error?'：'+this.error:''}`);this.startupFailure=error;this.error=error.message;this.fail(error);this.emit('startup-failed',error);});
  child.stdin.on('error',error=>{if(this.child!==child)return;this.error=error.message;this.fail(error);});
  child.stderr.on('data',chunk=>{if(this.child===child)this.error=(this.error+chunk.toString()).slice(-2000);});
  readline.createInterface({input:child.stdout}).on('line',line=>{
   if(this.child!==child)return;let message;try{message=JSON.parse(line.replace(/^\uFEFF/,''));}catch{return;}
   if(message.event){if(message.event==='boot'||message.event==='ready')this.startup={...this.startup,stage:message.event==='ready'?'ready':message.data.stage,elapsedMS:Date.now()-this.startedAt,helperElapsedMS:message.data.elapsedMS};if(message.event==='ready')this.ready=true;if(message.event==='foreground')this.foreground=message.data;this.emit(message.event,message.event==='boot'?{...this.startup}:message.data);return;}
   const request=this.pending.get(message.id);if(!request)return;this.pending.delete(message.id);clearTimeout(request.timer);message.error?request.reject(Error(message.error)):request.resolve(message.result);
  });return child;
 }
 // 冷启动和功能操作分开计时；提前退出立即失败，不再伪装成等待 ready 超时。
 waitUntilReady(timeout=this.readyTimeout){if(this.ready)return Promise.resolve({...this.startup});if(this.startupFailure)return Promise.reject(this.startupFailure);if(!this.child)return Promise.reject(Error('Windows 原生助手尚未启动'));return new Promise((resolve,reject)=>{const cleanup=()=>{clearTimeout(timer);this.removeListener('ready',ready);this.removeListener('startup-failed',failed);};const ready=()=>{cleanup();resolve({...this.startup});},failed=error=>{cleanup();reject(error);};const timer=setTimeout(()=>failed(Error(`Windows 原生助手启动超时（${Date.now()-this.startedAt} ms，stage=${this.startup.stage}，pid=${this.startup.pid||'unknown'}）${this.error?'：'+this.error:''}`)),timeout);this.on('ready',ready);this.on('startup-failed',failed);});}
 fail(error){for(const request of this.pending.values()){clearTimeout(request.timer);request.reject(error);}this.pending.clear();}
 async request(action,payload={}){await this.waitUntilReady();const child=this.child;if(!child||!this.ready)throw Error('Windows 原生助手已退出');return new Promise((resolve,reject)=>{const id=++this.counter,timer=setTimeout(()=>{this.pending.delete(id);reject(Error('Windows 操作超时'));},this.operationTimeout);this.pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,action,payload})+'\n',error=>{if(!error)return;const request=this.pending.get(id);if(request){this.pending.delete(id);clearTimeout(request.timer);request.reject(error);}});});}
 stop(){const child=this.child;this.child=null;this.ready=false;const error=Error('应用已退出');this.startupFailure=error;this.fail(error);this.emit('startup-failed',error);child?.kill();}
}
class WorkerClient extends EventEmitter {
 constructor(file,timeout=30000){super();this.file=file;this.timeout=timeout;this.counter=0;this.pending=new Map();this.closed=false;this.start();}
 start(){const worker=this.worker=new Worker(path.join(__dirname,this.file));worker.on('message',message=>{if(message.event){this.emit(message.event,message.data);return;}const req=this.pending.get(message.id);if(!req)return;this.pending.delete(message.id);clearTimeout(req.timer);message.error?req.reject(Error(message.error)):req.resolve(message.result);});worker.on('error',error=>{if(worker===this.worker)this.fail(error instanceof Error?error:Error(error.message||String(error)));});worker.on('exit',code=>{if(!this.closed&&worker===this.worker){this.fail(Error(`处理进程意外结束（${code}）`));this.start();}});}
 fail(error){for(const req of this.pending.values()){clearTimeout(req.timer);req.reject(error);}this.pending.clear();}
 call(action,payload={}){return new Promise((resolve,reject)=>{const id=++this.counter;const timer=setTimeout(()=>{this.fail(Error('内容处理超时，请缩小输入或检查规则'));this.worker.terminate();this.start();},this.timeout);this.pending.set(id,{resolve,reject,timer});this.worker.postMessage({id,action,...payload});});}
 close(){this.closed=true;this.fail(Error('应用已退出'));this.worker.terminate();}
}
async function recognizeImage(buffer){if(process.platform!=='win32')throw Error('OCR 使用 Windows 文字识别服务');const dir=await fs.promises.mkdtemp(path.join(os.tmpdir(),'OpenAllOCR-')),file=path.join(dir,'image.png');await fs.promises.writeFile(file,buffer);try{return await new Promise((resolve,reject)=>{let script=path.join(__dirname,'native-ocr.ps1').replace('app.asar'+path.sep,'app.asar.unpacked'+path.sep);if(!fs.existsSync(script))script=path.join(__dirname,'native-ocr.ps1');execFile('powershell.exe',['-NoProfile','-NonInteractive','-STA','-ExecutionPolicy','Bypass','-File',script,'-ImagePath',file],{windowsHide:true,timeout:45000,maxBuffer:8_000_000,encoding:'utf8'},(error,stdout,stderr)=>{if(error)return reject(Error(stderr.trim()||error.message));try{resolve(JSON.parse(stdout.trim().replace(/^\uFEFF/,'')));}catch{reject(Error('OCR 未返回有效结果'));}});});}finally{await fs.promises.rm(dir,{recursive:true,force:true});}}
module.exports={NativeBridge,WorkerClient,recognizeImage};
