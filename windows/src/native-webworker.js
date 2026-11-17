const { Worker: NodeWorker, parentPort, workerData } = require('node:worker_threads');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
// 为 libheif 的 pthread 模块提供 Web Worker 协议，图像编码始终离开 Electron 主线程。
function installWorkerEnvironment(name='openall-image-worker',url=pathToFileURL(__filename).href){
 globalThis.self=globalThis;globalThis.name=name;globalThis.location={href:url};globalThis.importScripts=()=>{};
 globalThis.postMessage=(message,transfer)=>parentPort.postMessage(message,transfer);
 globalThis.Worker=class {
  constructor(workerURL,options={}){this.worker=new NodeWorker(__filename.replace('app.asar'+path.sep,'app.asar.unpacked'+path.sep),{workerData:{codecURL:String(workerURL),name:options.name||''}});this.worker.on('message',data=>this.onmessage?.({data}));this.worker.on('error',error=>this.onerror?.({message:error.message,error}));}
  postMessage(data,transfer){this.worker.postMessage(data,transfer);}
  terminate(){return this.worker.terminate();}
  addEventListener(name,callback){if(name==='message')this.worker.on('message',data=>callback({data}));else if(name==='error')this.worker.on('error',callback);}
 };
}
if(workerData?.codecURL){installWorkerEnvironment(workerData.name,workerData.codecURL);const pending=[];let handler;Object.defineProperty(globalThis,'onmessage',{configurable:true,get:()=>handler,set:value=>{handler=value;queueMicrotask(()=>{while(pending.length&&handler)handler({data:pending.shift()});});}});parentPort.on('message',data=>handler?handler({data}):pending.push(data));import(workerData.codecURL).catch(error=>{throw error;});}
module.exports={installWorkerEnvironment};
