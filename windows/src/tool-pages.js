(function(){
  'use strict';
  const pages=window.OpenAllPages ||= {}, core=window.OpenAllTools;
  function h(tag,attrs={},...children){const node=document.createElement(tag);for(const [key,value]of Object.entries(attrs)){if(key==='class')node.className=value;else if(key==='value')node.value=value;else if(key==='checked'||key==='disabled'||key==='readOnly')node[key]=value;else if(key.startsWith('on')&&typeof value==='function')node.addEventListener(key.slice(2),value);else if(value!=null)node.setAttribute(key,value);}for(const child of children.flat(Infinity)){if(child!=null)node.append(child instanceof Node?child:document.createTextNode(String(child)));}return node;}
  const button=(title,callback,kind='')=>h('button',{type:'button',class:'aux-button '+kind,onclick:callback},title);
  const input=(placeholder='',value='')=>h('input',{class:'aux-input',placeholder,value});
  const select=(items,value)=>{const field=h('select',{class:'aux-select'});for(const item of items){const [v,label]=Array.isArray(item)?item:[item,item];field.append(h('option',{value:v},label));}if(value!=null)field.value=value;return field;};
  let editorLoading,mermaidLoading;
  async function loadMermaid(){if(window.mermaid)return;if(!mermaidLoading)mermaidLoading=new Promise((resolve,reject)=>{const script=h('script',{src:'../assets/mermaid.min.js',onload:resolve,onerror:()=>{mermaidLoading=null;reject(Error('图表资源载入失败'));}});document.head.append(script);});await mermaidLoading;}
  async function loadToolEditor(){if(window.OpenAllJSONEditor)return;if(!editorLoading)editorLoading=new Promise((resolve,reject)=>{const script=h('script',{src:'../assets/editor-json.js',onload:resolve,onerror:()=>reject(Error('编辑器资源载入失败'))});document.head.append(script);});await editorLoading;}
  function editor(placeholder='',value='',readOnly=false,syntax=''){if(!syntax||!window.OpenAllJSONEditor)return h('textarea',{class:'aux-editor',placeholder,value,readOnly,spellcheck:'false','aria-label':placeholder||'文本内容'});
    const node=h('div',{class:'aux-editor aux-editor-frame editor-codemirror','aria-label':placeholder||'文本内容'}),findbar=h('div',{class:'aux-findbar',hidden:'true'}),query=input('查找内容'),counter=h('span',{class:'muted'}),job=worker();let instance,matches=[],active=-1,timer,serial=0,dead=false;
    const notice=text=>{const status=node.closest('.aux-tool')?.querySelector('.aux-status');if(status)setStatus(status,text,true);};
    function highlight(){instance?.setSearch(matches,active);}
    function next(direction=1){if(findbar.hidden){openFind();return;}if(!matches.length)return;active=(active+direction+matches.length)%matches.length;instance.reveal(matches[active].from,matches[active].to);highlight();counter.textContent=(active+1)+' / '+matches.length;}
    async function find(){const token=++serial;try{const result=await job.run('findText',instance.value,query.value,false);if(dead||token!==serial)return;matches=result.matches;active=matches.length?0:-1;highlight();counter.textContent=query.value?result.total?(result.total>5000?'前 5000 / '+result.total:'1 / '+result.total):'无匹配':'';if(matches.length)instance.reveal(matches[0].from,matches[0].to);}catch(error){if(!dead)notice(error.message);}}
    function closeFind(){findbar.hidden=true;serial++;matches=[];active=-1;highlight();instance.focus();}
    function openFind(){findbar.hidden=false;query.focus();query.select();find();}
    query.oninput=()=>{clearTimeout(timer);timer=setTimeout(find,100);};query.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();next(event.shiftKey?-1:1);}if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeFind();}};findbar.append(query,counter,button('↑',()=>next(-1),'quiet'),button('↓',()=>next(1),'quiet'),button('×',closeFind,'quiet'));
    instance=window.OpenAllJSONEditor.create({parent:node,syntax,placeholder,label:placeholder,readOnly,parameterMarks:readOnly && syntax==='sql',onNotice:notice,onFind:openFind,onFindNext:next,onFormat:()=>node.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true})),onViewport:()=>queueMicrotask(()=>{if(!dead)highlight();}),onChange:()=>{node.dispatchEvent(new Event('input',{bubbles:true}));if(!findbar.hidden){clearTimeout(timer);timer=setTimeout(find,150);}}});node.prepend(findbar);
    Object.defineProperties(node,{value:{get:()=>instance.value,set:value=>instance.setText(String(value))},selectionStart:{get:()=>instance.view.state.selection.main.from},selectionEnd:{get:()=>instance.view.state.selection.main.to}});node.focus=()=>instance.focus();node.setRangeText=(text,start,end)=>{instance.view.dispatch({changes:{from:start,to:end,insert:String(text)},selection:{anchor:start+String(text).length}});};node.setParameterMarks=spans=>instance.setParameterMarks(spans);node.disposeEditor=()=>{dead=true;clearTimeout(timer);job.dispose();instance.destroy();};node.value=value;return node;
  }
  const pane=(title,body,actions=[])=>h('section',{class:'aux-pane'},h('div',{class:'aux-pane-bar'},h('strong',{},title),h('div',{class:'aux-inline'},actions)),body);
  const label=(title,control)=>h('label',{class:'aux-label'},h('span',{},title),control);
  const check=(title,checked=true)=>{const box=h('input',{type:'checkbox',checked});return {box,node:h('label',{class:'aux-check'},box,title)};};
  const copy=async(ctx,text)=>{await ctx.api.copyText(String(text));ctx.notify('已复制');};
  function shell(root,name){root.replaceChildren();for(const value of [...root.classList])if(value.startsWith('aux-'))root.classList.remove(value);root.classList.add('aux-tool', 'aux-'+name);return h('div',{class:'aux-status',role:'status'});}
  function setStatus(status,text,error=false){status.textContent=text;status.classList.toggle('error',error);}
  function worker(){let source;const pending=new Map();let sequence=0,dead=false;return {run(action,...args){if(dead)return Promise.reject(Error('页面已关闭'));if(!source){source=new Worker('../assets/tool-worker.js');source.onmessage=e=>{const entry=pending.get(e.data.id);if(!entry)return;pending.delete(e.data.id);e.data.error?entry.reject(Error(e.data.error)):entry.resolve(e.data.result);};source.onerror=()=>{for(const entry of pending.values())entry.reject(Error('工具计算失败'));pending.clear();};}return new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});source.postMessage({id,action,args});});},dispose(){dead=true;source?.terminate();for(const entry of pending.values())entry.reject(Error('页面已关闭'));pending.clear();}};}
  // 列宽按比例适应容器，避免固定像素合计超过可用宽度。
  function table(columns, emptyMessage = '粘贴内容并运行分析，结果会显示在这里') {
    const totalWidth = columns.reduce((sum, column) => sum + (Array.isArray(column) ? column[1] : 0), 0);
    const head = h('thead',{},h('tr',{},columns.map(c => h('th',{},Array.isArray(c) ? c[0] : c))));
    const body = h('tbody'), footer = h('div',{class:'aux-table-footer'});
    const group = h('colgroup',{},columns.map(c => h('col',Array.isArray(c) ? {style:'width:'+c[1]/totalWidth*100+'%'} : {})));
    const node = h('div',{class:'aux-report'},h('table',{},group,head,body),footer);
    let markedRecord, pages = [], records = [], page = 0, count = 0, emptyText = emptyMessage;
    function render() {
      body.replaceChildren();
      for (const row of pages[page] || []) {
        const cells = Array.isArray(row) ? row : row.cells;
        body.append(h('tr',{class:[row.tone, row === markedRecord ? 'summary-row' : ''].filter(Boolean).join(' ')},cells.map(cell => h('td',cell instanceof Node ? {} : {title:String(cell ?? '')},cell ?? ''))));
      }
      if (!count) body.append(h('tr',{},h('td',{colspan:columns.length,class:'aux-empty'},emptyText)));
      const position = pages.length > 1 ? ' · 第 '+(page+1)+' / '+pages.length+' 页' : '';
      footer.replaceChildren(h('span',{},count ? count+' 项'+position : ''));
      if (pages.length > 1) {
        const previous = button('上一页',() => { page--; render(); }), next = button('下一页',() => { page++; render(); });
        previous.disabled = page === 0; next.disabled = page+1 >= pages.length;
        footer.append(previous,next);
      }
    }
    function set(rows, message = emptyMessage) {
      markedRecord = null; pages = []; records = rows; page = 0; count = 0; emptyText = message;
      let group = null, lastGroup = null;
      for (const row of rows) {
        if (row.tone === 'group') { group = row; continue; }
        if (count % 150 === 0) { pages.push([]); lastGroup = null; }
        const current = pages[pages.length-1];
        if (group && group !== lastGroup) { current.push(group); lastGroup = group; }
        current.push(row);
        count++;
      }
      render();
    }
    render();
    function locate(index) {
      const record = records[index];
      if (!record || record.tone === 'group') return;
      const found = pages.findIndex(items => items.includes(record));
      if (found < 0) return;
      if (page !== found) { page = found; render(); }
      const row = body.rows[pages[page].indexOf(record)];
      row.tabIndex = -1;
      row.focus({preventScroll:true});
      row.scrollIntoView({block:'nearest',inline:'nearest'});
    }
    function mark(index) {
      markedRecord = index == null ? null : records[index];
      const rendered = pages[page] || [];
      Array.from(body.rows).forEach((element, i) => {
        element.classList.toggle('summary-row', !!markedRecord && rendered[i] === markedRecord);
      });
    }
    return {node,set,locate,mark};
  }
  function copyButtonIcon(callback,title){const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');for(const [key,value]of Object.entries({viewBox:'0 0 24 24',width:18,height:18,fill:'none',stroke:'currentColor','stroke-width':1.5,'aria-hidden':'true'}))svg.setAttribute(key,value);const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d','M9 8h11v14H9zM15 8V2H3v14h6M15 2l5 6');svg.append(path);const result=button('',callback,'quiet aux-copy-icon');result.title=title;result.setAttribute('aria-label',title);result.append(svg);return result;}
  function backend(ctx,action,...args){return ctx.api.backendTask?ctx.api.backendTask(action,args):Promise.resolve(ctx.api.backend[action](...args));}

  pages.unicode=async(root,ctx)=>{
    const status=shell(root,'unicode'),job=worker(),source=editor('输入',ctx.initialValue||'你好，OpenAll 👋'),output=editor('结果','',true);let mode=source.value.includes('\\u')?'decode':'encode',timer,sequence=0,dead=false;
    const modes=h('div',{class:'aux-tabs wide'}),encode=button('编码',()=>{mode='encode';refresh();}),decode=button('解码',()=>{mode='decode';refresh();});modes.append(encode,decode);
    const fill=button('填回输入',()=>{if(!output.value)return;source.value=output.value;mode=mode==='encode'?'decode':'encode';refresh();}),copyResult=button('复制结果',()=>copy(ctx,output.value),'accent');
    const sourceHeading=h('span'), resultHeading=h('span');
    root.append(modes,h('div',{class:'aux-split'},pane(sourceHeading,source),pane(resultHeading,output,[fill,copyResult])),status);
    async function refresh(){
      const serial=++sequence, encoding=mode==='encode';
      for(const [control,active] of [[encode,encoding],[decode,!encoding]]){
        control.classList.toggle('active',active);control.setAttribute('aria-pressed',String(active));
      }
      sourceHeading.textContent=encoding?'原文':'Unicode 转义';
      resultHeading.textContent=encoding?'Unicode 转义':'解码文本';
      source.setAttribute('aria-label',sourceHeading.textContent);output.setAttribute('aria-label',resultHeading.textContent);
      fill.disabled=copyResult.disabled=true;
      if(!source.value){output.value='';setStatus(status,encoding?'输入文本后自动编码':'输入 Unicode 转义后自动解码');return;}
      try{
        setStatus(status,'正在转换…');
        const result=await job.run(encoding?'unicodeEncode':'unicodeDecode',source.value);
        if(dead||serial!==sequence)return;
        output.value=result;fill.disabled=copyResult.disabled=!result;
        setStatus(status,encoding?'已将非 ASCII 字符转换为 Unicode 转义':'Unicode 转义已还原为文本');
      }catch(error){if(!dead&&serial===sequence){output.value='';setStatus(status,error.message,true);}}
    }
    source.addEventListener('input',()=>{sequence++;fill.disabled=copyResult.disabled=true;clearTimeout(timer);timer=setTimeout(refresh,80);});
    await refresh();
    return {focus:()=>source.focus(),paste(text){source.setRangeText(text,source.selectionStart,source.selectionEnd,'end');refresh();},dispose(){dead=true;clearTimeout(timer);job.dispose();}};
  };
  pages.id=async(root,ctx)=>{
    const status=shell(root,'id'),province=select([['','随机省份'],...core.provinces.map((v,i)=>[i,v.name])]),city=select([['','随机城市']]),region=select([['','随机区县']]),gender=select(['随机性别','男','女']),age=input('周岁'),year=input('年'),month=input('月'),day=input('日'),count=input('1–500','5');[age,year,month,day,count].forEach(field=>field.inputMode='numeric');const heading=h('strong',{},'生成结果'),result=h('div',{class:'aux-id-results'});
    for(const [field,name] of [[province,'省份'],[city,'城市'],[region,'区县'],[gender,'性别'],[age,'年龄'],[year,'出生年份'],[month,'出生月份'],[day,'出生日期'],[count,'生成数量']])field.setAttribute('aria-label',name);
    let numbers=[];
    for(const [name,field]of Object.entries({province,city,region,gender,age,year,month,day,count}))field.dataset.idPart=name;
    const selectedIndex=field=>field.value===''?undefined:Number(field.value);
    const selectedProvince=()=>core.provinces[selectedIndex(province)];
    const selectedCity=()=>selectedProvince()?.cities[selectedIndex(city)];
    const updateTitle=field=>{field.title=field.selectedOptions[0]?.title||field.selectedOptions[0]?.textContent||'';};
    function resetOptions(field,placeholder,values,enabled){field.replaceChildren(h('option',{value:''},placeholder),...values.map((value,index)=>h('option',{value:index,title:value.name+' · '+value.code},value.name)));field.value='';field.disabled=!enabled;updateTitle(field);}
    // 上级变更时清空下级，随机项只在已选择的行政范围内取样。
    province.onchange=()=>{resetOptions(city,'随机城市',selectedProvince()?.cities||[],province.value!=='');resetOptions(region,'随机区县',[],false);updateTitle(province);};
    city.onchange=()=>{resetOptions(region,'随机区县',selectedCity()?.regions||[],city.value!=='');updateTitle(city);};
    region.onchange=()=>updateTitle(region);province.onchange();
    const dateFields = label('出生日期', h('div',{class:'aux-inline'}, year,month,day));
    const ageField = label('周岁',age);
    const birthHint = h('span',{class:'aux-id-rule muted'},'留空时随机生成');
    const mode = select([['date','填写生日'],['age','按周岁推算']],'date');
    mode.setAttribute('aria-label','生日输入方式');
    function updateBirthMode() {
      const useAge = mode.value === 'age';
      ageField.hidden = !useAge;
      dateFields.hidden = useAge;
      birthHint.textContent = useAge
        ? (age.value && year.value ? [year.value,month.value.padStart(2,'0'),day.value.padStart(2,'0')].join('-') : '沿用今天的月日')
        : '留空时随机生成';
    }
    mode.onchange = () => {
      if (mode.value === 'date') { age.value = ''; age.removeAttribute('aria-invalid'); }
      updateBirthMode();
      (mode.value === 'age' ? age : year).focus();
    };
    updateBirthMode();
    const birthdayText=value=>value.year+'-'+String(value.month).padStart(2,'0')+'-'+String(value.day).padStart(2,'0');
    function applyAge(){
      const value=age.value.trim();if(!value){age.removeAttribute('aria-invalid');return null;}
      try{if(!/^\d+$/.test(value))throw Error('年龄需为非负整数');const birthday=core.birthdayFromAge(Number(value));year.value=String(birthday.year);month.value=String(birthday.month);day.value=String(birthday.day);age.removeAttribute('aria-invalid');return birthday;}
      catch(error){age.setAttribute('aria-invalid','true');throw Error(error.message+'；请修正或清空年龄');}
    }
    age.oninput=()=>{mode.value='age';try{const birthday=applyAge();updateBirthMode();setStatus(status,birthday?'已按 '+Number(age.value)+' 岁回填 '+birthdayText(birthday)+(birthday.clamped?' · 目标年份无 2 月 29 日，已取 2 月 28 日':' · 可直接修改出生日期'):'已清空年龄，保留当前出生日期');}catch(error){setStatus(status,error.message,true);}};
    // 手动编辑优先；清空年龄只解除联动，不清除已经填入的生日。
    for(const field of [year,month,day])field.oninput=()=>{age.value='';age.removeAttribute('aria-invalid');mode.value='date';updateBirthMode();setStatus(status,'出生日期已手动修改，年龄联动已清除');};
    const generate=button('生成测试号',()=>{try{const birthday=applyAge(),numeric=field=>{if(!field.value.trim())return undefined;if(!/^\d+$/.test(field.value.trim()))throw Error('日期和数量只能填写整数');return Number(field.value);};numbers=core.generateIDs({provinceIndex:selectedIndex(province),cityIndex:selectedIndex(city),regionIndex:selectedIndex(region),gender:gender.value,year:numeric(year),month:numeric(month),day:numeric(day),count:numeric(count)??1});heading.textContent=`测试号码 · ${numbers.length} 条`;
      result.replaceChildren(...numbers.map((value,index)=>{
        const copyRow=button('复制',async()=>{
          await ctx.api.copyText(value);
          setStatus(status,'已复制第 '+(index+1)+' 条测试号');
        },'quiet');
        copyRow.setAttribute('aria-label','复制第 '+(index+1)+' 条测试号');
        return h('div',{class:'aux-id-row'},h('span',{class:'muted'},index+1),h('code',{},h('span',{},value.slice(0,6)),h('span',{},value.slice(6,14)),h('span',{},value.slice(14))),copyRow);
      }));
      setStatus(status,birthday?'出生日期 '+birthdayText(birthday):'');
    }catch(error){setStatus(status,error.message,true);}},'primary');
    root.append(h('div',{class:'aux-id-top'},label('省份',province),label('城市',city),label('区县',region)),h('div',{class:'aux-id-date'},label('生日输入方式',mode),dateFields,ageField,birthHint),h('div',{class:'aux-id-options'},label('性别',gender),label('生成数量 · 1–500',count),generate),h('div',{class:'aux-section-bar'},heading,button('复制全部',()=>copy(ctx,numbers.join('\n')),'accent')),result,status);const keydown=event=>{if(event.key==='Enter'&&event.target.matches('input')&&!event.isComposing){event.preventDefault();generate.click();}};root.addEventListener('keydown',keydown);generate.click();return {focus:()=>mode.focus(),dispose(){root.removeEventListener('keydown',keydown);}};
  };
  pages.converter=async(root,ctx)=>{
    const status=shell(root,'converter'),job=worker(),modes=h('div',{class:'aux-tabs wide',role:'group','aria-label':'转换模式'}),content=h('div',{class:'aux-converter-body'});let mode='duration',timer,dead=false,cronSequence=0;const tabs=[['duration','时间单位'],['cron','Cron 表达式'],['ascii','ASCII 码表']];root.append(modes,content,status);
    async function render(){modes.replaceChildren(...tabs.map(([id,title])=>{const tab=button(title,()=>{mode=id;render();},mode===id?'active':'');tab.setAttribute('aria-pressed',String(mode===id));return tab;}));content.replaceChildren();setStatus(status,'');
      if(mode==='duration'){const value=input('例如 1.5',/^-?[\d.]+$/.test(ctx.initialValue||'')?ctx.initialValue:'1'),unit=select(core.durationUnits.map(([name,symbol],index)=>[index,`${name} (${symbol})`]),6),summary=h('h3',{class:'aux-unit-summary','aria-live':'polite'},'换算结果'),list=h('div',{class:'aux-conversion-results'});content.append(h('div',{class:'aux-duration-fields'},label('输入时长',value),label('单位',unit),h('p',{class:'muted'},'年按 365 天、月按 30 天计算。')),h('div',{class:'aux-conversion-output'},summary,list));const update=()=>{const rows=value.value.trim()?core.durationRows(Number(value.value),Number(unit.value)):[];
        const source = Number(unit.value), target = source === 6 ? 7 : 6;
        if (!rows.length) summary.textContent = '换算结果';
        else if (rows[target].value === '超出范围') summary.textContent = '换算超出范围';
        else {
          const converted = Number(value.value)*core.durationUnits[source][2]/core.durationUnits[target][2];
          const shown = Number(rows[target].value), rounding = Math.max(Math.abs(shown),Math.abs(converted))*(Number.EPSILON*4);
          const sign = Math.abs(shown-converted)<=rounding && (shown!==0 || Number(value.value)===0) ? '=' : '≈';
          summary.textContent = value.value.trim()+' '+core.durationUnits[source][0].split(' · ')[0]+' '+sign+' '+rows[target].value+' '+core.durationUnits[target][0];
        }
        const ordered = rows.length ? [target,...[9,8,7,6,5,4,3,2,1,0].filter(index=>index!==target)] : [];
        list.replaceChildren(...ordered.map(index=>{const row = rows[index];return h('div',{class:'aux-conversion-row'+(index===target?' target':'')},h('span',{class:'muted'},row.title),h('code',{title:row.value},core.durationDisplay(row.value)),copyButtonIcon(()=>copy(ctx,row.value),'复制完整数值'));}));if(!value.value.trim()||!rows.length)setStatus(status,'请输入有效数字',true);else setStatus(status,'点击行末图标可复制完整精度的数值');};value.oninput=unit.onchange=update;update();}
      if(mode==='cron'){const field=input('分 时 日 月 周','*/15 9-18 * * 1-5'),description=h('p',{class:'aux-cron-summary'}),results=h('div',{class:'aux-cron-times'}),parts=h('div',{class:'aux-cron-fields'}),presets=h('div',{class:'aux-inline'});try{core.cronParse(ctx.initialValue||'');field.value=ctx.initialValue;}catch{}const update=async()=>{const serial=++cronSequence;try{const parsed=core.cronParse(field.value);description.textContent=core.cronSummary(parsed);const dates=await job.run('cronNext',field.value,new Date(),5);if(dead||mode!=='cron'||serial!==cronSequence)return;const groups=new Map();
          dates.forEach((raw,index)=>{
            const instant=new Date(raw), full=instant.toLocaleString('sv-SE',{timeZone:'Asia/Shanghai'}), weekday=instant.toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai',weekday:'long'});
            const [date,clock]=full.split(' '), key=date+' '+weekday;
            if(!groups.has(key)) groups.set(key,[]);
            const occurrence=button(clock,()=>copy(ctx,full+' '+weekday),'quiet aux-cron-row'+(index===0?' next':''));
            occurrence.title='复制 '+full+' '+weekday;
            occurrence.setAttribute('aria-label',(index===0?'下一次，':'')+occurrence.title);
            groups.get(key).push(occurrence);
          });
          results.replaceChildren(h('h3',{},'未来执行时间',h('small',{class:'aux-cron-zone'},'北京时间 UTC+8')),
            ...Array.from(groups,([day,items])=>h('div',{class:'aux-cron-day'},h('span',{},day),h('div',{},items))));if(!dates.length)results.append(h('p',{class:'muted'},'未来五年内没有匹配的时间'));parts.replaceChildren(h('h3',{},'字段解析'),...parsed.fields.map((part,index)=>h('div',{},h('span',{class:'muted'},['分钟','小时','日期','月份','星期'][index]),h('code',{},part==='*'?'任意':part))));setStatus(status,'结果仅在本机计算 · 日期与星期同时指定时为“或”关系');}catch(error){description.textContent='';results.replaceChildren();parts.replaceChildren();setStatus(status,error.message,true);}};for(const [name,sample] of [['工作日 · 每 15 分钟','*/15 9-18 * * 1-5'],['工作日 · 09:00','0 9 * * 1-5'],['每月 1 日 · 08:30','30 8 1 * *']]){
          const preset=button(name,()=>{field.value=sample;update();},'quiet');preset.title=sample;presets.append(preset);
        }field.oninput=()=>{clearTimeout(timer);timer=setTimeout(update,120);};content.append(label('Cron 表达式',field),presets,description,h('div',{class:'aux-cron-grid'},results,parts));await update();}
      if(mode==='ascii'){const field=input('搜索字符、十进制或十六进制'),category=select([['printable','可打印字符'],['control','控制字符'],['all','全部字符']]),matchLabel=h('strong',{class:'aux-ascii-match','aria-live':'polite'}),report=table([['十进制',110],['十六进制',140],['字符',106],['说明',374],['复制字符',90]],'没有匹配的字符，可试试 A、65 或 0x41');const update=()=>{const rows=core.asciiRows(field.value,field.value?'all':category.value);
        const term = field.value.trim();
        const match = rows.find(row => String(row.number) === term || row.hex.toLowerCase() === term.toLowerCase())
          || rows.find(row => row.character === term || (term.length > 1 && row.character.toLowerCase() === term.toLowerCase()));
        matchLabel.textContent = match ? match.character+'  ·  十进制 '+match.number+'  ·  '+match.hex : '';
        report.set(rows.map(row=>[row.number,row.hex,h('strong',{class:'ascii-glyph'},row.character),core.asciiDescription(row.number),copyButtonIcon(()=>copy(ctx,String.fromCharCode(row.number)),'复制字符：'+row.character)]));setStatus(status,`${rows.length} 项 · ASCII 范围 0–127`);;
          [...report.node.querySelectorAll('tbody tr')].forEach((tr,index)=>{
            if(tr.cells.length!==5)return;
            tr.tabIndex=index===0?0:-1;
            const action=tr.querySelector('button');
            tr.setAttribute('aria-label',action.getAttribute('aria-label'));
            action.tabIndex=-1;
          });
        };report.node.addEventListener('click',event=>{
          const row=event.target.closest('tbody tr');
          if(row?.cells.length===5 && !event.target.closest('button') && !window.getSelection()?.toString()) row.querySelector('button')?.click();
        });report.node.addEventListener('keydown',event=>{
          const tr=event.target.closest('tbody tr');
          if(!tr || tr.cells.length!==5)return;
          if(['Enter',' '].includes(event.key)){event.preventDefault();tr.querySelector('button')?.click();return;}
          if(!['ArrowUp','ArrowDown'].includes(event.key))return;
          event.preventDefault();
          const next=event.key==='ArrowUp'?tr.previousElementSibling:tr.nextElementSibling;
          if(next){tr.tabIndex=-1;next.tabIndex=0;next.focus();}
        });field.oninput=category.onchange=update;content.append(h('div',{class:'aux-inline aux-ascii-lookup'},field,category,matchLabel),report.node);update();}
    }
    if(ctx.initialValue){try{core.cronParse(ctx.initialValue);mode='cron';}catch{}}await render();return {dispose(){dead=true;clearTimeout(timer);job.dispose();}};
  };
  const backendInputs=new Map();
  function backendTabs(active,ctx){
    const tools=[['configDiff','结构化配置对比'],['explain','SQL 执行计划'],['logTimeline','日志时间线'],['sqlRestore','SQL 参数还原']];
    const tabs=tools.map(([id,title])=>{
      const tab=button(title,()=>ctx.openPage(id),active===id?'active':'');
      tab.setAttribute('aria-pressed',String(active===id));
      return tab;
    });
    return h('div',{class:'aux-tabs wide',role:'group','aria-label':'分析工具'},tabs);
  }
  function backendPage(id){return async(root,ctx)=>{
    await loadToolEditor();const syntax=id==='configDiff'?'config':id==='sqlRestore'?'sql':'json';
    const status=shell(root,'backend'),old=backendInputs.get(id)||{},left=editor('粘贴内容',ctx.initialValue||old.left||'',false,syntax),right=editor('粘贴另一份内容',old.right||'',false,id==='sqlRestore'?'json':syntax),copyButton=button('复制结果',()=>copy(ctx,copyValue),'quiet'),actions=h('div',{class:'aux-actions'}),body=h('div',{class:'aux-backend-body'});let copyValue='',sequence=0,dead=false,logs=[];copyButton.disabled=true;
    const titles = {configDiff:'差异结果',explain:'计划节点',logTimeline:'事件时间线',sqlRestore:'还原结果'};
    const headline = h('strong', {class:'aux-report-title'}, titles[id]);
    let target = null;
    const locateButton = button('定位到行', () => target?.report.locate(target.index), 'quiet aux-locate');
    locateButton.title = '定位到摘要对应的行（Ctrl+L）';
    locateButton.hidden = true;
    function setHeadline(message, attention = false, destination = null) {
      if (target && target.report !== destination?.report) target.report.mark(null);
      target = destination;
      target?.report.mark(target.index);
      locateButton.hidden = !target;
      headline.textContent = message;
      body.classList.toggle('has-finding', attention);
    }
    body.dataset.mode=id;root.append(backendTabs(id,ctx),body,status);
    async function run(action,...args){const serial=++sequence;setHeadline(titles[id]);body.classList.remove('stale-result');setStatus(status,'正在本机处理…');copyButton.disabled=true;try{const result=await backend(ctx,action,...args);if(dead||serial!==sequence)return null;return result;}catch(error){if(!dead&&serial===sequence){copyValue='';setStatus(status,error.message,true);}return null;}}
    function complete(value, summary, detail, attention = false, destination = null) {
      copyValue = value;
      copyButton.disabled = !value;
      body.classList.remove('stale-result');
      setHeadline(summary, attention, destination);
      setStatus(status, detail);
      fitReport();
    }
    function fitReport() {
      if(!ctx.api.windowAction)return;
      requestAnimationFrame(()=>{
        if(dead || !copyValue)return;
        const report=body.querySelector(':scope > .aux-report:not([hidden])');
        const output=id==='sqlRestore'?body.querySelector(':scope > .aux-pane'):report;
        if(!output)return;
        let height;
        if(id==='sqlRestore'){
          const lines=copyValue.split('\n',16).length;
          height=body.classList.contains('short-sql')?54:Math.min(350,Math.max(116,lines*22+26));
          if(report)height+=Math.min(90,report.scrollHeight)+12;
        }else{
          height=Math.min(360,report.querySelector('table').offsetHeight+report.querySelector('.aux-table-footer').offsetHeight+4);
        }
        ctx.api.windowAction('fitBackendReport',{height:output.getBoundingClientRect().top+height+22});
      });
    }
    function invalidate(event){
      if(event && event.target.closest('.aux-findbar'))return;
      if(!sequence)return;
      sequence++;
      copyValue=''; copyButton.disabled=true; logs=[];
      body.classList.add('stale-result');
      setHeadline(titles[id]);
      setStatus(status,'输入已更改，请重新运行');
    }
    for(const field of [left,right])field.addEventListener('input',invalidate);
    if(id==='configDiff'){left.placeholder=right.placeholder='粘贴 JSON、YAML 或 .properties';const report=table([['变更',78],['字段路径',275],['原值',200],['新值',250]]),format=select([['auto','自动识别格式'],['json','JSON'],['yaml','YAML'],['properties','Properties']]),reveal=check('结果显示敏感值',false);async function analyze(){report.set([]);const rows=await run('configDiff',left.value,right.value,format.value,reveal.box.checked);if(!rows)return;report.set(rows.map(row=>({tone:row.status==='新增'?'added':row.status==='删除'?'removed':'changed',cells:[({'变化':'~ 修改','新增':'+ 新增','删除':'− 删除'})[row.status],row.key,h('span',{title:row.left},row.left,h('small',{},row.leftType?' · '+row.leftType:'')),h('span',{title:row.right},row.right,h('small',{},row.rightType?' · '+row.rightType:''))]})),'没有变更记录');
      const visible = rows.filter(row => !/pass(word|wd)?|secret|token|credential|authorization|api.?key|private.?key|私钥|密码/i.test(row.key));
      const first = visible.find(row => row.status === '变化') || visible[0];
      const title = rows.length ? rows.length + ' 项变更' : '两份配置相同';
      complete(rows.map(row=>`${row.status} ${row.key}\n  ${row.left} [${row.leftType}] → ${row.right} [${row.rightType}]`).join('\n\n'),title,['新增','变化','删除'].map(kind => {
        const count = rows.filter(row => row.status === kind).length;
        return count ? (kind === '变化' ? '修改' : kind) + ' ' + count : '';
      }).filter(Boolean).join('　'),false,first ? {report,index:rows.indexOf(first)} : null);}actions.append(button('比较配置',analyze,'primary'),format,reveal.node,h('span',{class:'aux-spacer'}),copyButton);body.append(h('div',{class:'aux-split inputs'},pane('左侧配置',left),pane('右侧配置',right)),actions,report.node);reveal.box.onchange=analyze;format.onchange=invalidate;}
    if (id === 'explain') {
      left.placeholder = '支持 PostgreSQL JSON、文本；MySQL JSON、TREE、表格';
      const report = table([['计划节点',170],['对象 / 索引',170],['估算行',90],['实际行',90],['耗时 ms',90],['观察项',338]]);
      async function analyzePlan() {
        report.set([]);
        const rows = await run('explain', left.value);
        if (!rows) return;
        let largest = null, scans = 0, firstScan = '', firstScanIndex = -1, measurement = '';
        report.set(rows.map((row,index) => {
          const node = row.relation || row.name.split(' (')[0].trim();
          const notes = [];
          if (row.warning) {
            scans++;
            if (!firstScan) {
              firstScan = node; firstScanIndex = index;
              measurement = [row.engine !== 'MySQL · JSON' && row.actual !== '' && row.actual != null ? '实际 '+row.actual+' 行' : '',
                row.time !== '' && row.time != null ? '耗时 '+row.time+' ms' : ''].filter(Boolean).join(' · ');
            }
            notes.push('全表扫描');
          }
          // MySQL JSON 的连接输出也是估算值，不能拿它当实测行数。
          const measured = row.engine === 'MySQL · JSON' ? null : row.actual;
          if (row.engine === 'MySQL · JSON' && row.actual !== '' && row.actual != null) notes.push('估算输出 ' + row.actual + ' 行');
          if (row.engine === 'MySQL · 表格' && row.detail) notes.push(row.detail);
          const estimate = Number(row.estimated), actual = Number(measured);
          const ratio = Math.max(estimate, actual) / Math.min(estimate, actual);
          const deviation = estimate > 0 && actual > 0 && Number.isFinite(ratio) && ratio >= 10;
          if (deviation) {
            const label = '估算偏' + (estimate > actual ? '高 ' : '低 ') + Math.round(ratio) + ' 倍';
            notes.push('行数偏差');
            if (!largest || ratio > largest.ratio) largest = { ratio, label, node, index, estimate:row.estimated, actual:measured };
          }
          return {tone:deviation ? 'estimate-gap' : '', cells:[
            '　'.repeat(Math.min(row.depth || 0,12)) + row.name, [row.relation,row.index].filter(Boolean).join(' / ') || '—',
            String(row.estimated ?? '') || '—', String(measured ?? '') || '—', String(row.time ?? '') || '—', notes.join(' · ') || '—'
          ]};
        }));
        const title = largest ? largest.node.slice(0,48) + ' · ' + largest.label : scans === 1 ? firstScan.slice(0,48) + ' 使用全表扫描' :
          scans ? scans + ' 个节点使用全表扫描' : rows.length + ' 个计划节点';
        const detail = [largest ? '估算 '+largest.estimate+' 行 · 实际 '+largest.actual+' 行' : scans === 1 ? measurement : '',rows[0]?.engine, (largest || scans) ? rows.length + ' 个节点' : ''].filter(Boolean).join(' · ');
        if (rows.length && !left.hidden) toggleSource.click();
        complete(rows.map(row => '  '.repeat(row.depth || 0) + (row.warning ? '⚠ ' : '') + row.name + ' · ' + row.detail).join('\n'), title, detail, !!largest,largest || scans === 1 ? {report,index:largest?.index ?? firstScanIndex} : null);
      }
      actions.append(button('分析计划',analyzePlan,'primary'),h('span',{class:'aux-spacer'}),copyButton);
      const sourcePane=pane('原始执行计划',left);
      const toggleSource=button('收起原文',()=>{
        left.hidden=!left.hidden;
        toggleSource.textContent=left.hidden?'展开原文':'收起原文';
        toggleSource.setAttribute('aria-expanded',String(!left.hidden));
        sourcePane.classList.toggle('source-collapsed',left.hidden);
        fitReport();
      },'quiet');
      toggleSource.setAttribute('aria-expanded','true');
      actions.insertBefore(toggleSource,actions.children[1]);
      body.append(sourcePane,actions,report.node);
    }
    if(id==='sqlRestore'){left.placeholder='SELECT * FROM users WHERE id = ?';right.placeholder='Parameters: 42(Integer) 或 [42]、{"id":42}';const output=editor('还原后的 SQL','',true,'sql'),report=table(['已替换','未匹配占位符','未使用参数']);
      const sqlText = output.querySelector('.cm-content') || output;
      sqlText.tabIndex = 0;
      sqlText.setAttribute('aria-readonly','true');
      actions.append(button('还原 SQL',async()=>{output.value='';if(!left.value.trim()){report.node.hidden=true;setHeadline(titles[id]);setStatus(status,'请输入带占位符的 SQL');return;}const result=await run('restoreSQL',left.value,right.value);if(!result)return;output.value=result.sql;output.setParameterMarks?.(result.replacementRanges);
        body.classList.toggle('short-sql',result.sql.length <= 180 && result.sql.split('\n').length <= 2);
        report.set([[result.replaced,result.missing.join('、')||'无',result.unused.join('、')||'无']]);const pending = result.unresolved > 0 || result.unused.length > 0;
        const title = result.unresolved ? result.unresolved + ' 个占位符缺少参数' : result.unused.length ? result.unused.length + ' 个参数未使用' :
          result.replaced ? '已还原 ' + result.replaced + ' 个占位符' : 'SQL 中没有占位符';
        const details = pending ? ['已还原 ' + result.replaced + ' 处',result.unresolved && result.unused.length ? result.unused.length + ' 个参数未使用' : ''].filter(Boolean).join(' · ') : '';
        report.node.hidden = !pending;
        complete(result.sql,title,details,pending);},'primary'),h('span',{class:'aux-spacer'}),copyButton);body.append(h('div',{class:'aux-split inputs'},pane('带占位符的 SQL',left),pane('参数日志',right)),actions,pane('还原结果',output),report.node);report.node.classList.add('summary');report.node.hidden=true;body.querySelector(':scope > .aux-pane .aux-pane-bar')?.remove();}
    if(id==='logTimeline'){left.placeholder='每行一条日志，最多解析 10000 行';const group=select([['','先识别字段']]),time=select([['','原始顺序']]),manual=input('字段名=正则表达式（使用第 1 个捕获组）',old.rule||''),manualHolder=h('div',{class:'aux-inline aux-log-rule',hidden:'true'},manual),report=table([['时间 / 聚合项',320],['级别',96],['消息',532]]);async function renderGroups(){if(!logs.length||!group.value)return;const groups=await run('logGroups',logs,group.value,time.value);if(!groups)return;const rows=[];let errors=0, warnings=0, representative=null;const affected=new Set();for(const g of groups){
          const startTime = String(g.entries[0]?.fields[time.value] ?? '');
          const datePrefix = /^\d{4}-\d{2}-\d{2}/.exec(startTime)?.[0];
          const start = Date.parse(startTime);
          rows.push({tone:'group',cells:[h('span',{},g.name,datePrefix?h('small',{},'　'+datePrefix):null),`${g.entries.length} 条`,'']});
          for(const row of g.entries) {
          const level = row.fields.level || row.fields.severity || row.fields.loglevel || '—';
          const normalized = String(level).trim().toUpperCase();
          const error = ['ERROR','ERR','FATAL','CRITICAL','CRIT','PANIC','EMERG','EMERGENCY','ALERT','错误','严重'].includes(normalized);
          const warn = ['WARN','WARNING','警告'].includes(normalized);
          if (error) errors++;
          if (warn) warnings++;
          if (error || warn) {
            affected.add(g.name);
            const rank = error ? 2 : 1;
            if (!representative || rank > representative.rank || (rank === representative.rank && row.position < representative.position)) {
              const message = String(row.fields.message || row.fields.msg || '').slice(0,400);
              // 只提取白名单中的故障类别和追踪标识。日志正文留在表格内。
              let kind = '';
              if (/超时|timeout|timed out/i.test(message)) kind = /数据库|database|sql|postgres/i.test(message) ? '数据库超时' : '请求超时';
              else if (/权限不足|permission denied|access denied|forbidden/i.test(message)) kind = '访问被拒绝';
              else if (/连接被拒绝|connection refused|econnrefused/i.test(message)) kind = '连接被拒绝';
              else if (/服务不可用|service unavailable/i.test(message)) kind = '服务不可用';
              const request = ['requestId','request_id','traceId','trace_id','trace.id'].map(key=>row.fields[key])
                .find(value => typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,64}$/.test(value));
              representative = {rank,index:rows.length,position:row.position,title:[request ? '请求 ' + request.slice(0,32) + (request.length > 32 ? '…' : '') : '',kind].filter(Boolean).join(' · ')};
            }
          }
          const stamp=String(row.fields[time.value] ?? '');
          const clock=datePrefix && stamp.startsWith(datePrefix) ? stamp.slice(11).replace(/(?:Z|[+-]\d{2}:?\d{2})$/,'') : stamp;
          const elapsed=(Date.parse(stamp)-start)/1000;
          const label=Number.isFinite(elapsed) && elapsed>0 ? '  +'+Number(elapsed.toFixed(3))+'s' : '';
          rows.push({tone:error ? 'log-error' : warn ? 'log-warning' : '', cells:[h('span',{title:stamp},clock || '#'+(row.position+1),h('small',{},label)),level,row.fields.message || row.fields.msg || row.raw]});
        }}report.set(rows);
        const alerts = [errors ? errors+' 条错误' : '', warnings ? warnings+' 条警告' : ''].filter(Boolean).join(' · ');
        complete(groups.map(g=>`▸ ${g.name} · ${g.entries.length} 条\n`+g.entries.map(row=>'  '+(row.fields[time.value]||'#'+(row.position+1))+'  '+row.raw).join('\n')).join('\n\n'),representative?.title || alerts || '已整理事件时间线',
        [representative?.title ? alerts : '',logs.length+' 条日志',groups.length+' 个分组',affected.size>1 ? '涉及 '+affected.size+' 个分组' : ''].filter(Boolean).join(' · '), !!affected.size,representative ? {report,index:representative.index} : null);}
      const recognize=button('识别字段',async()=>{report.set([]);const parsed=await run('parseLogs',left.value,manual.value);if(!parsed)return;logs=parsed;const fields=await run('logFields',logs);if(!fields)return;group.replaceChildren(...fields.map(v=>h('option',{value:v.key},`${v.key}（${v.count} 条）`)));time.replaceChildren(h('option',{value:''},'原始顺序'),...fields.map(v=>h('option',{value:v.key},v.key)));const request=fields.find(v=>['requestid','traceid','trace.id'].includes(v.key.toLowerCase()));if(request)group.value=request.key;const detected=fields.find(v=>/time|时间|timestamp|date/i.test(v.key));if(detected)time.value=detected.key;if(!fields.length){setStatus(status,'没有识别到字段，可展开手动规则补充提取');return;}await renderGroups();if(left.value.split('\n').length>10000 && logs.length)setStatus(status,status.textContent+' · 仅前 10000 行');},'primary');group.onchange=time.onchange=renderGroups;
      actions.append(recognize,label('聚合字段',group),label('时间字段',time),button('手动规则',()=>{manualHolder.hidden=!manualHolder.hidden;if(!manualHolder.hidden)manual.focus();},'quiet'),h('span',{class:'aux-spacer'}),copyButton);body.append(pane('粘贴 JSON Lines 或 key=value 日志',left),actions,manualHolder,report.node);body.dataset.rule=manual.value;manual.oninput=()=>{body.dataset.rule=manual.value;invalidate();};
    }
    const result=body.querySelector(id==='sqlRestore'?':scope > .aux-pane':':scope > .aux-report');
    const reportHeading=h('div',{class:'aux-section-bar aux-report-heading'},h('div',{class:'aux-report-reading','aria-live':'polite'},headline,status),h('div',{class:'aux-inline'},locateButton,copyButton));
    if (id === 'sqlRestore') {
      copyButton.textContent = '复制 SQL';
      copyButton.setAttribute('aria-label','复制还原后的完整 SQL');
    }
    body.insertBefore(reportHeading,result);
    let activeEditor=left;for(const field of [left,right])field.addEventListener('focusin',()=>activeEditor=field);const keydown=event=>{if((event.ctrlKey||event.metaKey)&&!event.altKey && event.key.toLowerCase()==='l' && target){event.preventDefault();locateButton.click();return;}if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){event.preventDefault();actions.querySelector('.primary')?.click();}};root.addEventListener('keydown',keydown);return {focus:()=>left.focus(),paste(text){activeEditor.setRangeText(text,activeEditor.selectionStart,activeEditor.selectionEnd,'end');if(activeEditor instanceof HTMLTextAreaElement)invalidate();activeEditor.focus();},dispose(){root.removeEventListener('keydown',keydown);dead=true;sequence++;backendInputs.set(id,{left:left.value,right:right.value,rule:body.dataset.rule??old.rule??''});for(const node of root.querySelectorAll('.aux-editor-frame'))node.disposeEditor?.();}};
  };}
  for(const id of ['configDiff','explain','logTimeline','sqlRestore'])pages[id]=backendPage(id);

  function sanitizeHTML(markup){const doc=new DOMParser().parseFromString(markup,'text/html');doc.querySelectorAll('script,iframe,object,embed,form,style,link,meta,base').forEach(node=>node.remove());for(const node of doc.body.querySelectorAll('*')){for(const attr of [...node.attributes]){const key=attr.name.toLowerCase();if(key.startsWith('on')||['srcdoc','action','formaction'].includes(key))node.removeAttribute(attr.name);if(['href','src','xlink:href'].includes(key)&&!/^(?:https?:|mailto:|data:image\/(?:png|jpeg|gif|webp);base64,|#)/i.test(attr.value))node.removeAttribute(attr.name);}if(node.tagName==='INPUT'){if(node.type!=='checkbox')node.remove();else node.disabled=true;}}return doc.body;}
  const markdownExamples=[['流程图','```mermaid\nflowchart LR\nA[开始] --> B{检查}\nB -->|通过| C[完成]\nB -->|重试| A\n```'],['时序图','```mermaid\nsequenceDiagram\nparticipant U as 用户\nparticipant A as OpenAll\nU->>A: 输入 Markdown\nA-->>U: 显示预览\n```'],['甘特图','```mermaid\ngantt\n  title 工作计划\n  dateFormat YYYY-MM-DD\n  section 开发\n  实现功能 :a1, 2026-11-02, 2d\n  验证效果 :after a1, 1d\n```'],['状态图','```mermaid\nstateDiagram-v2\n[*] --> Draft\nDraft --> Done : 完成\nDone --> [*]\n```'],['一级标题','# 一级标题'],['二级标题','## 二级标题'],['加粗','**加粗文字**'],['斜体','*斜体文字*'],['删除线','~~已删除文字~~'],['链接','[链接](https://example.com)'],['图片','![图片](https://example.com/image.png)'],['无序列表','- 第一项\n- 第二项'],['有序列表','1. 第一项\n2. 第二项'],['任务清单','- [ ] 待办\n- [x] 完成'],['引用','> 引用内容'],['行内代码','`print(1)`'],['代码块','```java\nSystem.out.println(1);\n```'],['分隔线','---'],['表格','| 名称 | 值 |\n| --- | --- |\n| 示例 | 1 |']];
  pages.markdown=async(root,ctx)=>{
    await loadToolEditor();
    const status=shell(root,'markdown'),job=worker(),source=editor('在这里输入 Markdown',ctx.initialValue||'',false,'markdown'),preview=h('div',{class:'aux-markdown-preview'}),examples=h('aside',{class:'aux-help-popover',hidden:'true','aria-label':'Markdown 语法速查'});let timer,sequence=0,dead=false,renderChain=Promise.resolve();
    function insert(text) {
      const start = source.selectionStart, end = source.selectionEnd;
      const block = text.includes('\n');
      const before = block && start && !source.value.slice(0,start).endsWith('\n') ? '\n\n' : '';
      const after = block && end < source.value.length && !source.value.slice(end).startsWith('\n') ? '\n\n' : '';
      source.setRangeText(before+text+after,start,end,'end');
      examples.hidden=true;source.focus();refresh();
    }
    examples.append(h('div',{class:'aux-section-bar'},h('strong',{},'插入 Markdown 语法'),button('关闭',()=>{examples.hidden=true;source.focus();},'quiet')));
    for (const [title,items] of [['基础语法', markdownExamples.slice(4)], ['Mermaid 图形', markdownExamples.slice(0,4)]]) {
      examples.append(h('h4',{},title),...items.map(([name,text])=>{
        const row=button(name,()=>insert(text),'quiet'),line=text.split('\n');
        row.dataset.sample=line[0]==='```mermaid'?line[1]:line[0];
        row.title=text;
        return row;
      }));
    }
    async function saveHTML(){try{await ctx.api.fileAction('save',{name:'OpenAll.html',text:'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>OpenAll Markdown</title><style>body{max-width:900px;margin:40px auto;font:16px/1.65 system-ui;padding:24px}pre{white-space:pre-wrap;background:#f4f4f4;padding:16px}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:8px}img,svg{max-width:100%}</style><body>'+preview.innerHTML+'</body></html>'});}catch(error){setStatus(status,error.message,true);}}
    const leftActions=[button('打开文件…',async()=>{try{const file=await ctx.api.chooseFile();if(file){source.value=file.text;refresh();}}catch(error){setStatus(status,error.message,true);}}),button('语法示例',()=>examples.hidden=!examples.hidden,'quiet'),button('复制 Markdown',()=>copy(ctx,source.value),'accent')],rightActions=[button('导出 HTML…',saveHTML,'quiet')];
    root.append(h('div',{class:'aux-split markdown-split'},pane('Markdown 源文',source,leftActions),pane('实时预览',preview,rightActions)),status,examples);
    async function refresh(){const serial=++sequence;setStatus(status,'正在预览…');try{const capped=source.value.length>500000,markup=await job.run('markdown',capped?source.value.slice(0,500000):source.value);if(dead||serial!==sequence)return;const safe=sanitizeHTML(markup);preview.replaceChildren(...safe.childNodes);for(const anchor of preview.querySelectorAll('a[href]'))anchor.onclick=event=>{event.preventDefault();if(anchor.getAttribute('href').startsWith('#'))return;ctx.api.open({type:'url',value:anchor.href});};
      const blocks=[...preview.querySelectorAll('code.language-mermaid')];renderChain=renderChain.catch(()=>{}).then(async()=>{if(dead||serial!==sequence||!blocks.length)return;await loadMermaid();if(dead||serial!==sequence)return;window.mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:document.documentElement.dataset.theme==='light'?'default':'dark'});for(const [index,block]of blocks.entries()){if(dead||serial!==sequence)break;try{const result=await window.mermaid.render(`oaDiagram${serial}_${index}`,block.textContent);if(dead||serial!==sequence)break;const holder=h('div',{class:'aux-diagram'});holder.innerHTML=result.svg;block.parentElement.replaceWith(holder);}catch{if(block.isConnected)block.parentElement.append(h('p',{class:'aux-inline-error'},'图形语法有误，请检查 Mermaid 内容'));}}});await renderChain;if(dead||serial!==sequence)return;setStatus(status,capped?'内容较大，预览前 500000 个字符；复制与保存保留全文':`${source.value.length.toLocaleString()} 字符 · 预览已更新`);}catch(error){if(!dead&&serial===sequence)setStatus(status,error.message,true);}}
    source.oninput=()=>{clearTimeout(timer);timer=setTimeout(refresh,180);};const shortcut=event=>{if((event.ctrlKey||event.metaKey)&&event.key==='/'){event.preventDefault();examples.hidden=!examples.hidden;}if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'){event.preventDefault();ctx.api.fileAction('save',{name:'OpenAll.md',text:source.value}).catch(error=>setStatus(status,error.message,true));}};root.addEventListener('keydown',shortcut);await refresh();return {focus:()=>source.focus(),paste(text){source.setRangeText(text,source.selectionStart,source.selectionEnd,'end');refresh();},dispose(){dead=true;clearTimeout(timer);job.dispose();source.disposeEditor?.();root.removeEventListener('keydown',shortcut);}};
  };
  pages.manual = async (root, ctx) => {
    shell(root, 'manual');
    const text = window.OpenAllManual;
    if (!text) throw Error('命令手册资源未加载');
    const content = h('article', {class:'aux-markdown-preview aux-manual'});
    content.replaceChildren(...sanitizeHTML(window.marked.parse(text)).childNodes);
    for (const link of content.querySelectorAll('a[href]')) link.onclick = event => {
      event.preventDefault(); ctx.api.open({type:'url', value:link.href});
    };
    return window.mountOpenAllManual(root, content, {copy: value => ctx.api.copyText(value), copyAll: () => ctx.api.copyText(text)});
  };
  pages.image=async(root,ctx)=>{
    const status=shell(root,'image'),job=worker(),preview=h('div',{class:'aux-image-canvas'},h('div',{class:'aux-image-empty'},button('选择图片…',()=>chooseImage()),h('span',{},'也可拖入图片'))),width=input('宽'),height=input('高'),ratio=check('保持宽高比',true),format=select([['png','PNG'],['jpeg','JPEG'],['heic','HEIC'],['tiff','TIFF']]),quality=h('input',{type:'range','aria-label':'压缩质量',min:'10',max:'100',value:'80'}),qualityLabel=h('span',{},'压缩质量 80%'),metadata=check('移除图片元数据',true),target=select([['','不限'],['custom','自定义…']]),targetInput=input('目标 MB'),bytesLabel=h('strong',{class:'aux-image-size'},'尚未载入'),details=h('p',{class:'muted'}),originalSize=h('span',{class:'aux-original-size'}),save=button('保存文件…',()=>saveOutput(),'primary'),copyButton=button('复制图片',()=>copyOutput());
    const choose=button('更换图片…',()=>chooseImage()),paste=button('剪贴板',()=>readImage(),'quiet'),crop=button('⌗ 裁剪',()=>cropDialog(),'quiet'),rotateLeft=button('↶ 左转',()=>rotate(false),'quiet'),rotateRight=button('↷ 右转',()=>rotate(true),'quiet');
    let source='',original='',originalBytes=0,image=null,output='',outputBytes=0,fileName='OpenAll',timer,dead=false,generation=0,rendering=false,pending=false,transforming=false;
    width.inputMode=height.inputMode='numeric';targetInput.hidden=true;targetInput.type='number';targetInput.min='0.0001';targetInput.max='100';targetInput.step='0.1';
    const qualityBox=label('',h('div',{class:'aux-quality'},qualityLabel,quality)),targetBox=label('目标体积',h('div',{class:'aux-stack'},target,targetInput));
    const summary=h('div',{class:'aux-image-summary',hidden:true},
      h('span',{class:'muted'},'导出大小'),bytesLabel,
      h('span',{class:'muted'},'原图大小'),originalSize,details);
    const controls=h('aside',{class:'aux-image-controls'},h('div',{class:'aux-section-bar'},h('strong',{},'尺寸'),h('span',{class:'muted'},'像素')),h('div',{class:'aux-image-dimensions'},label('宽',width),label('高',height)),ratio.node,label('格式',format),qualityBox,targetBox,metadata.node,summary,h('div',{class:'aux-image-buttons'},copyButton,save));
    const scaleLabel = h('span',{class:'image-preview-scale'});
    function updatePreviewScale() {
      if (!image?.isConnected) { scaleLabel.textContent = ''; return; }
      const percent = Math.round(image.getBoundingClientRect().width / image.naturalWidth * 100);
      scaleLabel.textContent = '预览 '+percent+'%';
    }
    const scaleObserver = new ResizeObserver(updatePreviewScale);
    root.append(h('div',{class:'aux-image-main'},h('div',{class:'aux-image-toolbar'},choose,paste,h('span',{class:'aux-spacer'}),crop,rotateLeft,rotateRight),
      preview,h('div',{class:'image-preview-caption'},status,scaleLabel)),controls);
    const dataURL=blob=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(Error('图片读取失败'));reader.readAsDataURL(blob);});
    const byteCount=value=>Math.floor((value.split(',')[1]?.length||0)*3/4)-(value.endsWith('==')?2:value.endsWith('=')?1:0);
    const human=size=>size>=1000000?(size/1000000).toFixed(2)+' MB':Math.max(1,Math.round(size/1000))+' KB';
    const decoded=value=>new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=()=>reject(Error('无法读取图片格式'));img.src=value;});
    function setEnabled(){choose.hidden=!image;for(const control of [width,height,ratio.box,format,quality,metadata.box,target,targetInput,crop,rotateLeft,rotateRight])control.disabled=!image||transforming;save.disabled=copyButton.disabled=!output||rendering||transforming;qualityBox.hidden=!['jpeg','heic'].includes(format.value);targetBox.hidden=format.value!=='png';}
    async function load(value,keepOriginal=false){if(!value?.dataUrl)return;try{let decodedSource=value.dataUrl,loaded;try{loaded=await decoded(decodedSource);}catch{const converted=await ctx.api.fileAction('encodeImage',{dataUrl:value.dataUrl,format:'png',removeMetadata:true});decodedSource=converted.dataUrl;loaded=await decoded(decodedSource);}if(dead)return;if(loaded.naturalWidth>12000||loaded.naturalHeight>12000||loaded.naturalWidth*loaded.naturalHeight>80000000)throw Error('图片尺寸需在 12000 像素和 8000 万像素以内');image=loaded;source=decodedSource;if(!keepOriginal){original=value.dataUrl;originalBytes=byteCount(value.dataUrl);fileName=(value.name||'OpenAll').replace(/\.[^.]+$/,'');}width.value=String(image.naturalWidth);height.value=String(image.naturalHeight);preview.replaceChildren(image);image.alt='处理后图片预览';scaleObserver.disconnect();scaleObserver.observe(image);updatePreviewScale();target.value='';targetInput.value='';targetInput.hidden=true;setEnabled();await refresh();}catch(error){setStatus(status,error.message,true);}}
    async function chooseImage(){try{const value=await ctx.api.fileAction('openImage');if(value&&!value.canceled)await load(value);}catch(error){setStatus(status,error.message,true);}}
    async function readImage(){try{const value=await ctx.api.fileAction('readImage');if(!value?.dataUrl){setStatus(status,'剪贴板中没有图片');return;}await load(value);}catch(error){setStatus(status,error.message,true);}}
    function dimensions(changed){if(ratio.box.checked&&image){const value=Number(changed==='width'?width.value:height.value);if(Number.isFinite(value)){const scaled=Math.max(1,Math.round(value*(changed==='width'?image.naturalHeight/image.naturalWidth:image.naturalWidth/image.naturalHeight)));(changed==='width'?height:width).value=String(scaled);}}schedule();}
    width.oninput=()=>dimensions('width');height.oninput=()=>dimensions('height');ratio.box.onchange=()=>schedule();format.onchange=()=>{setEnabled();schedule();};quality.oninput=()=>{qualityLabel.textContent='压缩质量 '+quality.value+'%';schedule();};metadata.box.onchange=()=>schedule();target.onchange=()=>{targetInput.hidden=target.value!=='custom';if(!targetInput.hidden)targetInput.focus();schedule();};targetInput.oninput=()=>schedule();
    function schedule(){generation++;output='';summary.hidden=true;setEnabled();clearTimeout(timer);timer=setTimeout(refresh,180);}
    async function raster(w,h,mime='image/png',q=0.8){const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;const context=canvas.getContext('2d');if(mime==='image/jpeg'){context.fillStyle='#ffffff';context.fillRect(0,0,w,h);}context.drawImage(image,0,0,w,h);const blob=await new Promise(resolve=>canvas.toBlob(resolve,mime,q));canvas.width=canvas.height=1;if(!blob)throw Error('无法编码图片');return dataURL(blob);}
    async function refresh(){if(!image||dead)return;summary.hidden=true;if(rendering){pending=true;return;}const serial=generation,w=Number(width.value),hgt=Number(height.value);if(!Number.isInteger(w)||!Number.isInteger(hgt)||w<1||hgt<1||w>12000||hgt>12000||w*hgt>80000000){output='';setEnabled();setStatus(status,'宽高需为 1–12000 的整数，总像素不超过 8000 万',true);return;}rendering=true;setEnabled();setStatus(status,'正在生成图片…');try{let encoded;
        if(['heic','tiff'].includes(format.value)||!metadata.box.checked){const base=w===image.naturalWidth&&hgt===image.naturalHeight?source:await raster(w,hgt);const result=await ctx.api.fileAction('encodeImage',{dataUrl:base,sourceDataUrl:original,width:w,height:hgt,format:format.value,quality:Number(quality.value)/100,removeMetadata:metadata.box.checked});if(!result?.dataUrl)throw Error('图片编码器没有返回结果');encoded=result.dataUrl;}
        else encoded=await raster(w,hgt,format.value==='jpeg'?'image/jpeg':'image/png',Number(quality.value)/100);
        if(format.value==='png'&&target.value==='custom'&&targetInput.value.trim()){const targetBytes=Math.round(Number(targetInput.value)*1000000);const binary=Uint8Array.from(atob(encoded.split(',')[1]),c=>c.charCodeAt(0));const padded=await job.run('paddedPNG',binary,targetBytes);encoded=await dataURL(new Blob([padded],{type:'image/png'}));}
        if(dead||serial!==generation)return;output=encoded;outputBytes=byteCount(encoded);bytesLabel.textContent=human(outputBytes)+' '+format.value.toUpperCase();const percent=originalBytes?Math.round((outputBytes-originalBytes)/originalBytes*100):0;
        const change=percent===0?'体积相近':(percent<0?'减小 ':'增大 ')+Math.abs(percent)+'%';
        bytesLabel.title=outputBytes.toLocaleString()+' 字节';
        originalSize.textContent=human(originalBytes);originalSize.title=originalBytes.toLocaleString()+' 字节';
        details.textContent=w+' × '+hgt+' 像素 · '+change;summary.hidden=false;setStatus(status,'保存不会覆盖原图');
      }catch(error){if(!dead&&serial===generation){output='';bytesLabel.textContent='生成失败';setStatus(status,error.message,true);}}finally{rendering=false;setEnabled();if(pending||serial!==generation){pending=false;refresh();}}}
    async function transform(draw,w,hgt){if(!image||transforming)return;transforming=true;generation++;setEnabled();try{const canvas=document.createElement('canvas');canvas.width=w;canvas.height=hgt;draw(canvas.getContext('2d'));const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));canvas.width=canvas.height=1;if(!blob)throw Error('图片处理失败');await load({dataUrl:await dataURL(blob)},true);}catch(error){setStatus(status,error.message,true);}finally{transforming=false;setEnabled();}}
    async function rotate(right){const current=image;if(!current)return;await transform(context=>{context.translate(current.naturalHeight/2,current.naturalWidth/2);context.rotate((right?1:-1)*Math.PI/2);context.drawImage(current,-current.naturalWidth/2,-current.naturalHeight/2);},current.naturalHeight,current.naturalWidth);}
    function cropDialog() {
      if (!image) return;
      const original = image;
      const fields = [input('X','0'), input('Y','0'), input('宽',String(original.naturalWidth)), input('高',String(original.naturalHeight))];
      const names = ['起点 X','起点 Y','宽','高'];
      const error = h('div',{class:'aux-inline-error',role:'status'});
      const shade = h('div',{class:'aux-dialog-shade'});
      const dialog = h('div',{class:'aux-dialog',role:'dialog','aria-modal':'true','aria-label':'裁剪图片'});
      const main = root.querySelector('.aux-image-main');
      function close() {
        shade.remove();
        delete root.dataset.cropping;
        main.inert = controls.inert = false;
        crop.focus();
      }
      const guide = document.createElementNS('http://www.w3.org/2000/svg','svg');
      guide.classList.add('image-crop-guide');
      guide.setAttribute('tabindex','0');
      guide.setAttribute('role','img');
      guide.setAttribute('aria-label','裁剪画布，拖动角点调整选区，或使用下方坐标输入框');
      guide.setAttribute('viewBox', '0 0 '+original.naturalWidth+' '+original.naturalHeight);
      const picture = document.createElementNS(guide.namespaceURI,'image');
      picture.setAttribute('href',original.src);
      picture.setAttribute('width',String(original.naturalWidth));
      picture.setAttribute('height',String(original.naturalHeight));
      const mask = document.createElementNS(guide.namespaceURI,'path');
      mask.setAttribute('fill-rule','evenodd');
      mask.setAttribute('fill','rgba(0,0,0,.52)');
      const selection = document.createElementNS(guide.namespaceURI,'rect');
      selection.setAttribute('fill','none');
      selection.setAttribute('stroke','var(--accent)');
      selection.setAttribute('stroke-width','2');
      selection.setAttribute('vector-effect','non-scaling-stroke');
      const handles = Array.from({length:4}, () => {
        const handle = document.createElementNS(guide.namespaceURI,'circle');
        handle.setAttribute('fill','white');
        handle.setAttribute('stroke','#383838');
        handle.setAttribute('vector-effect','non-scaling-stroke');
        return handle;
      });
      guide.append(picture,mask,selection,...handles);
      const submit = button('裁剪', async () => {
        const [x,y,w,hgt] = read();
        close();
        await transform(context=>context.drawImage(original,x,y,w,hgt,0,0,w,hgt),w,hgt);
      },'primary');
      const read = () => fields.map(field => field.value.trim() ? Number(field.value) : NaN);
      function redraw() {
        const [x,y,w,hgt] = read(), W = original.naturalWidth, H = original.naturalHeight;
        const valid = [x,y,w,hgt].every(Number.isInteger) && x >= 0 && y >= 0 && w > 0 && hgt > 0 && x+w <= W && y+hgt <= H;
        submit.disabled = !valid;
        error.textContent = valid ? '' : '裁剪区域须完整位于图片内';
        mask.setAttribute('d', valid ? 'M0 0H'+W+'V'+H+'H0Z M'+x+' '+y+'h'+w+'v'+hgt+'h'+(-w)+'Z' : '');
        selection.setAttribute('visibility',valid ? 'visible' : 'hidden');
        if (valid) for (const [key,val] of Object.entries({x,y,width:w,height:hgt})) selection.setAttribute(key,String(val));
        const scale = guide.getScreenCTM()?.a || 1;
        handles.forEach((handle,i) => {
          handle.setAttribute('visibility',valid ? 'visible' : 'hidden');
          if (!valid) return;
          handle.setAttribute('r',String(3.5/scale));
          handle.setAttribute('cx',String(i%2 ? x+w : x));
          handle.setAttribute('cy',String(i>=2 ? y+hgt : y));
        });
      }
      let startPoint;
      function imagePoint(event) {
        const matrix = guide.getScreenCTM();
        if (!matrix) return null;
        return new DOMPoint(event.clientX,event.clientY).matrixTransform(matrix.inverse());
      }
      guide.addEventListener('pointerdown',event=>{
        const point = imagePoint(event);
        if (event.button !== 0 || !point) return;
        const corners = handles.map((h,i) => ({i, x:h.cx.baseVal.value, y:h.cy.baseVal.value}))
          .map(c => ({...c, distance:Math.hypot(c.x-point.x,c.y-point.y)}));
        const nearest = corners.reduce((a,b) => a.distance < b.distance ? a : b);
        const resizing = !submit.disabled && nearest.distance * guide.getScreenCTM().a <= 7;
        if (!resizing && (point.x < 0 || point.y < 0 || point.x > original.naturalWidth || point.y > original.naturalHeight)) return;
        const origin = resizing ? corners[3-nearest.i] : point;
        startPoint = [Math.round(origin.x),Math.round(origin.y)];
        guide.setPointerCapture(event.pointerId);
      });
      function selectTo(event) {
        if (!startPoint) return;
        const point = imagePoint(event);
        if (!point) return;
        const x = Math.max(0, Math.min(original.naturalWidth, Math.round(point.x)));
        const y = Math.max(0, Math.min(original.naturalHeight, Math.round(point.y)));
        const [x0,y0] = startPoint, width = Math.abs(x-x0), height = Math.abs(y-y0);
        if (!width || !height) return;
        [Math.min(x,x0),Math.min(y,y0),width,height].forEach((value,index)=>fields[index].value=String(value));
        redraw();
      }
      guide.addEventListener('pointermove',selectTo);
      guide.addEventListener('pointerup',event=>{ selectTo(event); startPoint = null; });
      guide.addEventListener('lostpointercapture',()=>{ startPoint = null; });
      fields.forEach((field,index) => {
        field.inputMode = 'numeric';
        field.setAttribute('aria-label',names[index]);
        field.addEventListener('input',redraw);
      });
      const stage = h('div',{class:'image-crop-stage'},guide);
      const inspector = h('aside',{class:'image-crop-inspector'},h('h3',{},'裁剪图片'),
        h('p',{class:'muted'},'原图 '+original.naturalWidth+' × '+original.naturalHeight+' 像素'),
        h('div',{class:'aux-crop-fields'},...fields.map((field,index)=>label(names[index],field))),
        h('p',{class:'muted'},'拖动图中四角，或输入裁剪坐标。'),error,
        h('div',{class:'aux-actions'},button('取消',close),submit));
      dialog.append(stage,inspector);
      shade.append(dialog);
      main.inert = controls.inert = true;
      root.dataset.cropping = 'true';
      shade.addEventListener('keydown',event=>{
        if (event.key==='Escape') { event.preventDefault(); close(); }
        if (event.key==='Enter' && document.activeElement?.matches('input') && !submit.disabled) { event.preventDefault(); submit.click(); }
      });
      root.append(shade); redraw(); guide.focus();
    }
    async function copyOutput(){if(!output)return;try{const png=format.value==='png'?output:await raster(Number(width.value),Number(height.value));await ctx.api.fileAction('copyImage',{dataUrl:png});ctx.notify('已复制图片');}catch(error){setStatus(status,error.message,true);}}
    async function saveOutput(){if(!output)return;try{const result=await ctx.api.fileAction('save',{name:fileName+'.'+(format.value==='jpeg'?'jpg':format.value),dataUrl:output,format:format.value});if(!result?.canceled)setStatus(status,'图片已保存');}catch(error){setStatus(status,error.message,true);}}
    const pasteEvent=event=>{if(event.target.closest('input,textarea'))return;const file=[...(event.clipboardData?.items||[])].find(item=>item.type.startsWith('image/'))?.getAsFile();if(file){event.preventDefault();dataURL(file).then(value=>load({dataUrl:value,name:file.name}));}};root.addEventListener('paste',pasteEvent);preview.ondragover=event=>event.preventDefault();preview.ondrop=async event=>{event.preventDefault();const file=event.dataTransfer.files[0];if(file&&(/image\//.test(file.type)||/\.(heic|heif|tiff?)$/i.test(file.name)))await load({dataUrl:await dataURL(file),name:file.name});};setEnabled();if(typeof ctx.initialValue==='string'&&ctx.initialValue.startsWith('data:image/'))await load({dataUrl:ctx.initialValue});else if(ctx.initialValue?.dataUrl)await load(ctx.initialValue);else await readImage();return {focus:()=>(image?choose:preview.querySelector('button'))?.focus(),dispose(){dead=true;generation++;clearTimeout(timer);scaleObserver.disconnect();job.dispose();root.removeEventListener('paste',pasteEvent);},paste(){readImage();}};
  };
})();
