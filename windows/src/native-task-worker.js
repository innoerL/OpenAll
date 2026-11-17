const { parentPort } = require('node:worker_threads');
parentPort.on('message',async({id,action,args})=>{try{const backend=require('./backend');if(typeof backend[action]!=='function')throw Error('未知工具操作');const result=await backend[action](...(Array.isArray(args)?args:[args]));parentPort.postMessage({id,result});}catch(error){parentPort.postMessage({id,error:error.message});}});
