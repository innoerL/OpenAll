'use strict';
importScripts('./id-regions.js','../src/tool-core.js');
self.onmessage=event=>{const {id,action,args=[]}=event.data;try{let result;if(action==='markdown'){if(!self.marked)importScripts('./marked.umd.js');result=self.marked.parse(args[0]);}else{const fn=self.OpenAllTools[action];if(typeof fn!=='function')throw Error('未知工具操作');result=fn(...args);}self.postMessage({id,result});}catch(error){self.postMessage({id,error:error.message});}};
