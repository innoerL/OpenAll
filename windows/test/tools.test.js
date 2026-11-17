'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const core=require('../src/tool-core');
const backend=require('../src/backend');

test('Unicode 保留控制字符、补充平面字符及未知转义',()=>{
  const original='你好，OpenAll 👋\n\t\\"\u0000';
  assert.equal(core.unicodeDecode(core.unicodeEncode(original)),original);
  assert.equal(core.unicodeEncode('中👋'),'\\u4E2D\\uD83D\\uDC4B');
  assert.equal(core.unicodeDecode('\\u{1F44B}\\q'),'👋\\q');
  for(const text of ['\\u12','\\uGGGG','\\uD800','\\uDC00','\\uD800\\u0000','\\u{110000}','\\'])assert.throws(()=>core.unicodeDecode(text));
});

test('身份证测试号完整地区、闰日、性别与校验位',()=>{
  assert.equal(core.provinces.length,31);
  const values=core.generateIDs({provinceIndex:0,regionIndex:0,year:2000,month:2,day:29,gender:'女',count:500});
  assert.equal(new Set(values).size,500);
  for(const value of values){assert.ok(value.startsWith('11010120000229'));assert.equal(Number(value[16])%2,0);assert.ok(core.idValid(value));}
  assert.throws(()=>core.generateIDs({year:2001,month:2,day:29}));
  assert.throws(()=>core.generateIDs({count:501}));
  assert.throws(()=>core.generateIDs({provinceIndex:-1}));
  assert.equal(core.idChecksum('11010519491231002'),'X');
  assert.equal(core.idValid('110105194912310020'),false);
});

test('时间单位与 ASCII 边界',()=>{
  assert.equal(core.durationRows(1,6).find(x=>x.title==='毫秒 (ms)').value,'1000');
  assert.equal(core.durationRows(1,0).find(x=>x.title==='天 (d)').value,'365');
  assert.equal(core.durationRows('wrong').length,0);
  assert.equal(core.asciiRows().length,128);
  assert.equal(core.asciiRows('','control').length,33);
  assert.equal(core.asciiRows('','printable').length,95);
  assert.equal(core.asciiRows('0x7F')[0].character,'DEL');
});

test('Cron 中国时区、名称、范围、周日别名、日期或星期',()=>{
  assert.deepEqual(core.cronNext('0 9 * * MON-FRI',new Date('2026-11-13T01:00:00Z'),2).map(x=>x.toISOString()),['2026-11-16T01:00:00.000Z','2026-11-17T01:00:00.000Z']);
  assert.equal(core.cronNext('0 0 * * 7',new Date('2026-11-13T01:00:00Z'),1)[0].toISOString(),'2026-11-14T16:00:00.000Z');
  assert.equal(core.cronNext('0 0 29 FEB *',new Date('2026-01-01T00:00:00Z'),1)[0].toISOString(),'2028-02-28T16:00:00.000Z');
  assert.deepEqual(core.cronNext('0 9 1 * MON',new Date('2026-11-27T00:00:00Z'),2).map(x=>x.toISOString()),['2026-11-30T01:00:00.000Z','2026-12-01T01:00:00.000Z']);
  assert.equal(core.cronNext('0 0 30 FEB *',new Date('2026-01-01'),1).length,0);
  assert.equal(core.cronParse('*/15 9-18 * * 1-5').sets[0].size,4);
  for(const text of ['* * * *','60 * * * *','*/0 * * * *','* 22-2 * * *','* * * 13 *'])assert.throws(()=>core.cronParse(text));
});

test('PNG 目标体积为合法辅助块、CRC 与准确字节数',()=>{
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
  const padded=core.paddedPNG(png,1000000);
  assert.equal(padded.length,1000000);
  let found=false;
  for(let offset=8;offset+12<=padded.length;){const view=new DataView(padded.buffer,padded.byteOffset,padded.byteLength),size=view.getUint32(offset),type=String.fromCharCode(...padded.subarray(offset+4,offset+8));if(type==='opAd'){found=true;assert.equal(view.getUint32(offset+size+8),core.crc32(padded.subarray(offset+4,offset+size+8)));}offset+=size+12;}
  assert.ok(found);
  assert.deepEqual([...core.paddedPNG(png,png.length)],[...png]);
  assert.throws(()=>core.paddedPNG(png,png.length+1));
  assert.throws(()=>core.paddedPNG(png,100000001));
});

test('结构化配置识别值类型、嵌套数组、别名与循环保护',()=>{
  const changes=backend.configDiff('{"items":[1,"2"],"secret":"a"}','{"items":[1,2,3],"secret":"b"}','json');
  assert.equal(changes.find(x=>x.key==='items[1]').leftType,'string');
  assert.equal(changes.find(x=>x.key==='items[1]').rightType,'number');
  assert.equal(changes.find(x=>x.key==='items[2]').status,'新增');
  assert.equal(changes.find(x=>x.key==='secret').right,'••••••');
  assert.equal(backend.configDiff('secret: a','secret: b','yaml',true)[0].right,'b');
  assert.equal(backend.configDiff('a: &v {x: 1}\nb: *v','a: &v {x: 2}\nb: *v','yaml').length,2);
  assert.throws(()=>backend.configDiff('a: &v {x: *v}','a: 1','yaml'),/循环/);
  assert.throws(()=>backend.configDiff('a: 1\na: 2','a: 1','yaml'));
  const props=backend.parseConfig('name\\ key = \\u4F60\\u597D\ncontinued = first\\\n  second\ncolon:value','properties');
  assert.equal(props['name key'],'你好');assert.equal(props.continued,'firstsecond');assert.equal(props.colon,'value');
});

test('SQL 参数替换忽略字符串、嵌套注释、美元引号和类型转换',()=>{
  const source="select '?' as q, $$? :id$$ as d, $tag$:id$tag$ as x, :id::int, ? /* ? /* ? */ ? */ -- ?\nwhere n=$2";
  const result=backend.restoreSQL(source,['A\'B',42]);
  assert.equal(result.replaced,2);assert.deepEqual(result.missing,[':id']);assert.match(result.sql,/\$\$\? :id\$\$/);assert.match(result.sql,/'A''B'/);assert.match(result.sql,/n=42$/);
  assert.equal(backend.restoreSQL('Preparing: select * from t where a=? and b=? and c=?',"Parameters: 42(Integer), 'A,B'(String), null").sql,"select * from t where a=42 and b='A,B' and c=NULL");
  assert.equal(backend.restoreSQL('x=:id::int and y=:name',{id:3,name:'好'}).sql,"x=3::int and y='好'");
  assert.deepEqual(backend.restoreSQL('x=?',[1,2]).unused,['1']);
  assert.equal(backend.restoreSQL('id=?','Parameters: 9223372036854775807(Long)').sql,'id=9223372036854775807');
});

test('日志嵌套字段、手动提取及时间排序',()=>{
  const rows=backend.parseLogs('{"context":{"id":"a"},"time":"2026-11-03T02:00:00Z"}\n2026-11-03T01:00:00Z trace=a request=2\n2026-11-03T00:00:00Z trace=a request=1','requestID=request=(\\d+)');
  assert.equal(rows[0].fields['context.id'],'a');assert.equal(rows[2].fields.requestID,'1');
  assert.equal(backend.logGroups(rows,'trace','时间')[0].entries[0].fields.request,'1');
  assert.equal(backend.logFields(rows).find(x=>x.key==='trace').count,2);
  assert.throws(()=>backend.parseLogs('a','foo=no-capture'));
  assert.equal(backend.parseLogs('a=1\n'.repeat(10001)).length,10000);
});

test('执行计划保留 PostgreSQL 层级与 MySQL 表格细节',()=>{
  const rows=backend.explain(JSON.stringify([{Plan:{'Node Type':'Nested Loop','Plan Rows':4,Plans:[{'Node Type':'Index Scan','Index Name':'idx_users','Actual Rows':3},{'Node Type':'Seq Scan','Relation Name':'logs'}]}}]));
  assert.equal(rows.length,3);assert.equal(rows[1].depth,1);assert.equal(rows[1].index,'idx_users');assert.equal(rows[2].warning,true);
  const mysql=backend.explain('| id | select_type | table | type | key | rows | Extra |\n| 1 | SIMPLE | users | ALL | NULL | 50 | Using where |');
  assert.equal(mysql[0].relation,'users');assert.equal(mysql[0].warning,true);assert.equal(mysql[0].estimated,'50');
});

test('较大配置、SQL 与日志输入有界处理',()=>{
  const config=Object.fromEntries(Array.from({length:25000},(_,i)=>['key'+i,'value'+i]));
  const left=JSON.stringify(config);config.key20000='changed';
  assert.equal(backend.configDiff(left,JSON.stringify(config),'json').length,1);
  const sql=('SELECT ? AS n;\n').repeat(10000);
  assert.equal(backend.restoreSQL(sql,Array.from({length:10000},(_,i)=>i)).replaced,10000);
  assert.throws(()=>backend.parseLogs('x'.repeat(33*1024*1024)),/32 MB/);
});


test('编辑器搜索按字面量并限制高亮数量',()=>{
  assert.deepEqual(core.findText('a.b A.B aab','a.b').matches,[{from:0,to:3},{from:4,to:7}]);
  assert.equal(core.findText('a.b A.B','a.b',true).total,1);
  assert.equal(core.findText('x'.repeat(10000),'x').matches.length,5000);
  assert.equal(core.findText('x'.repeat(10000),'x').total,10000);
  assert.equal(core.durationDisplay('1000000'),'1 × 10⁶');
  assert.equal(core.durationDisplay('0.000000031709792'),'3.17098 × 10⁻⁸');
  assert.equal(core.asciiDescription(65),'大写字母');
});


test('选择动作按真实内容分类并按分类保存排序',()=>{
  const vm=require('node:vm'),fs=require('node:fs');const window={OpenAllPages:{}};vm.runInNewContext(fs.readFileSync(require.resolve('../src/selection-pages.js'),'utf8'),{window,URL});const selection=window.OpenAllSelection;
  assert.equal(selection.category(selection.normalize('https://example.com/a')),'url');
  assert.equal(selection.category(selection.normalize('{"a":1}')),'json');
  assert.equal(selection.category(selection.normalize({kind:'files',files:['C:\\test.heic']})),'imageFile');
  assert.equal(selection.category(selection.normalize({kind:'files',files:['C:\\test.pdf']})),'file');
  assert.equal(selection.category(selection.normalize({kind:'image',dataUrl:'data:image/png;base64,AA=='})),'image');
  const ordered=selection.orderActions(selection.normalize('plain'),['unicode','copy']);assert.equal(ordered[0].id,'unicode');assert.equal(ordered[1].id,'copy');assert.equal(ordered.length,7);
});
