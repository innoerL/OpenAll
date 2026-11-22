(() => {
  'use strict';
  const pages=window.OpenAllPages ||= {};
  const definitions={
    text:[['copy','复制文本','保留选中内容','clipboard'],['translate','翻译','用有道翻译打开','text'],['comparison','文本对比','放入左侧编辑区','comparison'],['json','JSON 工具','格式化、校验、转义','json'],['markdown','Markdown 预览','作为 Markdown 打开','file'],['unicode','Unicode 转换','编码或解码','text'],['snippet','存为常用片段','之后用 ;关键词 唤起','snippets']],
    url:[['openURL','打开网址','使用默认浏览器','link'],['copy','复制链接','保留完整网址','clipboard'],['copyDomain','复制域名','仅复制 host，不含路径','link'],['translate','翻译链接文本','用有道翻译打开','text']],
    json:[['jsonFormat','格式化并校验 JSON','在 JSON 工具中查看结果或错误','json'],['jsonCompact','压缩 JSON','生成紧凑文本','json'],['copy','复制原文','保持输入不变','clipboard'],['comparison','文本对比','放入左侧编辑区','comparison']],
    image:[['recognizeText','识别图片文字','识别后继续翻译、复制或处理','text'],['imageTool','图片快处理','调整尺寸、格式和压缩质量','image'],['copy','复制图片','保留图片内容','clipboard']],
    imageFile:[['imageTool','图片快处理','调整尺寸、格式和压缩质量','image'],['recognizeText','识别图片文字','提取图片中的文字','text'],['open','打开文件','使用默认应用','arrow'],['reveal','在资源管理器中显示','定位原文件','file'],['copy','复制路径','复制文件完整路径','clipboard']],
    file:[['open','打开文件','使用默认应用','arrow'],['reveal','在资源管理器中显示','定位所选文件','file'],['preview','快速预览','预览第一项','file'],['copy','复制路径','多项以换行分隔','clipboard']]
  };
  const basename=value=>String(value).split(/[\\/]/).pop();
  function normalize(value){
    if(typeof value==='string')return {kind:'text',text:value};
    value=value||{};
    if(value.kind==='files'||value.files?.length)return {kind:'files',files:(value.files||[]).map(file=>typeof file==='string'?file:file.path).filter(Boolean)};
    if(value.kind==='image'||value.dataUrl)return {kind:'image',dataUrl:value.dataUrl||(value.value?'data:image/png;base64,'+value.value:''),width:value.width,height:value.height};
    return {kind:'text',text:String(value.text||value.value||''),message:value.message};
  }
  function category(content){if(content.kind==='image')return 'image';if(content.kind==='files')return content.files.length===1&&/\.(png|jpe?g|heic|heif|tiff?|webp|gif|bmp)$/i.test(content.files[0])?'imageFile':'file';const text=content.text.trim();if(!text.includes('\n')){try{const url=new URL(text);if(['https:','http:'].includes(url.protocol))return 'url';}catch{}}return /^[{[]/.test(text)?'json':'text';}
  function orderActions(content,order=[]){const actions=(definitions[category(content)]||definitions.text).map(([id,title,detail,icon],index)=>({id,title,detail,icon,index}));return actions.sort((a,b)=>{const rank=item=>order.includes(item.id)?order.indexOf(item.id):order.length+item.index;return rank(a)-rank(b);});}
  window.OpenAllSelection={normalize,category,orderActions};

  pages.selection=async(root,ctx)=>{
    const {api,h,button,icon,notify}=ctx;
    let content=normalize(ctx.initialValue||await api.selection('get')),actions=[],otherActions=[],selected=0,dead=false,busy=false,revision=0;
    const host=h('section',{class:'context-selection'}),heading=h('h1',{},'对选中内容执行操作'),summary=h('div',{class:'selection-summary'}),preview=h('div',{class:'selection-preview',tabIndex:0}),actionHeading=h('h2',{},'可用操作'),list=h('div',{class:'selection-action-list',role:'listbox',tabIndex:0,'aria-label':'可用操作'}),status=h('div',{class:'selection-key-hint',role:'status'}),loading=h('div',{class:'selection-loading',hidden:true},h('span',{class:'selection-spinner'}),h('span',{},'正在从图片中提取文字…')),cancel=button('取消识别',()=>{revision++;api.windowAction('close');});
    const more = button('更多操作 ▾', () => ctx.menu(otherActions.map(action => ({label:action.title, action:() => perform(action)})), more), 'selection-more');
    more.setAttribute('aria-haspopup','menu');
    const available = h('div', {class:'selection-actions-heading'}, actionHeading, more);
    root.append(host);loading.append(cancel);host.append(h('header', {class:'selection-heading'}, heading, summary),preview,available,list,loading,status);cancel.hidden=true;
    const close=()=>api.windowAction('close');
    function actionIcon(action){const shapes={unicode:'M9 2 6 22M18 2 15 22M3 8h18M2 16h18',translate:'M5 3h14v17H5zM5 20l-2 2M19 20l2 2M8 15l4-9 4 9M10 12h4',recognizeText:'M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5M6 9h12M6 13h9M6 17h6'};if(!shapes[action.id])return icon(action.icon,18);const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');for(const [key,value]of Object.entries({viewBox:'0 0 24 24',width:18,height:18,fill:'none',stroke:'currentColor','stroke-width':1.6,'stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'}))svg.setAttribute(key,value);const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',shapes[action.id]);svg.append(path);return svg;}

    const fail=error=>{status.textContent=error.message||String(error);status.classList.add('error');};
    async function readOrder(){try{const saved=await api.selection('order',{category:category(content)});return Array.isArray(saved)?saved:saved?.order||[];}catch{return ctx.settings?.actionOrder?.[category(content)]||[];}}
    async function render(){
      const token=++revision;busy=false;delete host.dataset.ocrReady;host.classList.remove('recognizing');cancel.hidden=true;loading.hidden=true;list.hidden=false;actionHeading.hidden=false;preview.hidden=false;status.classList.remove('error');
      const nonempty=content.kind==='image'?!!content.dataUrl:content.kind==='files'?content.files.length>0:!!content.text;
      actions=nonempty?orderActions(content,await readOrder()):[];if(dead||token!==revision)return;selected=0;
      otherActions=content.recognized ? actions.filter(action=>!['copy','translate'].includes(action.id)) : [];
      if (otherActions.length) actions=actions.filter(action=>['copy','translate'].includes(action.id));
      more.hidden=!otherActions.length;
      available.hidden=false;
      preview.classList.toggle('recognized',!!content.recognized);
      summary.textContent=content.kind==='image'?'选中的图片'+(content.width&&content.height?' · '+content.width+' × '+content.height:''):content.kind==='files'?'选中的文件 · '+content.files.length+' 项':(content.recognized?'已识别 ':'选中的文本 · ')+content.text.length+' 字';
      preview.replaceChildren();preview.classList.toggle('image',content.kind==='image');
      if(content.kind==='image'){const image=h('img',{src:content.dataUrl,alt:'选中的图片'});image.onload=()=>{if(token===revision)summary.textContent='选中的图片 · '+image.naturalWidth+' × '+image.naturalHeight;};image.onerror=()=>fail(Error('图片预览读取失败'));preview.append(image);}
      else preview.textContent=content.kind==='files'?content.files.map(basename).join('\n'):content.text||'暂未读取到选中内容';
      status.textContent=content.message||(nonempty?'↑↓ 选择　双击或回车执行　Esc 关闭':'Esc 关闭');paint();
      if(!nonempty)list.append(h('div',{class:'selection-empty'},'请在原应用中选择文本、图片或文件后重试'));
      const height=content.recognized?304:content.kind==='image'?410:Math.max(360,204+34*Math.min(7,actions.length));await api.windowAction('resize',{width:640,height});
    }
    function paint() {
      list.replaceChildren(...actions.map((action, index) => {
        const row = button('', () => select(index), 'selection-action');
        row.id = 'selection-option-' + index;
        row.dataset.action = action.id;
        row.setAttribute('role', 'option');
        row.tabIndex = -1;
        row.append(actionIcon(action), h('span', {class:'selection-action-title'}, action.title),
          h('span', {class:'selection-action-detail'}, action.detail), h('kbd', {'aria-hidden':'true'}, '↵ 执行'));
        row.ondblclick = () => perform(action);
        row.oncontextmenu = event => {
          event.preventDefault(); select(index);
          if (otherActions.length) return;
          ctx.menu?.([
            {label:'上移此操作', disabled:index === 0, action:() => move(-1)},
            {label:'下移此操作', disabled:index === actions.length - 1, action:() => move(1)}
          ], {clientX:event.clientX, clientY:event.clientY});
        };
        return row;
      }));
      syncSelection();
    }
    function syncSelection() {
      for (const [index, row] of Array.from(list.children).entries()) {
        row.classList.toggle('selected', index === selected);
        row.setAttribute('aria-selected', String(index === selected));
        row.setAttribute('aria-posinset',String(index + 1));
        row.setAttribute('aria-setsize',String(actions.length));
      }
      const current = list.children[selected];
      if (current) list.setAttribute('aria-activedescendant', current.id);
      else list.removeAttribute('aria-activedescendant');
    }
    function select(index) {
      if (!actions.length) return;
      selected = Math.max(0, Math.min(actions.length - 1, index));
      syncSelection(); list.focus(); list.children[selected].scrollIntoView({block:'nearest'});
    }
    async function move(delta){if(otherActions.length)return;const target=selected+delta;if(target<0||target>=actions.length||busy)return;[actions[selected],actions[target]]=[actions[target],actions[selected]];selected=target;paint();try{await api.selection('order',{category:category(content),order:actions.map(x=>x.id)});status.textContent='已保存此类内容的操作顺序';}catch(error){fail(error);}}
    async function imageData(){if(content.kind==='image')return {dataUrl:content.dataUrl};if(content.kind==='files')return api.fileAction('readImage',{path:content.files[0]});throw Error('当前内容不是图片');}
    async function perform(action=actions[selected]){
      if(!action||busy||dead)return;busy=true;const text=content.kind==='files'?content.files.join('\n'):content.text||'';
      try{
        if(action.id==='recognizeText'){
          const token = ++revision, data = await imageData();
          if (dead || token !== revision) return;
          summary.textContent = '图片文字识别';
          const image = h('img', {src:data.dataUrl, alt:'正在识别的图片'});

          preview.classList.add('image');
          preview.replaceChildren(image);
          list.hidden = available.hidden = true;
          loading.hidden = cancel.hidden = false;
          host.classList.add('recognizing');
          status.textContent = '';
          try { await image.decode(); } catch { /* 保留原图数据交给系统识别。 */ }
          if (dead || token !== revision) return;
          const {naturalWidth, naturalHeight} = image;
          const imageHeight = naturalWidth ? Math.ceil(Math.min(220, naturalHeight, 598 * naturalHeight / naturalWidth)) : 110;
          if (naturalWidth) summary.textContent = '图片文字识别 · ' + naturalWidth + ' × ' + naturalHeight;
          preview.style.setProperty('--ocr-image-height', imageHeight + 'px');
          await api.windowAction('resize', {width:640, height:Math.max(180, imageHeight + 106)});
          host.dataset.ocrReady = 'true';
          const result=await api.ocr({dataUrl:data.dataUrl});if(dead||token!==revision)return;if(!result.text?.trim())throw Error('未识别到文字');content={kind:'text',text:result.text,recognized:true};await render();list.focus();return;
        }
        if(action.id==='copy'){if(content.kind==='image')await api.fileAction('copyImage',{dataUrl:content.dataUrl});else await api.copyText(text);}
        else if(action.id==='copyDomain')await api.copyText(new URL(text.trim()).host);
        else if(action.id==='openURL')await api.open({type:'url',value:text.trim()});
        else if(action.id==='open'){for(const file of content.files.slice(0,30))await api.open({type:'file',value:file});}
        else if(action.id==='reveal'){for(const file of content.files.slice(0,30))await api.fileAction('reveal',{path:file});}
        else if(action.id==='preview')await api.fileAction('preview',{path:content.files[0]});
        else if(action.id==='snippet'){const result=await api.selection('snippet',{text});notify('已存为常用片段'+(result?.keyword?'：;'+result.keyword:''));}
        else if(action.id==='imageTool')await ctx.openPage('image',await imageData());
        else if(action.id==='jsonFormat'||action.id==='jsonCompact')await ctx.openPage('json',{text,action:action.id==='jsonCompact'?'compact':'format'});
        else await ctx.openPage(action.id,text);
        await close();
      }catch(error){if(!dead){await render();fail(error);}}finally{busy=false;}
    }
    const keydown=event=>{
      if(event.defaultPrevented||document.querySelector('.context-menu,dialog[open]'))return;
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();revision++;close();return;}
      if (busy || event.target===more || !actions.length || event.target.closest('.selection-preview') || event.target === cancel) return;
      if(event.key==='ArrowUp'||event.key==='ArrowDown'){event.preventDefault();event.stopPropagation();const delta=event.key==='ArrowUp'?-1:1;if(event.altKey)move(delta);else select(selected+delta);}
      if(event.key==='Home'||event.key==='End'){event.preventDefault();select(event.key==='Home'?0:actions.length-1);}
      if(event.key==='Enter'){event.preventDefault();event.stopPropagation();perform();}
    };
    root.addEventListener('keydown',keydown);await render();return {focus:()=>list.focus(),getActions:()=>[...actions,...otherActions].map(x=>x.id),getContent:()=>content,activate:perform,move,dispose(){dead=true;revision++;root.removeEventListener('keydown',keydown);}};
  };

  pages.stack=async(root,ctx)=>{
    const {api,h,button,icon}=ctx;let state=await api.stack('get'),dead=false,selected=0,busy=false;
    const host=h('section',{class:'paste-queue'}),title=h('h1',{},'复制堆栈'),end=button('结束堆栈',async()=>{await api.stack('stop');await api.windowAction('close');},'queue-end'),list=h('div',{class:'queue-list',role:'listbox',tabIndex:0,'aria-label':'待粘贴队列'}),status=h('div',{class:'queue-status',role:'status'}),next=button('粘贴下一项',async()=>{if(busy)return;busy=true;next.disabled=true;try{state=await api.stack('next');await paint();if(!state.active)await api.windowAction('close');}catch(error){status.textContent=error.message;}finally{busy=false;next.disabled=!(state.items||[]).length;}},'primary');
    root.append(host);host.append(h('div',{class:'queue-heading'},title,end),list,h('div',{class:'queue-actions'},status,next));
    async function action(name,payload){if(busy)return;try{state=await api.stack(name,payload);await paint();}catch(error){status.textContent=error.message;}}
    async function paint(){if(dead)return;const items=state.items||[],shown=items.slice(0,6);selected=Math.max(0,Math.min(selected,shown.length-1));list.replaceChildren(...shown.map((item,index)=>{
      const text=item.kind==='image'?'图片':item.title||item.text||item.value||'文件',row=h('div',{class:'queue-row'+(!index?' next':'')+(index===selected?' focused':''),role:'option',id:'queue-option-'+index,'aria-selected':String(index===selected),tabIndex:-1,onclick:()=>{selected=0;action('move',{id:item.id||item.hash,index,to:0});},ondblclick:()=>next.click(),title:String(text)});
      const remove=button('×',event=>{event.stopPropagation();action('remove',{id:item.id||item.hash,index});},'queue-remove');remove.title='从待粘贴队列中移除此项';remove.setAttribute('aria-label','移除第 '+(index+1)+' 项');
      const [symbol, kind] = ({image:['image','图片'], files:['file','文件'], link:['link','链接']})[item.kind] || ['text','文本'];
      row.setAttribute('aria-label', '第 '+(index+1)+' 项，'+kind+'，'+text);
      row.append(h('span',{class:'queue-index'},index===0?'下一项':index+1), icon(symbol,14), h('span',{class:'queue-text'},text), remove);
      return row;
    }));if(!shown.length)list.append(h('div',{class:'queue-empty'},state.active?'等待 Ctrl+C 复制内容…':'本次队列已结束'));if (shown.length) list.setAttribute('aria-activedescendant', 'queue-option-'+selected); else list.removeAttribute('aria-activedescendant');status.textContent = (items.length > shown.length ? items.length+' 项 · 显示前 '+shown.length+' 项' : items.length+' 项待粘贴') + (items.length ? ' · Ctrl+V' : '');next.disabled=!items.length;await api.windowAction('resize',{width:340,height:104+Math.max(1,shown.length)*50});}
    const keydown=event=>{if(event.defaultPrevented || event.target.closest('button') && event.key !== 'Escape')return;const items=(state.items||[]).slice(0,6);if(['ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();const delta=event.key==='ArrowUp'?-1:1;if(event.altKey&&items[selected]){const to=Math.max(0,Math.min(items.length-1,selected+delta));action('move',{id:items[selected].id,index:selected,to});selected=to;}else{selected=Math.max(0,Math.min(items.length-1,selected+delta));paint();}}else if(event.key==='Enter'){event.preventDefault();next.click();}else if(['Backspace','Delete'].includes(event.key)&&items[selected]){event.preventDefault();action('remove',{id:items[selected].id,index:selected});}else if(event.key==='Escape'){event.preventDefault();event.stopPropagation();api.windowAction('close');}};
    root.addEventListener('keydown',keydown);const off=api.onStackChanged?.(value=>{state=value;if(!dead)paint();});if(!state.active)state=await api.stack('start');await paint();return {focus:()=>list.focus(),getState:()=>state,dispose(){dead=true;off?.();root.removeEventListener('keydown',keydown);}};
  };
})();
