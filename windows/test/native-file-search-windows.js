'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {NativeFileSearch,mergeFiles}=require('../src/native-file-search');

// 不修改服务、索引范围或用户文件；空结果探针验证真实 SQL 及 KnownFolders。
(async()=>{
  if(process.platform!=='win32'){console.log('SKIP Windows Search 自测仅在 Windows 运行');return;}
  const bridge=new NativeFileSearch({timeout:15000}),report={platform:process.platform,knownFolders:false,systemIndex:null,checks:[]};
  const output=path.resolve('artifacts/native-file-search/report.json');
  try{
    const folders=await bridge.knownFolders();assert.equal(folders.available,true,JSON.stringify(folders.errors));
    for(const name of ['Desktop','Documents','Downloads','Pictures','Videos','Music']){const folder=folders.folders.find(item=>item.name===name);assert.ok(folder&&path.win32.isAbsolute(folder.path),'KnownFolder 缺失：'+name);}
    report.knownFolders=true;report.knownFolderNames=folders.folders.map(item=>item.name);report.checks.push('真实 Shell KnownFolders API，包含当前重定向路径');
    const result=await bridge.probe();report.systemIndex={available:result.available,code:result.code,reason:result.reason,indexedOnly:result.indexedOnly};
    assert.equal(result.indexedOnly,true);assert.deepEqual(result.items,[]);
    if(result.available){
      assert.equal(result.code,'ready');
      const token=crypto.randomUUID(),tests=[{term:"OpenAll-"+token+"_中文'[%]"},{term:'OpenAll-'+token,kind:'documents'},{term:'OpenAll-'+token,kind:'images'},{term:'OpenAll-'+token,kind:'extension',extension:'tar.gz'},{term:'OpenAll-'+token,folders:[os.tmpdir()]}];
      for(const request of tests){const response=await bridge.query(request);assert.equal(response.available,true,response.code+': '+response.reason);assert.deepEqual(response.items,[]);}
      report.checks.push('真实 SystemIndex 查询：精确、包含、通配符转义、中文、文档、图片、复合后缀与目录范围');
      console.log('PASS Windows Search SystemIndex 查询与 KnownFolders');
    }else{
      // 服务缺失/停用是平台边界；运行中的服务若 SQL 或 COM 失败则必须阻断 CI。
      assert.ok(['service-missing','service-stopped'].includes(result.code),result.code+': '+result.reason);
      report.checks.push('Windows Search 服务不可用，已验证明确状态；真实索引查询未执行');
      console.log('SKIP SystemIndex 真实查询：'+result.code+'；PASS KnownFolders 与明确 fallback 状态');
    }
    const local={type:'file',title:'OpenAll-fallback.json',value:path.win32.join(os.tmpdir(),'OpenAll-fallback.json')};assert.deepEqual(mergeFiles(result.items,[local]),[local]);report.checks.push('索引空/不可用时保留本地 fallback 结果');report.passed=true;
  }catch(error){report.passed=false;report.error=error.stack;throw error;}
  finally{bridge.close();fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2));}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
