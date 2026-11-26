// Windows 专用：测试窗口和剪贴板均由助手创建并在结束后恢复。
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {NativeBridge,recognizeImage}=require('../src/native-services');
(async()=>{
 if(process.platform!=='win32'){console.log('Windows 原生验证仅在 Windows 运行');return;}
 const bridge=new NativeBridge(),report={passed:false,startedAt:new Date().toISOString(),stages:[],checks:[]};
 const output=process.env.OPENALL_NATIVE_REPORT||path.join(process.cwd(),'artifacts','native-windows-report.json');
 bridge.on('boot',stage=>{report.stages.push(stage);console.log(`Windows helper boot: ${stage.stage} ${stage.elapsedMS} ms`);});
 try{
  bridge.start();report.ready=await bridge.waitUntilReady();console.log(`Windows helper ready: ${report.ready.elapsedMS} ms`);
  const result=await bridge.request('selfTest');for(const key of['paste','pasteTargetGuard','selection','files','image']){assert.equal(result[key],true);report.checks.push(key);console.log(`PASS Windows ${key}`);}
  assert.equal(result.inputSize,process.arch==='x64'?40:28);const ocr=await recognizeImage(Buffer.from(result.ocrImage,'base64'));assert.match(ocr.text,/OPENALL/i);assert.match(ocr.text,/12345/);report.checks.push('ocr');report.passed=true;console.log('PASS Windows OCR: '+ocr.text.replace(/\s+/g,' '));
 }catch(error){report.error=error.stack;throw error;}
 finally{report.startup=bridge.startup;report.stderr=bridge.error;bridge.stop();fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2));console.log('原生验证报告：'+output);}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
