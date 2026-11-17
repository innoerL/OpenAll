'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {PassThrough,Writable}=require('node:stream');
const {NativeFileSearch,normalizeRequest,buildQuery,normalizeRows,mergeFiles}=require('../src/native-file-search');

test('系统索引默认覆盖全部文件索引，并复用文档、图片与复合后缀规则',()=>{
  const query=buildQuery({term:'报告'});assert.match(query,/FROM SYSTEMINDEX/);assert.match(query,/System.ItemUrl LIKE 'file:%'/);assert.doesNotMatch(query,/SCOPE/);assert.match(query,/LIKE '%报告%'/);
  assert.match(buildQuery({kind:'documents'}),/LIKE '%\.xmind'/);assert.match(buildQuery({kind:'images'}),/LIKE '%\.heic'/);
  assert.match(buildQuery({kind:'extension',extension:'.tar.gz'}),/LIKE '%\.tar\.gz'/);
  assert.match(buildQuery({term:'报告.json',exact:true}),/System.FileName = '报告\.json'/);
  assert.match(buildQuery({limit:2}),/^SELECT TOP 3 /);
});

test('文件名与路径按 SQL 字面量转义，保留通配符原义',()=>{
  const query=buildQuery({term:"a'b%_[x]",folders:["C:\\OneDrive\\O'Brien\\资料"]});
  assert.ok(query.includes("LIKE '%a''b[%][_][[]x[]]%'"));
  assert.ok(query.includes("SCOPE = 'file:C:/OneDrive/O''Brien/资料'"));
  assert.ok(buildQuery({folders:['C:\\']}).includes("SCOPE = 'file:C:/'"));
  const injected="x' OR 1=1 -- $(Write-Host X) `x`";
  assert.ok(buildQuery({term:injected,exact:true}).includes("System.FileName = 'x'' OR 1=1 -- $(Write-Host X) `x`'"));
  assert.throws(()=>normalizeRequest({term:'a\nb'}));assert.throws(()=>normalizeRequest({term:'x'.repeat(513)}));
  assert.throws(()=>normalizeRequest({kind:'extension',extension:"json' OR 1=1"}));assert.throws(()=>normalizeRequest({kind:'extension',extension:'json.'}));assert.throws(()=>normalizeRequest({folders:['relative']}));
});

test('索引结果严格过滤文件类型、伪通配匹配、目录及重复路径',()=>{
  const rows=[
    {path:'C:\\资料\\a%_.json',name:'a%_.json',attributes:32},
    {path:'c:\\资料\\A%_.json',name:'A%_.json',attributes:32},
    {path:'C:\\资料\\a12.json',name:'a12.json',attributes:32},
    {path:'C:\\资料\\a%_.json目录',name:'a%_.json目录',attributes:16},
    {path:'C:\\资料\\a%_.pdf',name:'a%_.pdf',attributes:32},
    {path:'relative.json',name:'a%_.json',attributes:32}
  ];
  const result=normalizeRows(rows,{term:'a%_',kind:'extension',extension:'json'});assert.equal(result.items.length,1);assert.equal(result.items[0].title,'a%_.json');assert.equal(result.items[0].isDirectory,false);assert.equal(result.items[0].source,'windows-search');
  assert.equal(normalizeRows([{path:'C:\\folder.pdf',name:'folder.pdf',attributes:16}],{kind:'documents'}).items.length,0);
  assert.equal(normalizeRows([{path:'C:\\folder',name:'folder',attributes:16}],{kind:'all'}).items[0].isDirectory,true);
  assert.equal(normalizeRows(rows,{term:'a%_.JSON',exact:true}).items.length,1);
  assert.equal(normalizeRows(rows,{limit:1}).truncated,true);
});

test('系统索引和本地 fallback 按 Windows 路径去重，保留两种来源',()=>{
  const indexed={title:'报告',value:'C:\\Docs\\报告.pdf'},local={title:'报告',value:'c:\\docs\\报告.pdf'},unindexed={title:'新文件',value:'C:\\Other\\新文件.txt'};
  assert.deepEqual(mergeFiles([indexed],[local,unindexed]),[indexed,unindexed]);assert.deepEqual(mergeFiles([], [unindexed]),[unindexed]);
});

test('系统服务不可用有明确状态，负缓存避免重复启动，KnownFolders 独立可用',async()=>{
  let count=0;const bridge=new NativeFileSearch({platform:'win32',transport:async(action)=>{if(action==='knownFolders')return {available:true,paths:['D:\\OneDrive\\Documents'],folders:[{name:'Documents',path:'D:\\OneDrive\\Documents'}],errors:[]};count++;return {available:false,code:'service-stopped',reason:'Windows Search 服务未运行，使用本地文件索引'};}});
  const first=await bridge.query({term:'报告'}),second=await bridge.query({term:'其他'});assert.equal(count,1);assert.equal(first.code,'service-stopped');assert.equal(second.available,false);assert.equal(second.indexedOnly,true);assert.deepEqual(second.items,[]);
  assert.deepEqual((await bridge.knownFolders()).paths,['D:\\OneDrive\\Documents']);bridge.close();
});

test('成功响应清除并发失败缓存，繁忙状态不阻断后续查询',async()=>{
  let resolveFirst,count=0;const bridge=new NativeFileSearch({platform:'win32',transport:()=>++count===1?new Promise(resolve=>{resolveFirst=resolve;}):Promise.resolve({available:false,code:'service-stopped',reason:'未运行'})});
  const first=bridge.query({term:'a'});await bridge.query({term:'b'});assert.ok(bridge.negative);resolveFirst({available:true,code:'ready',rows:[{path:'C:\\a.txt',name:'a.txt'}]});assert.equal((await first).items.length,1);assert.equal(bridge.negative,null);bridge.close();
  const busy=new NativeFileSearch({platform:'win32',transport:async()=>{throw Object.assign(Error('忙'),{code:'query-busy'});}});assert.equal((await busy.query()).code,'query-busy');assert.equal(busy.negative,null);busy.close();
});

// 模拟管道协议，验证用户文本从 stdin 传入，而非 PowerShell 命令行。
function mockProcess(onRequest){const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();let input='';child.stdin=new Writable({write(chunk,encoding,done){input+=chunk.toString();let end;while((end=input.indexOf('\n'))>=0){const message=JSON.parse(input.slice(0,end));input=input.slice(end+1);onRequest(message,child);}done();}});child.kill=()=>{child.killed=true;child.stdout.end();child.stderr.end();};child.reply=(id,result)=>child.stdout.write(JSON.stringify({id,result})+'\n');return child;}

test('持久后台进程通过 JSON 管道传输，中文、引号和 shell 元字符不进入参数',async()=>{
  let starts=0,executable,args,options;const packets=[];
  const bridge=new NativeFileSearch({platform:'win32',spawn:(...values)=>{starts++;[executable,args,options]=values;return mockProcess((message,child)=>{packets.push(message);setImmediate(()=>child.reply(message.id,message.action==='knownFolders'?{paths:['D:\\资料'],folders:[],errors:[]}:{available:true,code:'ready',rows:[]}));});}});
  const term="中文'_%[] $(calc) `abc`";await Promise.all([bridge.knownFolders(),bridge.query({term})]);assert.equal(starts,1);assert.match(executable,/powershell\.exe$/);assert.equal(options.windowsHide,true);assert.ok(args.includes('-File'));assert.ok(!args.includes('-Command'));assert.ok(args.every(value=>!value.includes(term)));assert.ok(packets.some(packet=>packet.payload.sql?.includes("中文''")));assert.equal(bridge.pending.size,0);const child=bridge.child;bridge.close();assert.equal(child.killed,true);
});

test('超时终止后台查询并明确 fallback，后续能够重建进程',async()=>{
  let starts=0;const bridge=new NativeFileSearch({platform:'win32',timeout:20,spawn:()=>{starts++;return mockProcess((message,child)=>{if(starts>1)setImmediate(()=>child.reply(message.id,{paths:['C:\\Documents'],folders:[],errors:[]}));});}});
  const result=await bridge.query({term:'a'});assert.equal(result.available,false);assert.match(result.reason,/超时/);assert.equal(bridge.child,null);assert.equal(bridge.pending.size,0);assert.deepEqual((await bridge.knownFolders()).paths,['C:\\Documents']);assert.equal(starts,2);bridge.close();
});

test('非 Windows 平台不启动子进程；无效输入不访问系统',async()=>{
  let started=false;const bridge=new NativeFileSearch({platform:'darwin',spawn:()=>{started=true;throw Error('不能启动');}});assert.equal((await bridge.query({term:'a'})).code,'unsupported-platform');assert.equal((await bridge.query({term:'a\nb'})).code,'invalid-query');assert.equal((await bridge.knownFolders()).code,'unsupported-platform');assert.equal(started,false);bridge.close();
});
