'use strict';
// 本地 Electron 冒烟测试：不接触用户剪贴板或文件，只验证工具页面和真实渲染引擎。
if(!process.versions.electron){console.log('页面检查请运行 electron test/tool-ui.test.js');process.exit(0);}
const {app,BrowserWindow,ipcMain}=require('electron');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'..');
const destination=process.env.OPENALL_TOOL_SCREEN_DIR||path.resolve(root,'artifacts/tools');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'openall-tool-ui-'));
const errors=[];
let win;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function js(code){return win.webContents.executeJavaScript('(async()=>{'+code+'})()',true);}
async function until(code,description){const start=Date.now();while(Date.now()-start<10000){if(await js('return '+code))return;await pause(50);}throw Error(description+'超时');}
async function click(text){await js('([...document.querySelectorAll("button")].find(x=>x.textContent==='+JSON.stringify(text)+')||(()=>{throw Error("按钮不存在")})()).click();');}
async function fill(selector,value){await js('const node=document.querySelector('+JSON.stringify(selector)+');node.value='+JSON.stringify(value)+';node.dispatchEvent(new Event("input",{bubbles:true}));');}
async function selectID(part,prefix=''){
  await js('const field=document.querySelector('+JSON.stringify('[data-id-part="'+part+'"]')+'),prefix='+JSON.stringify(prefix)+';const option=[...field.options].find(item=>prefix?item.textContent.startsWith(prefix):item.value==="");if(!option)throw Error("地区选项不存在："+prefix);field.value=option.value;field.dispatchEvent(new Event("change",{bubbles:true}));');
}
async function expectIDPrefix(prefix){
  await click('生成测试号');const values=await js('return [...document.querySelectorAll(".aux-id-row code")].map(node=>node.textContent);');
  assert.equal(values.length,5);for(const value of values)assert.ok(value.startsWith(prefix),'行政区代码应为 '+prefix+'，实际 '+value.slice(0,6));
  assert.equal(await js('return [...document.querySelectorAll(".aux-id-row code")].every(node=>window.OpenAllTools.idValid(node.textContent));'),true,'生成号码应通过日期和校验位验证');
}
async function idBirthday(){return js('return ["year","month","day"].map(part=>document.querySelector("[data-id-part="+part+"]").value);');}
async function expectIDBirthday(expected){
  assert.deepEqual(await idBirthday(),expected.map(String));await click('生成测试号');
  const formatted=String(expected[0])+String(expected[1]).padStart(2,'0')+String(expected[2]).padStart(2,'0');
  assert.equal(await js('return [...document.querySelectorAll(".aux-id-row code")].every(node=>node.textContent.slice(6,14)==='+JSON.stringify(formatted)+');'),true,'生成号码应使用已回填生日');
}
async function capture(name){
  await pause(120);
  // 默认窗口下，短表格不应产生横向溢出，十种时间单位应完整可见。
  if(['configDiff','explain','logTimeline'].includes(name))assert.equal(await js('const report=document.querySelector(".aux-report");return report.scrollWidth<=report.clientWidth+1;'),true,name+' 结果表格不应横向溢出');
  if(name==='converter-duration')assert.equal(await js('const body=document.querySelector(".aux-converter-body"),last=document.querySelector(".aux-conversion-row:last-child");return last.getBoundingClientRect().bottom<=body.getBoundingClientRect().bottom;'),true,'默认窗口应展示纳秒行');
  if(name==='unicode')assert.equal(await js('const tab=document.querySelector(".aux-tabs .active");return getComputedStyle(tab).backgroundColor==="rgba(0, 0, 0, 0)"&&getComputedStyle(tab,"::after").height==="2px";'),true,'Unicode 使用文字下划线标签');
  if(name.startsWith('id'))assert.equal(await js('return [...document.querySelectorAll(".aux-id-top,.aux-id-date,.aux-id-options")].every(row=>row.scrollWidth<=row.clientWidth+1&&[...row.children].every(field=>field.getBoundingClientRect().right<=row.getBoundingClientRect().right+1));'),true,'省市区与日期行不应横向溢出');
  fs.writeFileSync(path.join(destination,name+'.png'),(await win.webContents.capturePage()).toPNG());
}
async function mount(id,value='',width,height){if(!width)[width,height]=({unicode:[800,(value?.length||0)<=240 && String(value||'').split('\n',4).length<=3?306:440],id:[660,520],converter:[980,610],markdown:[980,540],manual:[980,540],image:[900,540],selection:[640,460],stack:[340,262]})[id]||[1000,680];win.setSize(width,height);await js('window.controller?.dispose?.();document.querySelector("main").replaceChildren();document.querySelector("main").className="";document.body.dataset.page='+JSON.stringify(id)+';document.querySelector("#title").textContent=(window.OpenAllCatalog.find(command=>command.id==='+JSON.stringify(id)+')?.title||"OpenAll");window.controller=await window.OpenAllPages['+JSON.stringify(id)+'](document.querySelector("main"),{...window.context,initialValue:'+JSON.stringify(value)+'});');}
app.whenReady().then(async()=>{
  fs.mkdirSync(destination,{recursive:true});
  const base=pathToFileURL(path.join(root,'src/')).href;
  const html='<!doctype html><html><head><meta charset="utf-8"><base href="'+base+'"><link rel="stylesheet" href="style.css"><link rel="stylesheet" href="tool-pages.css"><link rel="stylesheet" href="content-tools.css"><link rel="stylesheet" href="editor-pages.css"><link rel="stylesheet" href="selection-pages.css"><link rel="stylesheet" href="workbench-pages.css"></head><body><div id="chrome" class="window-chrome"><span id="title" class="window-title">OpenAll</span><div class="window-controls"><button class="window-minimize" aria-label="最小化">−</button><button class="window-maximize" aria-label="最大化">□</button><button class="window-close" aria-label="关闭">×</button></div></div><main id="app"></main><script>window.module=undefined;window.exports=undefined;</script><script src="../assets/marked.umd.js"></script><script src="../assets/id-regions.js"></script><script src="catalog.js"></script><script src="tool-core.js"></script><script src="../assets/tool-manual.js"></script><script src="../../shared/manual-ui/reader.js"></script><script src="tool-pages.js"></script><script src="ui.js"></script><script src="selection-pages.js"></script></body></html>';
  const file=path.join(temporary,'index.html');fs.writeFileSync(file,html);
  win=new BrowserWindow({show:false,width:1000,height:700,frame:false,webPreferences:{nodeIntegration:true,contextIsolation:false,offscreen:true}});
  win.webContents.on('console-message',event=>{if(event.level==='error'||event.level>=3)errors.push(event.message);});
  ipcMain.handle('tool-test-window',(_event,action,payload)=>{if(action==='resize')win.setSize(payload.width,payload.height);return true;});await win.loadFile(file);
  await js('window.require = require; window.saved=[];window.copied="";window.messages=[];window.opened=[];window.orders={};window.windowEvents=[];window.context={...window.OpenAllUI,settings:{},notify:text=>window.messages.push(text),openPage:(id,value)=>window.opened.push({id,value}),api:{copyText:async text=>window.copied=text,windowAction:async(action,payload)=>{window.windowEvents.push({action,payload});return require("electron").ipcRenderer.invoke("tool-test-window",action,payload);},selection:async(action,payload={})=>{if(action==="order"){if(payload.order)window.orders[payload.category]=payload.order;return window.orders[payload.category]||[];}if(action==="snippet")return{keyword:"test"};return{};},ocr:async()=>({text:"识别结果：OpenAll"}),readText:async()=>"",chooseFile:async()=>({text:"# 已打开\\n\\n文件内容"}),open:async()=>{},backendTask:async(action,args)=>require('+JSON.stringify(path.join(root,'src/backend.js'))+')[action](...args),fileAction:async(action,payload)=>{if(action==="readImage")return null;if(action==="save"){window.saved.push(payload);return{path:"mock",canceled:false};}if(action==="copyImage"){window.copiedImage=payload.dataUrl;return{};}throw Error("测试未定义文件操作："+action);}}};');

  await mount('unicode','你好，OpenAll 👋');
  assert.match(await js('return document.querySelectorAll("textarea,.aux-editor-frame")[1].value'),/\\u4F60/);
  await click('填回输入');await until('document.querySelectorAll("textarea,.aux-editor-frame")[1].value==="你好，OpenAll 👋"','Unicode 回填');
  await capture('unicode');
  await fill('textarea', '');
  await until('document.querySelector(".aux-status").textContent.includes("自动解码")','空输入提示');
  assert.equal(await js('return [...document.querySelectorAll(".aux-pane-bar button")].every(button=>button.disabled)'),true);
  await fill('textarea',String.fromCharCode(92)+'u00ZZ');
  await until('document.querySelector(".aux-status").classList.contains("error")','无效转义提示');

  await mount('id','',660,520);assert.equal(await js('return document.querySelectorAll(".aux-id-row").length'),5);await click('复制全部');assert.equal((await js('return window.copied')).split('\n').length,5);
  assert.equal(await js('return document.querySelector("[data-id-part=city]").disabled&&document.querySelector("[data-id-part=region]").disabled;'),true,'未选省份时禁用城市和区县');await capture('id');
  // 使用正式行政区数据验证联动及生成范围，不在页面测试内替换数据。
  await selectID('province','浙江');assert.equal(await js('return !document.querySelector("[data-id-part=city]").disabled&&document.querySelector("[data-id-part=region]").disabled;'),true);
  await expectIDPrefix('33');await selectID('city','杭州');assert.equal(await js('return !document.querySelector("[data-id-part=region]").disabled;'),true);await selectID('region','西湖');await expectIDPrefix('330106');await capture('id-hangzhou');
  await selectID('city','宁波');assert.equal(await js('const region=document.querySelector("[data-id-part=region]");return region.value===""&&!region.disabled&&![...region.options].some(option=>option.textContent.startsWith("西湖"));'),true,'切换城市应清空旧区县');await selectID('region','海曙');await expectIDPrefix('330203');
  await selectID('region');await expectIDPrefix('3302');await selectID('city');assert.equal(await js('const region=document.querySelector("[data-id-part=region]");return region.disabled&&region.value===""&&region.options.length===1;'),true,'随机城市时区县禁用');await expectIDPrefix('33');
  await selectID('city','杭州');await selectID('region','西湖');await selectID('province','广东');assert.equal(await js('const city=document.querySelector("[data-id-part=city]"),region=document.querySelector("[data-id-part=region]");return city.value===""&&!city.disabled&&region.value===""&&region.disabled;'),true,'切换省份应清空市和区');
  await selectID('city','东莞');assert.equal(await js('return document.querySelector("[data-id-part=region]").options.length;'),2,'东莞应有随机项和一个本级区县项');await expectIDPrefix('441900');await capture('id-dongguan');
  await selectID('province','北京');await selectID('city','北京');await selectID('region','朝阳');await expectIDPrefix('110105');await capture('id-municipality');
  // 真实长名称不得撑开 660×520 窗口中的三列布局。
  await js('const entries=window.OpenAllTools.provinces.flatMap((province,p)=>province.cities.map((city,c)=>({p,c,city}))).sort((a,b)=>b.city.name.length-a.city.name.length),longest=entries[0],province=document.querySelector("[data-id-part=province]"),city=document.querySelector("[data-id-part=city]"),region=document.querySelector("[data-id-part=region]");province.value=String(longest.p);province.dispatchEvent(new Event("change"));city.value=String(longest.c);city.dispatchEvent(new Event("change"));const district=longest.city.regions.map((value,index)=>({value,index})).sort((a,b)=>b.value.name.length-a.value.name.length)[0];region.value=String(district.index);region.dispatchEvent(new Event("change"));');await click('生成测试号');await capture('id-long-region');
  await selectID('province');assert.equal(await js('return ["city","region"].every(part=>{const field=document.querySelector("[data-id-part="+part+"]");return field.disabled&&field.value===""&&field.options.length===1;});'),true,'重置省份应移除下级旧选项');await expectIDPrefix('');

  // 年龄按浏览器本地今天推算，验证回填、生成前复核及手动日期优先。
  const birthdayReference=await js('const today=new Date(),year=today.getFullYear(),month=today.getMonth()+1,day=today.getDate();return {today:[year,month,day],age25:[year-25,month,Math.min(day,new Date(year-25,month,0).getDate())],tooOld:String(year-1899)};');
  assert.equal(await js('return document.querySelector("[aria-label=年龄]").placeholder;'),'周岁');
  await fill('[data-id-part=age]','25');assert.match(await js('return document.querySelector(".aux-status").textContent;'),/回填/);await expectIDBirthday(birthdayReference.age25);await capture('id-age25');
  await fill('[data-id-part=age]','0');await expectIDBirthday(birthdayReference.today);
  await fill('[data-id-part=age]','25');await js('document.querySelector("[data-id-part=age]").value="0";');await click('生成测试号');assert.deepEqual(await idBirthday(),birthdayReference.today.map(String),'生成前应再次处理有效年龄');
  const retainedBirthday=await idBirthday(),retainedNumbers=await js('return [...document.querySelectorAll(".aux-id-row code")].map(node=>node.textContent);');
  for(const invalid of ['-1','2.5','abc',birthdayReference.tooOld,'9'.repeat(30)]){
    await fill('[data-id-part=age]',invalid);await click('生成测试号');
    assert.equal(await js('return document.querySelector("[data-id-part=age]").getAttribute("aria-invalid")==="true"&&document.querySelector(".aux-status").classList.contains("error")&&document.querySelector(".aux-status").textContent.includes("清空年龄");'),true,'无效年龄应提示修正或清空');
    assert.deepEqual(await idBirthday(),retainedBirthday,'无效年龄不得改写生日');assert.deepEqual(await js('return [...document.querySelectorAll(".aux-id-row code")].map(node=>node.textContent);'),retainedNumbers,'无效年龄不得沿用旧日期生成');
  }
  await fill('[data-id-part=age]','');assert.deepEqual(await idBirthday(),retainedBirthday,'清空年龄应保留生日');assert.equal(await js('return document.querySelector("[data-id-part=age]").hasAttribute("aria-invalid")||document.querySelector(".aux-status").classList.contains("error");'),false);await expectIDBirthday(birthdayReference.today);
  for(const [part,value]of [['year','2000'],['month','1'],['day','2']]){await fill('[data-id-part=age]','25');await fill('[data-id-part='+part+']',value);assert.equal(await js('return document.querySelector("[data-id-part=age]").value;'),'','手动修改 '+part+' 应清空年龄');}
  for(const [part,value]of [['year','2000'],['month','1'],['day','2']])await fill('[data-id-part='+part+']',value);await expectIDBirthday([2000,1,2]);await capture('id-age-manual');

  await mount('converter');assert.equal(await js('return document.querySelectorAll(".aux-conversion-row").length'),10);await capture('converter-duration');
  assert.equal(await js('return document.querySelector(".aux-unit-summary").textContent'),'1 秒 = 1000 毫秒');
  assert.match(await js('return document.querySelector(".aux-conversion-row:first-child.target").textContent'),/毫秒.*1000/);
  await js('const unit=document.querySelector(".aux-duration-fields select");unit.value="7";unit.dispatchEvent(new Event("change"));');
  assert.equal(await js('return document.querySelector(".aux-unit-summary").textContent'),'1 毫秒 = 0.001 秒');
  await fill('.aux-duration-fields input','xxx');assert.equal(await js('return document.querySelector(".aux-unit-summary").textContent'),'换算结果');
  assert.equal(await js('return document.querySelectorAll(".aux-conversion-row").length'),0);
  await click('Cron 表达式');await until('document.querySelectorAll(".aux-cron-row").length===5','Cron 时间');await capture('converter-cron');
  await click('ASCII 码表');await until('document.querySelectorAll("tbody tr").length===95','ASCII 行');await capture('converter-ascii');
  for (const [query,expected] of [['A',65],['a',97],['65',65],['0x41',65],['TAB',9]]) {
    await fill('.aux-ascii-lookup input',query);
    assert.match(await js('return document.querySelector(".aux-ascii-match").textContent'),new RegExp('十进制 '+expected+'  ·  0x','u'));
  }
  await fill('.aux-ascii-lookup input','A');await capture('converter-ascii-match');
  await fill('.aux-converter-body input','xxx-no-ascii');
  assert.match(await js('return document.querySelector("tbody").textContent'),/没有匹配的字符/);
  assert.equal(await js('return document.querySelector(".aux-ascii-match").textContent'),'');

  await mount('configDiff');
  await js('const fields=document.querySelectorAll("textarea,.aux-editor-frame");fields[0].value="server:\\n  port: 80\\npassword: old";fields[1].value="server:\\n  port: 81\\npassword: new\\nfeature: true";');
  await click('比较配置');await until('document.querySelector(".aux-status").textContent.includes("修改 2")','配置对比');assert.match(await js('return document.querySelector("tbody").textContent'),/••••••/);assert.match(await js('return document.querySelector(".aux-status").textContent'),/新增 1.*修改 2/);assert.equal(await js('return document.querySelector(".aux-report-title").textContent'),"3 项变更");assert.equal(await js('return document.querySelector(".aux-table-footer").textContent'),'3 项','单页结果只显示项数');assert.match(await js('return document.querySelector(".summary-row").textContent'),/server.port/);
  await capture('configDiff');
  await click('定位到行');assert.equal(await js('return document.activeElement.cells[1].textContent'),'server.port','定位到摘要列出的配置键');
  await js('document.querySelector(".aux-editor-frame").value="server: 123";');
  await until('document.querySelector(".aux-status").textContent.includes("重新运行")','配置更改状态');
  assert.equal(await js('return document.querySelector(".aux-report-heading button:not(.aux-locate)").disabled'),true,'源配置变更后应禁用旧结果复制');
  assert.equal(await js('return document.querySelector(".aux-locate").hidden'),true,'旧结果不提供行定位');
  await js('const fields=document.querySelectorAll(".aux-editor-frame");fields[0].value="password: secret-old";fields[1].value="password: secret-new";');
  await click('比较配置');await until('document.querySelector(".aux-report-title").textContent==="1 项变更"','只含敏感字段的结果');
  await js('document.querySelector(".aux-actions input[type=checkbox]").click()');
  await until('document.querySelector("tbody").textContent.includes("secret-new")','显示敏感值');
  assert.equal(await js('return document.querySelector(".aux-report-title").textContent'),'1 项变更','打开敏感值展示时摘要仍只概括变更');


  await mount('explain',JSON.stringify([{Plan:{'Node Type':'Nested Loop','Plan Rows':200,Plans:[{'Node Type':'Index Scan','Relation Name':'users','Index Name':'users_pkey','Plan Rows':1,'Actual Rows':1,'Actual Total Time':0.04},{'Node Type':'Seq Scan','Relation Name':'orders','Plan Rows':200,'Actual Rows':174,'Actual Total Time':1.24}]}}]));await click('分析计划');await until('document.querySelectorAll("tbody tr").length===3','执行计划');assert.match(await js('return document.querySelector("tbody").textContent'),/全表扫描/);await capture('explain');
  assert.equal(await js('return document.querySelector(".source-collapsed .aux-editor").hidden'),true,'分析完成收起原文');
  await click('展开原文');assert.equal(await js('return document.querySelector(".aux-backend-body > .aux-pane .aux-editor").hidden'),false,'可重新编辑原始计划');

  assert.equal(await js('return document.querySelector(".aux-report-title").textContent'),'orders 使用全表扫描');
  await click('定位到行');assert.equal(await js('return document.activeElement.cells[1].textContent'),'orders');
  assert.match(await js('return document.querySelector(".aux-status").textContent'),/实际 174 行 · 耗时 1.24 ms/);
  assert.equal(await js('return document.querySelector(".aux-backend-body").classList.contains("has-finding")'),false,'扫描方式本身不等于行数异常');
  const mismatch=JSON.stringify([{Plan:{'Node Type':'Seq Scan','Relation Name':'orders','Plan Rows':12000,'Actual Rows':3}}]);
  await fill('.aux-editor-frame',mismatch);await click('分析计划');
  await until('document.querySelector(".aux-report-title").textContent==="orders · 估算偏高 4000 倍"','计划关键结果');
  assert.match(await js('return document.querySelector(".aux-status").textContent'),/估算 12000 行 · 实际 3 行/);


  await mount('sqlRestore',"SELECT * FROM users WHERE id = ? AND name = ?;");await js('document.querySelectorAll("textarea,.aux-editor-frame")[1].value="Parameters: 42(Integer), OpenAll(String)";');await click('还原 SQL');await until('document.querySelectorAll("textarea,.aux-editor-frame")[2].value.includes("id = 42")','SQL 还原');await capture('sqlRestore');
  assert.equal(await js('return document.querySelector(".aux-report-title").textContent'),'已还原 2 个占位符');
  assert.equal(await js('return [...document.querySelectorAll(".editor-bound-parameter")].map(node=>node.textContent).join("|")'),"42|'OpenAll'");
  assert.equal(await js('return document.querySelector(".aux-backend-body > .aux-pane").offsetHeight'),80,'短 SQL 使用紧凑结果区');
  assert.equal(await js('return getComputedStyle(document.querySelector(".aux-report-heading button:not(.aux-locate)")).borderTopWidth'),'1px');
  assert.equal(await js('const result=document.querySelector(".aux-backend-body > .aux-pane .cm-content");result.focus();return result===document.activeElement;'),true,'SQL 结果可通过键盘切入');
  const longSQL=Array.from({length:80},(_,i)=>'SELECT '+i+';').join('\n');
  await fill('.aux-editor-frame',longSQL);await js('document.querySelectorAll(".aux-editor-frame")[1].value=""');await click('还原 SQL');
  await until('document.querySelector(".aux-report-title").textContent==="SQL 中没有占位符"','长 SQL 结果');
  assert.equal(await js('return document.querySelector(".aux-backend-body > .aux-pane").offsetHeight>100 && !document.querySelector(".aux-backend-body").classList.contains("short-sql");'),true,'长 SQL 保留可滚动的完整结果区域');



  await mount('logTimeline','{"time":"2026-11-16T12:01:20Z","traceId":"req-001","level":"INFO","message":"request started"}\n{"time":"2026-11-16T12:01:22Z","traceId":"req-001","level":"INFO","message":"request completed"}\n{"time":"2026-11-16T12:02:10Z","traceId":"req-002","level":"ERROR","message":"database timeout"}');await click('识别字段');await until('document.querySelector(".aux-status").textContent.includes("3 条日志")','日志解析');await js('const select=document.querySelectorAll("select")[0];select.value="traceId";select.dispatchEvent(new Event("change"));');await until('document.querySelector(".aux-status").textContent.includes("2 个分组")','日志分组');await capture('logTimeline');
  assert.match(await js('return document.querySelector("tr.group").textContent'),/2026-11-16/);
  assert.match(await js('return document.querySelector("tbody").textContent'),/\+2s/);

  assert.equal(await js('return document.querySelector(".aux-report-title").textContent'),'请求 req-002 · 数据库超时');
  assert.match(await js('return document.querySelector(".aux-status").textContent'),/1 条错误/);
  assert.equal(await js('return document.querySelector(".aux-table-footer span").textContent'),'3 项','分组标题不计入日志条数');
  const boundaryLogs=Array.from({length:152},(_,index)=>JSON.stringify({requestId:index===0?'a':'b',level:index===151?'ERROR':'INFO',message:index===151?'database timeout':'检查分页'})).join('\n');
  await mount('logTimeline',boundaryLogs);await click('识别字段');
  await until('document.querySelector(".aux-status").textContent.includes("152 条日志")','多页日志');
  await js('const select=document.querySelectorAll("select")[0];select.value="requestId";select.dispatchEvent(new Event("change"));');
  await until('document.querySelector(".aux-status").textContent.includes("2 个分组")','分页分组');
  await js('const btn=document.querySelector(".aux-locate");btn.focus();btn.dispatchEvent(new KeyboardEvent("keydown",{key:"l",ctrlKey:true,bubbles:true}));');
  assert.equal(await js('return document.activeElement.cells[2].textContent'),'database timeout','从摘要跨页聚焦到正确分组里的错误事件');
  assert.equal(await js('return document.querySelector(".aux-table-footer span").textContent'),'152 项 · 第 2 / 2 页');
  assert.equal(await js('return document.querySelectorAll("tbody tr").length'),4,'跨页保留当前分组和后续分组的标题及日志');



  await mount('manual');
  assert.ok(await js(`const notes=document.querySelector('.manual-notes'),toggle=notes.querySelector('summary');if(notes.open)return false;
    toggle.click();const shown=notes.open&&notes.querySelector('p').getBoundingClientRect().height>0;toggle.click();return shown&&!notes.open;`),'用说明标题展开和收起导语');
  assert.ok(await js(`const picker=document.querySelector('.manual-sections');picker.value='1';picker.dispatchEvent(new Event('change'));return document.activeElement===document.querySelectorAll('.manual-article h2')[1] && document.querySelector('.manual-article').scrollTop>0;`));
  const manualRowCount=await js('return document.querySelectorAll("tbody tr").length');
  assert.ok(manualRowCount>20);
  await fill('input[type=search]','journalctl');
  const visibleRows=await js('return [...document.querySelectorAll("tbody tr")].filter(row=>!row.closest("[hidden]")).length');
  assert.ok(visibleRows>0&&visibleRows<manualRowCount);
  await js('const entry=[...document.querySelectorAll("td code[role=button]")].find(item=>!item.closest("[hidden]"));entry.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));');
  await until('window.copied.includes("journalctl")','键盘复制命令');
  await fill('input[type=search]','OpenAll-无此命令');
  assert.equal(await js('return document.querySelector(".manual-count").textContent'),'没有匹配项');
  await fill('input[type=search]','');
  assert.equal(await js('return [...document.querySelectorAll("tbody tr")].filter(row=>!row.closest("[hidden]")).length'),manualRowCount);
  await capture('manual');
  await fill('.manual-toolbar input','no_command_359907');
  assert.equal(await js('return !document.querySelector(".manual-empty").hidden'),true);
  await click('清除搜索');
  assert.equal(await js('return document.querySelector(".manual-empty").hidden && document.activeElement===document.querySelector(".manual-toolbar input")'),true);

  await mount('markdown','# OpenAll 笔记\n\n在一处编辑与预览。\n\n- [x] Markdown\n- [x] Mermaid 图表\n\n```mermaid\nflowchart LR\nA[输入] --> B[编辑]\nB --> C[导出]\n```\n\n| 工具 | 状态 |\n| --- | --- |\n| JSON | 可用 |');await until('document.querySelector(".aux-diagram svg")!==null','Mermaid 图表');await capture('markdown');await js('document.querySelector(".aux-editor-frame").focus();');win.webContents.sendInputEvent({type:'keyDown',keyCode:'F',modifiers:[process.platform==='darwin'?'meta':'control']});await until('!document.querySelector(".aux-findbar").hidden','Markdown 搜索框');await fill('.aux-findbar input','OpenAll');await until('document.querySelector(".aux-findbar span").textContent.includes("1 / 1")','Markdown 内容搜索');await js('document.querySelector(".aux-findbar button:last-child").click();');await click('复制 Markdown');assert.match(await js('return window.copied'),/# OpenAll/);await click('导出 HTML…');await until('window.saved.length===1','HTML 导出');assert.match(await js('return window.saved[0].text'),/<svg/);
  await fill('textarea,.aux-editor-frame','<script>window.hacked=1</script>\n<img src=x onerror="window.hacked=1">\n[bad](javascript:alert(1))');await until('document.querySelector(".aux-status").textContent.includes("预览已更新")','Markdown 安全预览');assert.equal(await js('return Boolean(window.hacked||document.querySelector(".aux-markdown-preview script")||document.querySelector(".aux-markdown-preview [onerror]"))'),false);

  await mount('markdown','# 项目记录\n\n## 验收清单\n\n- [x] 拆分编辑与阅读操作\n- [ ] 复查窄窗\n\n`Ctrl+F` 查找源文。');
  await click('语法示例'); await capture('markdown-help'); await click('关闭');
  await fill('.aux-editor-frame','前后');
  await js("const input=document.querySelector('.aux-editor-frame'); input.focus();");
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Home'});
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Right'});
  await until('document.querySelector(".aux-editor-frame").selectionStart===1','移动至 Markdown 插入位置');
  await click('语法示例');
  assert.ok(await js('const right=document.querySelector(".aux-help-popover"), left=document.querySelector(".aux-editor-frame"); return right.getBoundingClientRect().left>=left.getBoundingClientRect().right-1 && right.querySelector("h4").textContent==="基础语法";'));
  await capture('markdown-help-insertion');
  await click('加粗');
  assert.equal(await js('return document.querySelector(".aux-editor-frame").value'),'前**加粗文字**后');

  const image=await js('const canvas=document.createElement("canvas");canvas.width=800;canvas.height=500;const ctx=canvas.getContext("2d"),g=ctx.createLinearGradient(0,0,800,500);g.addColorStop(0,"#d8c19e");g.addColorStop(1,"#49716b");ctx.fillStyle=g;ctx.fillRect(0,0,800,500);ctx.fillStyle="#f8f7ef";ctx.font="42px sans-serif";ctx.fillText("OpenAll",60,100);ctx.strokeStyle="#ffffff90";ctx.lineWidth=3;ctx.strokeRect(60,150,680,290);return canvas.toDataURL();');
  await mount('image',image);await until('document.querySelector(".aux-image-size").textContent.includes("PNG")','图片编码');await capture('image');assert.match(await js('return document.querySelector(".aux-image-summary p").textContent'),/体积相近|减小|增大/);await click('↷ 右转');await until('document.querySelectorAll(".aux-image-dimensions input")[0].value==="500" && ![...document.querySelectorAll("button")].find(x=>x.textContent==="保存文件…").disabled','图片旋转');await click('⌗ 裁剪');
  assert.ok(await js('return document.activeElement===document.querySelector(".image-crop-guide")'),'裁剪打开时焦点在画布');
  const dragPoints = await js(`const matrix=document.querySelector('.image-crop-guide').getScreenCTM();
    return [[30,50],[320,370]].map(([x,y])=>{const p=new DOMPoint(x,y).matrixTransform(matrix);return {x:Math.round(p.x),y:Math.round(p.y)};});`);
  win.webContents.sendInputEvent({type:'mouseDown',...dragPoints[0],button:'left',clickCount:1});
  win.webContents.sendInputEvent({type:'mouseMove',...dragPoints[1],modifiers:['leftButtonDown']});
  win.webContents.sendInputEvent({type:'mouseUp',...dragPoints[1],button:'left',clickCount:1});
  await until('Number(document.querySelector(".aux-crop-fields input").value)>0','拖动图片更新裁剪坐标');
  for(let i=0;i<4;i++){
    const corner=await js(`const handles = [...document.querySelectorAll('.image-crop-guide circle')];
      const handle=handles[${i}], opposite=handles[3-${i}], matrix=handle.getScreenCTM();
      const from=new DOMPoint(handle.cx.baseVal.value,handle.cy.baseVal.value).matrixTransform(matrix);
      const x=handle.cx.baseVal.value+(${i}%2?-27:27), y=handle.cy.baseVal.value+(${i}<2?16:-16);
      const to=new DOMPoint(x,y).matrixTransform(matrix), fixed=[opposite.cx.baseVal.value,opposite.cy.baseVal.value];
      return {from:{x:Math.round(from.x),y:Math.round(from.y)},to:{x:Math.round(to.x),y:Math.round(to.y)},fixed,x,y,tolerance:Math.ceil(1/matrix.a)};`);
    win.webContents.sendInputEvent({type:'mouseDown',...corner.from,button:'left',clickCount:1});
    win.webContents.sendInputEvent({type:'mouseMove',...corner.to,modifiers:['leftButtonDown']});
    win.webContents.sendInputEvent({type:'mouseUp',...corner.to,button:'left',clickCount:1});
    const matches=await js(`const handles=[...document.querySelectorAll('.image-crop-guide circle')], target=handles[${i}], fixed=handles[3-${i}];
      return Math.abs(target.cx.baseVal.value-${corner.x})<=${corner.tolerance} && Math.abs(target.cy.baseVal.value-${corner.y})<=${corner.tolerance} &&
      fixed.cx.baseVal.value===${corner.fixed[0]} && fixed.cy.baseVal.value===${corner.fixed[1]};`);
    assert.ok(matches,'角点 '+i+' 拖动后应保留对角的位置');
  }
  await js(`const fields=[...document.querySelectorAll(".aux-crop-fields input")];[20,30,100,120].forEach((value,i)=>{fields[i].value=String(value);fields[i].dispatchEvent(new Event('input'));});`);
  assert.equal(await js('return document.querySelector(".image-crop-guide rect").getAttribute("width")'),'100');
  await capture('image-crop-selected');
  await click('裁剪');await until('document.querySelectorAll(".aux-image-dimensions input")[0].value==="100" && ![...document.querySelectorAll("button")].find(x=>x.textContent==="保存文件…").disabled','图片裁剪');await click('保存文件…');await until('window.saved.length===2','图片保存');await click('复制图片');await until('Boolean(window.copiedImage)','图片复制');
  const copied=await js('return window.copiedImage');assert.ok(copied.startsWith('data:image/png;'));

  for(const id of ['id','markdown','unicode','image','manual']){
    await mount(id,id==='image'?image:'',480,430);
    assert.equal(await js('const page=document.querySelector("main");return page.scrollWidth<=page.clientWidth+1'),true,id+' 窄窗口不能横向溢出');
    if(id==='id')await capture('id-compact');
    if(id==='image')await capture('image-compact');
  }


  await mount('selection','第一行：这段选中的内容会完整显示在可滚动区域中。\n第二行：即使文字较长，也不会被压缩成一条难以阅读的摘要。\n第三行：选择操作后即可继续处理。');
  assert.equal(await js('return window.controller.getActions().length'),7);assert.equal(await js('const list=document.querySelector(".selection-action-list"),last=list.lastElementChild;return last.getBoundingClientRect().bottom<=list.getBoundingClientRect().bottom+1;'),true);await capture('selection-text');
  await js('document.querySelector(".selection-action-list").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true}));');
  assert.equal(await js('return document.querySelector(".selection-action.selected").dataset.action'),'translate');
  await js('await window.controller.move(-1);');assert.equal((await js('return window.orders.text'))[0],'translate');
  await js('document.querySelector(".selection-action[data-action=copy]").click();document.querySelector(".selection-action-list").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));');await until('window.copied.startsWith("第一行")','选择内容复制');
  await mount('selection','https://example.com/docs?q=1');assert.deepEqual(await js('return window.controller.getActions()'),['openURL','copy','copyDomain','translate']);await js('await window.controller.activate({id:"copyDomain"});');assert.equal(await js('return window.copied'),'example.com');
  await mount('selection','{"answer":42}');await js('await window.controller.activate({id:"jsonCompact"});');assert.deepEqual(await js('return window.opened.at(-1)'),{id:'json',value:{text:'{"answer":42}',action:'compact'}});
  await mount('selection',{kind:'image',dataUrl:image});await capture('selection-image');await js('await window.controller.activate({id:"recognizeText"});');assert.equal(await js('return window.controller.getContent().text'),'识别结果：OpenAll');
  assert.equal(await js('return document.querySelector(".selection-summary").textContent'),'已识别 12 字');
  assert.ok(await js('return !document.querySelector(".selection-key-hint").textContent.includes("12 字")'));
  await capture('selection-ocr-result');
  await js('window.queue={active:true,items:[{id:"one",kind:"text",title:"会议纪要 · 产品体验"},{id:"two",kind:"text",title:"确认新版交互与快捷键"},{id:"three",kind:"text",title:"周五前完成回归测试"}]};window.context.api.stack=async(action,payload={})=>{if(action==="move"){const from=window.queue.items.findIndex(x=>x.id===payload.id),item=window.queue.items.splice(from,1)[0];window.queue.items.splice(payload.to,0,item);}if(action==="remove")window.queue.items=window.queue.items.filter(x=>x.id!==payload.id);if(action==="next"){window.queue.items.shift();if(!window.queue.items.length)window.queue.active=false;}if(action==="start")window.queue.active=true;if(action==="stop")window.queue.active=false;return structuredClone(window.queue);};window.context.api.onStackChanged=()=>()=>{};');
  await mount('stack');await capture('stack');assert.equal(await js('return document.querySelectorAll(".queue-row").length'),3);await js('document.querySelectorAll(".queue-row")[2].click();');await until('window.queue.items[0].id==="three"','堆栈置顶');await js('document.querySelectorAll(".queue-remove")[1].click();');await until('window.queue.items.length===2','堆栈移除');await click('粘贴下一项');await until('window.queue.items.length===1','堆栈取下一项');
  await js('window.controller?.dispose?.();');
  assert.equal(errors.length,0,errors.join('\n'));
  console.log('12 个辅助页面 + 3 个转换器模式：真实 Electron 渲染、操作与截图验证通过');
  console.log(destination);
  app.exit(0);
}).catch(error=>{console.error(error);app.exit(1);}).finally(()=>{fs.rmSync(temporary,{recursive:true,force:true});});
