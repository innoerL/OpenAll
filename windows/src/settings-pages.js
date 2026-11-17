(() => {
  'use strict';
  const {h,button,icon,notify,menu,prompt,confirm}=window.OpenAllUI;
  const navigation=[['general','通用','settings'],['search','搜索','search'],['clipboard','剪贴板','clipboard'],['linkAliases','网址别名','link'],['commandAliases','功能别名','command'],['snippets','常用片段','snippets'],['permissions','权限','permissions'],['diagnostics','诊断','diagnostics'],['appearance','外观','appearance']];
  async function settingsPage(root,ctx) {
    const {api}=ctx;let prefs=await api.settings(),tab=typeof ctx.initialValue==='string'?ctx.initialValue:'general',disposed=false,recording=null,renderRevision=0;
    if(!navigation.some(x=>x[0]===tab))tab='general';
    const sidebar=h('nav',{class:'settings-sidebar','aria-label':'设置分类'}),body=h('section',{class:'settings-body'}),content=h('div',{class:'settings-content'});
    body.append(content);root.append(h('div',{class:'settings-layout'},sidebar,body));
    const field=(label,input)=>h('div',{class:'field'},h('label',{},label),input);
    const row=(label,control,hint='',tall=false)=>h('div',{class:'settings-row'+(tall?' tall':'')},h('label',{},label,hint?h('small',{},hint):null),control);
    const select=(options,value,fn)=>{const e=h('select',{onchange:()=>fn?.(e.value)},options.map(o=>h('option',{value:String(o[0])},o[1])));e.value=String(value);return e;};
    const input=(value,placeholder='')=>h('input',{value:value??'',placeholder,spellcheck:'false'});
    const checkbox=(text,checked,fn)=>{const e=h('input',{type:'checkbox',checked,onchange:()=>fn(e.checked)});return h('label',{class:'checkbox-label'},e,text);};
    async function save(patch,quiet=false) {const r=await api.saveSettings(patch);if(r?.ok===false)throw Error(r.error||('快捷键已占用或设置无效：'+(r.failed||[]).join('、')));prefs=await api.settings();window.OpenAllApp?.applyTheme(prefs);if(!quiet)notify('设置已保存');return prefs;}
    const saveClip=patch=>save({clipboardPreferences:{...prefs.clipboardPreferences,...patch}});
    function heading(title,subtitle) {content.append(h('h1',{},title));if(subtitle)content.append(h('p',{class:'settings-lead'},subtitle));}
    function bind(input,fn) {input.addEventListener('change',()=>Promise.resolve(fn(input.value)).catch(e=>notify(e.message,true)));return input;}
    function shortcut(key) {
      const b=button((prefs[key]||'未设置').replaceAll('Control','Ctrl').replaceAll('Super','Win'),async()=>{
        if(recording)await recording.cancel();
        await api.windowAction('shortcutRecording',{active:true});
        const old=b.textContent;b.textContent='按下快捷键…';b.classList.add('recording');let done=false,saving=false;
        const cancel=async()=>{if(done)return;done=true;window.removeEventListener('keydown',listen,true);window.removeEventListener('blur',cancel);b.classList.remove('recording');b.textContent=old;recording=null;await api.windowAction('shortcutRecording',{active:false});};
        const listen=async e=>{e.preventDefault();e.stopImmediatePropagation();if(saving)return;if(e.key==='Escape'){await cancel();return;}if(['Control','Shift','Alt','Meta'].includes(e.key))return;
          const parts=[];if(e.ctrlKey)parts.push('Control');if(e.altKey)parts.push('Alt');if(e.shiftKey)parts.push('Shift');if(e.metaKey)parts.push('Super');
          if(!parts.length){b.textContent='请同时按修饰键';return;}
          const name=e.code==='Space'?'Space':e.code.startsWith('Key')?e.code.slice(3):e.code.startsWith('Digit')?e.code.slice(5):({ArrowUp:'Up',ArrowDown:'Down',ArrowLeft:'Left',ArrowRight:'Right',Backspace:'Backspace',Enter:'Return'})[e.key]||e.key;
          parts.push(name);saving=true;try{await save({[key]:parts.join('+')});}catch(error){notify(error.message,true);}finally{await cancel();await render();}
        };
        recording={cancel};window.addEventListener('keydown',listen,true);window.addEventListener('blur',cancel);
      },'shortcut-button');return b;
    }
    async function render(next=tab) {
      const revision=++renderRevision;recording?.cancel();tab=next;content.dataset.tab=tab;sidebar.replaceChildren(...navigation.map(([id,title,symbol])=>{const b=button('',()=>render(id),'settings-nav'+(id===tab?' selected':''));b.append(icon(symbol,16),title);return b;}));content.replaceChildren();body.scrollTop=0;prefs=await api.settings();if(disposed||revision!==renderRevision)return;
      if(tab==='general') {
        heading('快捷键','点击快捷键重新录制 · Esc 取消');
        content.append(row('搜索唤起方式',h('div',{class:'settings-segmented'},...['combo','double'].map((mode,i)=>button(i?'双击修饰键':'组合快捷键',async()=>{await save({searchShortcutMode:mode});render();},prefs.searchShortcutMode===mode?'selected':'')))));
        content.append(row('打开搜索',prefs.searchShortcutMode==='double'?select([['Alt','双击 Alt'],['Control','双击 Ctrl'],['Shift','双击 Shift'],['Super','双击 Win']],prefs.doubleTap,value=>save({doubleTap:value})):shortcut('search')));
        const status=h('p',{class:'hint small',style:{textAlign:'right',margin:'3px 0 22px'}},'已启用');content.append(status);
        api.diagnostics().then(d=>{if(disposed||tab!=='general')return;const entry=d.shortcuts?.search;status.textContent=entry===false?'快捷键被占用，请重新录制':d.shortcuts?.error||'已启用';}).catch(()=>{});
        for(const [key,title,desc] of [['clipboard','剪贴板','查找、预览与粘贴历史记录'],['stack','复制堆栈','连续收集内容，按顺序粘贴'],['selection','对选中内容操作','将当前选择交给相应工具处理']])content.append(row(title,shortcut(key),desc,true));
        content.append(h('div',{class:'settings-footer'},'再次按同一快捷键，可关闭对应窗口。',button('查看诊断 →',()=>render('diagnostics'),'ghost')));
      } else if(tab==='search') {
        heading('搜索');content.append(h('div',{style:{margin:'24px 0 32px'}},checkbox('中文支持拼音和首字母匹配',prefs.pinyinEnabled,value=>save({pinyinEnabled:value}))));
        const chrome=h('section',{class:'settings-section'},h('h2',{},'Chrome'),h('div',{class:'row'},checkbox('书签',prefs.chromeBookmarks,value=>save({chromeBookmarks:value})),checkbox('浏览历史',prefs.chromeHistory,value=>save({chromeHistory:value})),h('span',{class:'spacer'}),button('重新检测',async()=>{await api.windowAction('rescan');notify('已开始重新检测');})));
        const path=input(prefs.chromePath,'自动检测；也可指定 Chrome 用户数据目录');chrome.append(h('div',{class:'row',style:{marginTop:'15px'}},path,button('保存目录',()=>save({chromePath:path.value.trim()}))));path.style.flex='1';
        chrome.append(h('p',{class:'hint small',style:{marginTop:'8px'}},'Windows：%LOCALAPPDATA%\\Google\\Chrome\\User Data'));content.append(chrome);
        content.append(h('section',{class:'settings-section'},h('h2',{},'文件搜索'),h('div',{class:'row'},checkbox('搜索文件和文件夹',prefs.searchFiles,value=>save({searchFiles:value})),h('span',{class:'spacer'}),button('重新扫描',async()=>{await api.windowAction('rescan');notify('已开始扫描');})),h('p',{class:'hint',style:{marginTop:'14px'}},'搜索 Windows 系统索引及桌面、文档、下载等目录。支持“文件”“文档”“图片”及文件后缀前缀。')));
        content.append(h('div',{style:{marginTop:'30px'}},button('管理置顶与隐藏结果 →',searchRules)));
      } else if(tab==='clipboard') {
        const p=prefs.clipboardPreferences||{};heading('剪贴板历史');
        content.append(h('div',{style:{margin:'28px 0 6px'}},checkbox('自动记录剪贴板',p.enabled!==false,value=>saveClip({enabled:value}))),h('p',{class:'hint small'},'开启后自动保存；下方可临时暂停。'));
        const remaining=p.pausedUntil?new Date(p.pausedUntil).getTime()-Date.now():0;
        content.append(row('记录状态',select([[0,'持续记录'],[1,'暂停 1 小时'],[2,'暂停至明天'],[3,'暂停至手动恢复']],remaining<=0?0:remaining<=3600000?1:remaining<86400000?2:3,value=>{let until=null;if(value==='1')until=Date.now()+3600000;if(value==='2'){const d=new Date();d.setHours(24,0,0,0);until=d.getTime();}if(value==='3')until=Date.now()+315360000000;saveClip({pausedUntil:until?new Date(until).toISOString():null});})),h('hr'),checkbox('默认粘贴为纯文本（关闭则保留原样式）',!!p.plainTextByDefault,value=>saveClip({plainTextByDefault:value})),h('hr'));
        content.append(row('保留时间',select([[7,'一周'],[30,'一月'],[90,'三月'],[365,'一年']],p.retentionDays||30,value=>saveClip({retentionDays:Number(value)}))),row('单条内容大小上限',select([5,10,20,50].map(n=>[n,n+' MB']),(p.maxItemBytes||20000000)/1000000,value=>saveClip({maxItemBytes:Number(value)*1000000}))));
        content.append(row('排除应用',button((p.ignoreApplications||[]).length?'已排除 '+p.ignoreApplications.length+' 个应用':'未排除应用 · 点击选择',async()=>{
          const value=await prompt('排除应用名称或 exe 文件名（逗号分隔）',(p.ignoreApplications||[]).join(', '));if(value!=null){await saveClip({ignoreApplications:value.split(/[,，\n]/).map(x=>x.trim()).filter(Boolean)});render();}
        })),h('p',{class:'hint small',style:{marginTop:'18px'}},'只在本机保存；排除应用和隐藏内容不会记录。'));
        content.append(h('div',{class:'settings-footer'},button('打开剪贴板历史',()=>api.windowAction('showClipboard')),button('清理历史… ▾',e=>menu([{label:'清理未收藏记录',action:()=>clearHistory(false)},{label:'清理全部历史',danger:true,action:()=>clearHistory(true)}],e.currentTarget),'danger')));
      } else if(tab==='linkAliases') {
        heading('网址别名','输入别名和关键词，直接打开对应网站。');
        let selected=-1;
        const list=h('div',{class:'editor-list alias-list'}),count=h('span',{class:'muted'}),name=input('','显示名称'),keywords=input('','例如 xhs, xiaohongshu, hongshu'),url=h('textarea',{class:'alias-url',placeholder:'https://example.com/search?q={query}',spellcheck:'false'});
        const form=h('div',{class:'editor-form alias-form'},field('显示名称',name),field('别名 · 最多三个，用逗号分隔',keywords),field('网址模板 · {query} 代表搜索词',url),h('p',{class:'hint small'},'示例：xhs 咖啡 → 搜索小红书中的“咖啡”'));
        function choose(i){selected=i;const item=prefs.aliases?.[i];name.value=item?.name||'';keywords.value=(item?.keywords||[]).join(', ');url.value=item?.url||'';paint();}
        function paint(){count.textContent=(prefs.aliases||[]).length+' 个网站';remove.disabled=selected<0;list.replaceChildren(...(prefs.aliases||[]).map((item,i)=>{const b=button('',()=>choose(i),i===selected?'selected':'');b.append(h('strong',{},item.name),h('span',{class:'muted'},item.keywords.join(' · ')));return b;}));}
        const remove=button('删除',async()=>{if(selected<0)return;if(await confirm('删除网址别名','删除后将无法通过这些别名打开此网址。')){await save({aliases:prefs.aliases.filter((_,i)=>i!==selected)});choose(prefs.aliases.length?Math.min(selected,prefs.aliases.length-1):-1);}});
        const submit=button('保存更改',async()=>{
          const keys=keywords.value.split(/[,，\n]/).map(x=>x.trim()).filter(Boolean);
          if(!name.value.trim()||!keys.length||keys.length>3||!/^https?:\/\//i.test(url.value.trim()))throw Error('请填写名称、一至三个别名和 HTTP(S) 网址');
          const aliases=[...(prefs.aliases||[])];if(aliases.some((item,i)=>i!==selected&&item.keywords.some(k=>keys.some(x=>x.toLowerCase()===k.toLowerCase()))))throw Error('别名已被其他网址使用');
          const item={name:name.value.trim(),keywords:keys,url:url.value.trim()};if(selected<0){aliases.push(item);selected=aliases.length-1;}else aliases[selected]=item;await save({aliases});paint();
        },'primary');
        form.append(h('div',{class:'row'},submit,h('span',{class:'spacer'}),remove),h('p',{class:'hint small'},'修改后保存，别名立即生效。'));
        const navigation=h('div',{class:'alias-navigation'},h('div',{class:'alias-list-heading'},'网站',count),list,button('＋ 新增网址',()=>{choose(-1);name.focus();}));
        content.append(h('div',{class:'alias-layout'},navigation,form));choose(prefs.aliases?.length?0:-1);
      } else if(tab==='commandAliases') {
        heading('功能别名','为内置功能添加你习惯的搜索词。');const filter=input('','搜索功能或别名'),list=h('div',{class:'editor-list',style:{maxHeight:'220px'}}),names=input('','多个别名用逗号分隔'),label=h('label',{},'自定义别名');let chosen=null;
        function paint(){const q=filter.value.toLowerCase();list.replaceChildren(...window.OpenAllCatalog.filter(c=>[c.title,...c.keywords,...(prefs.commandAliases?.[c.id]||[])].join(' ').toLowerCase().includes(q)).map(c=>{const b=button('',()=>{chosen=c;label.textContent=c.title+' · 自定义别名';names.value=(prefs.commandAliases?.[c.id]||[]).join(', ');paint();},chosen?.id===c.id?'selected':'');b.append(h('span',{},c.title),h('span',{class:'muted'},(prefs.commandAliases?.[c.id]||[]).join(' / ')));return b;}));}
        filter.addEventListener('input',paint);content.append(filter,list,h('div',{class:'editor-form'},h('div',{class:'field'},label,names),h('div',{class:'row'},button('重置',async()=>{if(!chosen)return;const values={...prefs.commandAliases};delete values[chosen.id];await save({commandAliases:values});names.value='';paint();}),button('保存',async()=>{if(!chosen)throw Error('请先选择一个功能');const values=names.value.split(/[,，\n]/).map(x=>x.trim()).filter(Boolean);for(const c of window.OpenAllCatalog){if(c.id===chosen.id)continue;if([c.title,...c.keywords,...(prefs.commandAliases?.[c.id]||[])].some(n=>values.some(v=>v.toLowerCase()===n.toLowerCase())))throw Error('别名与“'+c.title+'”冲突');}await save({commandAliases:{...prefs.commandAliases,[chosen.id]:values}});paint();},'primary'))));paint();
      } else if(tab==='snippets') {
        heading('常用片段','在搜索中输入 ;关键词，快速展开并粘贴。');let all=await api.snippets('list'),selected='';if(!Array.isArray(all))all=all.items||[];
        const picker=select([['','新建片段'],...all.map(x=>[x.id,x.name+' · ;'+x.keyword])],'',null),name=input('','片段名称'),key=input('','不含空格的关键词'),text=h('textarea',{placeholder:'片段内容，可使用 {{date}}、{{time}}、{{clipboard}}'});
        picker.style.flex='1';
        function fill(id){selected=id;const s=all.find(x=>x.id===id);name.value=s?.name||'';key.value=s?.keyword||'';text.value=s?.body||'';}
        picker.onchange=()=>fill(picker.value);
        content.append(h('div',{class:'row',style:{margin:'20px 0'}},picker,button('新建',()=>{picker.value='';fill('');})),h('div',{class:'editor-form'},h('div',{class:'grid'},field('名称',name),field('关键词',key)),field('内容',text),h('p',{class:'hint small'},'日期示例：{{date:yyyy-MM-dd}} · 时间：{{time:HH:mm:ss}} · 剪贴板：{{clipboard}}'),h('div',{class:'row'},button('删除',async()=>{if(selected&&await confirm('删除片段','确认删除所选常用片段？')){await api.snippets('delete',{id:selected});render();}},'danger'),h('span',{class:'spacer'}),button('预览展开',async()=>{const result=await api.snippets('expand',{id:selected,body:text.value});window.OpenAllUI.dialog('展开结果',h('pre',{style:{whiteSpace:'pre-wrap',maxHeight:'300px',overflow:'auto'}},typeof result==='string'?result:result.text||''),[button('关闭',e=>e.currentTarget.closest('dialog').close())]);}),button('保存',async()=>{if(!key.value.trim()||/\s/.test(key.value.trim())||!text.value)throw Error('关键词不能含空格，内容不能为空');const r=await api.snippets('save',{id:selected||undefined,name:name.value.trim(),keyword:key.value.trim(),body:text.value});if(r?.ok===false)throw Error(r.error||'关键词已存在');notify('片段已保存');render();},'primary'))));
      } else if(tab==='permissions') {
        heading('权限与隐私','本地运行，内容保存在当前 Windows 用户目录。');const d=await api.diagnostics();
        content.append(h('section',{class:'settings-section'},h('h2',{},'快捷键与自动粘贴'),h('p',{},'自动粘贴和读取选中内容使用 Windows 键盘与窗口接口。目标应用以管理员运行时，OpenAll 也需要相同权限。'),h('div',{class:'row',style:{marginTop:'16px'}},button('检查状态',()=>render()),button('查看快捷键',()=>render('general')))));
        content.append(h('section',{class:'settings-section'},h('h2',{},'文件访问'),h('p',{},prefs.searchFiles?'文件搜索已开启，仅索引可访问目录。':'文件搜索已关闭，可在搜索设置中开启。'),h('div',{class:'row',style:{marginTop:'14px'}},button('打开搜索设置',()=>render('search')),button('重新扫描',()=>api.windowAction('rescan')))));
        content.append(h('section',{class:'settings-section'},h('h2',{},'图片文字识别'),h('p',{},d.ocrAvailable===false?'当前 Windows 未安装可用的 OCR 语言包，可在 Windows 语言设置中添加。':'使用 Windows 本机文字识别；图片与识别结果不发送到远端。'),h('div',{style:{marginTop:'14px'}},button('打开 Windows 语言设置',()=>api.fileAction('openSystemSettings',{uri:'ms-settings:regionlanguage'})))));
        content.append(h('section',{class:'settings-section'},h('h2',{},'本地数据'),button('打开数据目录',()=>api.fileAction('dataDirectory'))));
      } else if(tab==='diagnostics') {
        heading('诊断','查看运行状态、索引与本地存储。');const d=await api.diagnostics();const rows=[['版本',d.version||'0.25.6'],['平台',d.platform||'Windows'],['应用索引',d.index?.apps??0],['文件索引',d.index?.files??0],['Chrome 配置',d.index?.profiles??0],['剪贴板记录',d.clipboard??d.clipboardCount??0],['内存',d.memoryMB?d.memoryMB+' MB':'—'],['索引状态',d.index?.indexing?'正在更新':'就绪'],['系统文件索引',d.index?.systemIndex?.available?'已连接 Windows Search':d.index?.systemIndex?.reason||'搜索文件时自动连接']];
        content.append(h('dl',{class:'status-grid'},rows.flatMap(([name,value])=>[h('dt',{},name),h('dd',{},String(value))])),h('div',{class:'row'},button('刷新状态',()=>render()),button('重新建立索引',()=>api.windowAction('rescan')),button('复制诊断',async()=>{await api.copyText(JSON.stringify(d,null,2));notify('诊断信息已复制');})),h('section',{class:'settings-section'},h('h2',{},'更新'),h('div',{class:'row'},bind(input(prefs.updateFeedURL,'更新源地址（HTTPS）'),value=>save({updateFeedURL:value})),button('检查更新',async()=>{const result=await api.windowAction('checkUpdates');notify(result?.message||'已完成更新检查');render();})),h('div',{class:'row',style:{marginTop:'12px'}},button('安装更新',async()=>{if(await confirm('安装更新','将下载并校验安装包，然后关闭 OpenAll 启动安装器。'))await api.windowAction('installUpdate');},'primary'),button('回退上一版',async()=>{if(await confirm('回退上一版','将关闭 OpenAll，重新安装上次保留的版本。'))await api.windowAction('rollbackUpdate');})),h('p',{class:'hint small'},d.updates?.message||'填写可信的 HTTPS 更新源后检查更新。')));
      } else if(tab==='appearance') {
        heading('外观','调整背景和强调色，所有窗口同步生效。');
        const backgrounds=[['石墨','#242626'],['深蓝','#172838'],['暖棕','#30251F'],['雾白','#F2F1ED'],['跟随系统','system']],accents=[['香槟','#d8c19e'],['海蓝','#5e9ccd'],['青绿','#63b8a4'],['珊瑚','#d9917b']];
        function palettes(title,values,key) {content.append(h('h3',{style:{marginTop:'24px'}},title),h('div',{class:'palette-row'},values.map(([label,value])=>{const b=button('',async()=>{await save(value==='system'?{theme:'system'}:{[key]:value,...(key==='backgroundHex'?{theme:'custom'}:{})});render();},'color-choice'+(prefs[key]?.toLowerCase()===value||value==='system'&&prefs.theme==='system'?' selected':''));b.title=label;b.setAttribute('aria-label',label);b.style.background=value==='system'?'linear-gradient(90deg,#ddd 50%,#242626 50%)':value;return b;})))}
        palettes('背景',backgrounds,'backgroundHex');palettes('强调色',accents,'accentHex');
        const background=h('input',{type:'color',value:prefs.backgroundHex||'#242626'}),accent=h('input',{type:'color',value:prefs.accentHex||'#d8c19e'});
        background.oninput=()=>save({backgroundHex:background.value,theme:'custom'},true);accent.oninput=()=>save({accentHex:accent.value},true);
        content.append(h('div',{class:'row'},'自定义背景',background,h('span',{class:'spacer'}),'强调色',accent),h('div',{class:'appearance-preview'},h('h3',{},'预览'),h('p',{class:'hint small'},'文字、边框与选中样式跟随当前配色'),h('div',{class:'search-result'},h('span',{class:'search-result-icon'},icon('json',28)),h('div',{class:'search-result-copy'},h('div',{class:'search-result-title'},'JSON 工具'),h('div',{class:'search-result-detail'},'校验、键名自然排序与转义')))),h('div',{class:'settings-footer'},button('恢复默认',async()=>{await save({theme:'dark',backgroundHex:'#242626',accentHex:'#d8c19e'});render();})));
      }
    }
    async function clearHistory(all) {if(await confirm('清理剪贴板历史',all?'将删除全部历史记录，包括收藏。':'将删除未收藏的历史记录，收藏保留。')){await api.clipboardAction('clear',{includeFavorites:all});notify('历史记录已清理');}}
    async function searchRules() {content.replaceChildren(h('div',{class:'row'},button('← 返回',()=>render('search')),h('h1',{},'置顶与隐藏结果')));const data=await api.windowAction('searchRules');const list=Array.isArray(data)?data:data?.rules||[];const table=h('table',{class:'data-table'},h('thead',{},h('tr',{},h('th',{},'名称'),h('th',{},'规则'),h('th',{},'操作'))),h('tbody',{},list.map(item=>h('tr',{},h('td',{},item.title||item.value),h('td',{},item.hidden?'隐藏':'置顶'),h('td',{},button('恢复',async()=>{await api.windowAction('searchRule',{action:'reset',item});searchRules();}))))));content.append(list.length?table:h('div',{class:'empty'},'暂无置顶或隐藏的结果'),button('清除使用频率记录',async()=>{if(await confirm('清除使用记录','搜索排序将恢复为默认顺序。')){await api.windowAction('searchRule',{action:'clearUsage'});notify('已清除使用记录');}}));}
    await render();return {dispose(){disposed=true;recording?.cancel();},selectTab:render,getTab:()=>tab};
  }
  window.OpenAllPages.settings=settingsPage;
  for(const id of ['permissions','diagnostics','snippets','linkAliases','commandAliases'])window.OpenAllPages[id]=(root,ctx)=>settingsPage(root,{...ctx,initialValue:id});
})();
