(() => {
  'use strict';
  const {h,button,icon,notify,menu,dialog,confirm}=window.OpenAllUI;
  const navigation=[['general','通用','settings'],['search','搜索','search'],['clipboard','剪贴板','clipboard'],['linkAliases','网址别名','link'],['commandAliases','功能别名','command'],['snippets','常用片段','snippets'],['permissions','权限','permissions'],['diagnostics','诊断','diagnostics'],['appearance','外观','appearance']];
  async function settingsPage(root,ctx) {
    const {api}=ctx;let prefs=await api.settings(),tab=typeof ctx.initialValue==='string'?ctx.initialValue:'general',disposed=false,recording=null,renderRevision=0;
    if(!navigation.some(x=>x[0]===tab))tab='general';
    const sidebar=h('nav',{class:'settings-sidebar','aria-label':'设置分类'}),body=h('section',{class:'settings-body'}),content=h('div',{class:'settings-content'});
    body.append(content);
    root.append(h('div',{class:'settings-layout'},sidebar,body));
    const navigationButtons = new Map();
    for (const [id, title, symbol] of navigation) {
      if (id === 'linkAliases' || id === 'permissions') sidebar.append(h('hr', {class:'settings-nav-divider'}));
      const link = button('', () => render(id), 'settings-nav');
      link.append(icon(symbol, 16), title);
      navigationButtons.set(id, link);
      sidebar.append(link);
    }
    sidebar.addEventListener('keydown', event => {
      if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || !event.target.matches('.settings-nav')) return;
      const links = [...navigationButtons.values()];
      const current = links.indexOf(event.target);
      let next;
      switch (event.key) {
        case 'ArrowUp': next = Math.max(0,current-1); break;
        case 'ArrowDown': next = Math.min(links.length-1,current+1); break;
        case 'Home': next = 0; break;
        case 'End': next = links.length-1; break;
        default: return;
      }
      event.preventDefault();
      if (next !== current) {
        links[next].focus();
        render(navigation[next][0]);
      }
    });
    let fieldIndex = 0;
    let selectedSnippetID;
    function labelFor(text, control, hint = '') {
      const input = control.matches('input, select, textarea, button') ? control : control.querySelector('input, select, textarea, button');
      if (input && !input.id) input.id = 'settings-field-' + ++fieldIndex;
      return h('label', {for:input?.id}, text, hint ? h('small', {}, hint) : null);
    }
    const field=(label,input)=>h('div',{class:'field'},labelFor(label,input),input);
    const row=(label,control,hint='',tall=false)=>h('div',{class:'settings-row'+(tall?' tall':'')},labelFor(label,control,hint),control);
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
      const revision=++renderRevision;
      recording?.cancel();
      const updated = await api.settings();
      if (disposed || revision !== renderRevision) return;
      prefs = updated;
      tab = next;
      content.dataset.tab = tab;
      for (const [id, link] of navigationButtons) {
        link.classList.toggle('selected', id === tab);
        if (id === tab) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
      }
      content.replaceChildren();
      body.scrollTop = 0;
      if(tab==='general') {
        heading('快捷键','点击快捷键重新录制 · Esc 取消');
        const modes = h('div', {class:'settings-segmented', role:'group', 'aria-label':'搜索唤起方式'});
        for (const [mode, title] of [['combo','组合快捷键'], ['double','双击修饰键']]) {
          const selected = prefs.searchShortcutMode === mode;
          const choice = button(title, async () => { await save({searchShortcutMode:mode}); render(); }, selected ? 'selected' : '');
          choice.setAttribute('aria-pressed', String(selected));
          modes.append(choice);
        }
        content.append(row('搜索唤起方式', modes));
        const trigger = prefs.searchShortcutMode === 'double'
          ? select([['Alt','双击 Alt'],['Control','双击 Ctrl'],['Shift','双击 Shift'],['Super','双击 Win']],prefs.doubleTap,value=>save({doubleTap:value}))
          : shortcut('search');
        const status = h('span', {class:'shortcut-status', id:'search-shortcut-status', role:'status'});
        if (trigger.tagName === 'SELECT') trigger.setAttribute('aria-label', '打开搜索的修饰键');
        trigger.setAttribute('aria-describedby', status.id);
        content.append(row('打开搜索', h('div', {class:'shortcut-control'}, status, trigger)));
        const registration = new Map([['search',status]]);
        for (const [key,title,desc] of [['clipboard','剪贴板','查找、预览与粘贴历史记录'],['stack','复制堆栈','连续收集内容，按顺序粘贴'],['selection','对选中内容操作','将当前选择交给相应工具处理']]) {
          const state = h('span',{class:'shortcut-status',id:'shortcut-status-'+key,role:'status'});
          const record = shortcut(key);record.setAttribute('aria-describedby',state.id);
          registration.set(key,state);
          content.append(row(title,h('div',{class:'shortcut-control'},state,record),desc,true));
        }
        api.diagnostics().then(d => {
          if (disposed || revision !== renderRevision) return;
          for (const [key,state] of registration) {
            const active = d.shortcuts?.[key];
            state.textContent = active === false ? '已占用 · 点击重录' : active ? '已启用' : '待确认';
            state.classList.toggle('needs-action', active === false);
          }
        }).catch(() => {});
        content.append(h('div',{class:'settings-footer'},'再次按同一快捷键，可关闭对应窗口。',button('查看诊断 →',()=>render('diagnostics'),'ghost')));
      } else if(tab==='search') {
        heading('搜索');
        content.append(h('div',{class:'search-management'},button('管理置顶与隐藏结果 →',searchRules,'ghost')),checkbox('中文支持拼音和首字母匹配',prefs.pinyinEnabled,value=>save({pinyinEnabled:value},true)));
        const bookmarks = checkbox('书签',prefs.chromeBookmarks,value=>updateSource('chromeBookmarks',value));
        const history = checkbox('浏览历史',prefs.chromeHistory,value=>updateSource('chromeHistory',value));
        const detect = button('重新检测',async()=>{await api.windowAction('rescan');notify('已开始重新检测');});
        const sourceHint = h('p',{class:'hint small'});
        const path = input(prefs.chromePath,'自动检测 Chrome 用户数据目录');
        path.setAttribute('aria-label','Chrome 用户数据目录');
        const advanced = h('details',{class:'chrome-directory'},h('summary',{},'指定 Chrome 目录'),
          h('div',{class:'row'},path,button('保存目录',()=>save({chromePath:path.value.trim()}))));
        const chrome = h('section',{class:'settings-section'},h('h2',{},'Chrome'),
          h('div',{class:'row chrome-sources'},bookmarks,history,h('span',{class:'spacer'}),detect),sourceHint,advanced);
        function showSources() {
          const enabled = bookmarks.querySelector('input').checked || history.querySelector('input').checked;
          detect.hidden = advanced.hidden = !enabled;
          if (!enabled) advanced.open = false;
          sourceHint.textContent = enabled ? (prefs.chromePath ? '使用指定的用户数据目录' : '自动检测本机 Chrome 配置') : '开启后自动检测本机 Chrome 配置。';
        }
        async function updateSource(key,value) {
          showSources();
          await save({[key]:value},true);
        }
        showSources();
        const scan = button('重新扫描',async()=>{await api.windowAction('rescan');notify('已开始扫描');});
        const files = checkbox('搜索文件和文件夹',prefs.searchFiles,value=>{scan.hidden=!value;return save({searchFiles:value},true);});
        scan.hidden = !prefs.searchFiles;
        content.append(chrome,h('section',{class:'settings-section'},h('h2',{},'文件搜索'),
          h('div',{class:'row'},files,h('span',{class:'spacer'}),scan),
          h('p',{class:'hint small'},'范围包括 Windows 系统索引、桌面、文档和下载目录。')));
      } else if(tab==='clipboard') {
        const p=prefs.clipboardPreferences||{};heading('剪贴板历史');
        const remaining=p.pausedUntil?new Date(p.pausedUntil).getTime()-Date.now():0;
        const recording = h('p',{class:'hint small recording-hint',role:'status'});
        const pause = select([[0,'持续记录'],[1,'暂停 1 小时'],[2,'暂停至明天'],[3,'暂停至手动恢复']],remaining<=0?0:remaining<=3600000?1:remaining<86400000?2:3,async value=>{
          let until=null;
          if(value==='1')until=Date.now()+3600000;
          if(value==='2'){const d=new Date();d.setHours(24,0,0,0);until=d.getTime();}
          if(value==='3')until=Date.now()+315360000000;
          const iso=until?new Date(until).toISOString():null;
          await saveClip({pausedUntil:iso});showRecording(!pause.disabled,iso);
        });
        function showRecording(enabled,until) {
          pause.disabled = !enabled;
          const stop = until && new Date(until);
          recording.textContent = !enabled ? '已关闭，新复制的内容不会记入历史。' : stop && stop > new Date()
            ? stop - Date.now() > 365 * 86400000 ? '已暂停，选择“持续记录”即可恢复。' : '已暂停，将于 '+stop.toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})+' 恢复。'
            : '正在记录新复制的内容。';
        }
        showRecording(p.enabled!==false,p.pausedUntil);
        const enabled = checkbox('自动记录剪贴板',p.enabled!==false,async value=>{
          await saveClip({enabled:value});showRecording(value,prefs.clipboardPreferences.pausedUntil);
        });
        content.append(h('div',{class:'recording-settings'},enabled,recording,row('记录安排',pause)),h('hr'),
          checkbox('默认粘贴为纯文本',!!p.plainTextByDefault,value=>saveClip({plainTextByDefault:value})),h('p',{class:'hint small recording-hint'},'关闭时保留复制内容的原有格式。'),h('hr'));
        content.append(row('保留时间',select([[7,'一周'],[30,'一月'],[90,'三月'],[365,'一年']],p.retentionDays||30,value=>saveClip({retentionDays:Number(value)}))),row('单条内容大小上限',select([5,10,20,50].map(n=>[n,n+' MB']),(p.maxItemBytes||20000000)/1000000,value=>saveClip({maxItemBytes:Number(value)*1000000}))));
        const exclusions = button('编辑排除列表', () => {
          const draft = [...(prefs.clipboardPreferences.ignoreApplications || [])];
          const filename = input('', '输入应用的 .exe 文件名');
          filename.setAttribute('aria-label','应用名称或 exe 文件名');
          const count = h('span',{class:'exclusion-count'});
          const list = h('ul',{class:'exclusion-items','aria-label':'已排除应用'});
          const empty = h('p',{class:'exclusion-empty'},'暂未排除应用');
          const state = h('p',{class:'exclusion-status',role:'status'});
          function paint() {
            count.textContent = draft.length + ' 项';
            empty.hidden = draft.length > 0;
            list.hidden = !draft.length;
            list.replaceChildren(...draft.map((name,index) => {
              const remove = button('移除', () => {
                draft.splice(index,1); paint();
                (list.querySelectorAll('button')[Math.min(index,draft.length-1)] || filename).focus();
              },'ghost');
              remove.setAttribute('aria-label','移除 '+name);
              return h('li',{},h('span',{title:name},name),remove);
            }));
          }
          function add() {
            const name = filename.value.trim();
            if (!name) return false;
            if (draft.some(item => item.toLowerCase() === name.toLowerCase())) {
              state.textContent = '列表中已有该应用。'; filename.select(); return false;
            }
            draft.push(name); filename.value=''; state.textContent=''; paint(); filename.focus(); return true;
          }
          const addButton = button('添加',add);
          filename.addEventListener('keydown', event => {
            if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); add(); }
          });
          const editor = h('div',{class:'exclusion-editor'},h('p',{},'这些应用复制的内容会跳过历史记录。'),
            h('div',{class:'exclusion-heading'},h('strong',{},'已排除应用'),count),list,empty,
            labelFor('添加到待保存的列表',filename),h('div',{class:'row'},filename,addButton),state);
          const cancel = button('取消',() => panel.close());
          const apply = button('保存',async () => {
            if (filename.value.trim() && !add()) return;
            apply.disabled = true;
            try {
              await save({clipboardPreferences:{...prefs.clipboardPreferences,ignoreApplications:draft}},true);
              summary.textContent = draft.length ? '已排除 '+draft.length+' 个应用' : '暂未排除应用';
              panel.close();
            } finally { apply.disabled = false; }
          },'primary');
          const panel = dialog('剪贴板排除列表',editor,[cancel,apply]);
          panel.classList.add('exclusion-dialog');
          panel.setAttribute('aria-label','剪贴板排除列表');
          paint(); filename.focus();
        });
        const summary = h('span',{class:'muted'},(p.ignoreApplications||[]).length?'已排除 '+p.ignoreApplications.length+' 个应用':'暂未排除应用');
        content.append(row('排除应用',h('div',{class:'exclusion-control'},summary,exclusions)),
          h('p',{class:'hint small',style:{marginTop:'18px'}},'只在本机保存；排除应用和隐藏内容不会记录。'));
        content.append(h('div',{class:'settings-footer'},button('打开剪贴板历史',()=>api.windowAction('showClipboard')),button('清理历史… ▾',e=>menu([{label:'清理未收藏记录',action:()=>clearHistory(false)},{label:'清理全部历史',danger:true,action:()=>clearHistory(true)}],e.currentTarget),'danger')));
      } else if(tab==='linkAliases') {
        heading('网址别名','输入别名和关键词，直接打开对应网站。');
        let selected=-1;
        const list=h('div',{class:'editor-list alias-list'}),count=h('span',{class:'muted'}),name=input('','显示名称'),keywords=input('','例如 xhs, xiaohongshu, hongshu'),url=h('textarea',{class:'alias-url',placeholder:'https://example.com/search?q={query}',spellcheck:'false'});
        const example = h('p', {class:'hint small alias-example'});
        const notice = h('span',{class:'alias-save-notice',role:'status'});
        function updateExample() {
          const key = keywords.value.split(/[,，\n]/)[0].trim();
          const title = name.value.trim();
          example.textContent = key && title && url.value.trim()
            ? (url.value.includes('{query}') ? '输入 “'+key+' 咖啡” → 在'+title+'搜索“咖啡”' : '输入 “'+key+'” → 打开'+title)
            : '';
          example.title = example.textContent;
        }
        for (const control of [name,keywords,url]) control.addEventListener('input', () => {updateExample();notice.textContent='尚未保存';});
        const form=h('div',{class:'editor-form alias-form'},field('显示名称',name),field('别名 · 最多三个，用逗号分隔',keywords),h('div',{class:'alias-template'},field('网址模板 · {query} 代表搜索词',url),example));
        function choose(i){selected=i;notice.textContent='';const item=prefs.aliases?.[i];name.value=item?.name||'';keywords.value=(item?.keywords||[]).join(', ');url.value=item?.url||'';paint();}
        function paint(){updateExample();submit.textContent=selected<0?'添加网址':'保存更改';count.textContent=(prefs.aliases||[]).length+' 个网站';remove.disabled=selected<0;list.replaceChildren(...(prefs.aliases||[]).map((item,i)=>{const b=button('',()=>choose(i),i===selected?'selected':'');b.title=item.keywords.join(' · ');b.append(h('strong',{},item.name),h('span',{class:'muted'},item.keywords[0]||''));return b;}));}
        const remove=button('删除',async()=>{if(selected<0)return;if(await confirm('删除网址别名','删除后将无法通过这些别名打开此网址。')){await save({aliases:prefs.aliases.filter((_,i)=>i!==selected)});choose(prefs.aliases.length?Math.min(selected,prefs.aliases.length-1):-1);}});
        const submit=button('保存更改',async()=>{
          const keys=keywords.value.split(/[,，\n]/).map(x=>x.trim()).filter(Boolean);
          if(!name.value.trim()||!keys.length||keys.length>3||!/^https?:\/\//i.test(url.value.trim()))throw Error('请填写名称、一至三个别名和 HTTP(S) 网址');
          const aliases=[...(prefs.aliases||[])];if(aliases.some((item,i)=>i!==selected&&item.keywords.some(k=>keys.some(x=>x.toLowerCase()===k.toLowerCase()))))throw Error('别名已被其他网址使用');
          const item={name:name.value.trim(),keywords:keys,url:url.value.trim()};if(selected<0){aliases.push(item);selected=aliases.length-1;}else aliases[selected]=item;await save({aliases},true);paint();notice.textContent='已保存';
        },'primary');
        form.append(h('div',{class:'row'},submit,notice,h('span',{class:'spacer'}),remove));
        const navigation=h('div',{class:'alias-navigation'},h('div',{class:'alias-list-heading'},'网站',count),list,button('＋ 新增网址',()=>{choose(-1);name.focus();}));
        content.append(h('div',{class:'alias-layout'},navigation,form));choose(prefs.aliases?.length?0:-1);
      } else if(tab==='commandAliases') {
        heading('功能别名','为内置功能添加你习惯的搜索词。');
        const filter = input('', '查找功能或别名');
        filter.type = 'search';
        filter.setAttribute('aria-label', '查找功能或别名');
        const list = h('div', {class:'editor-list alias-list command-list', role:'group', 'aria-label':'功能'});
        const title = h('h2');
        const builtIn = h('p', {class:'command-words'});
        const names = input('', '添加其他叫法，用逗号分隔');
        const draftNotice = h('span', {class:'muted', role:'status'});
        const drafts = new Map();
        const savedNames = id => (prefs.commandAliases?.[id] || []).join(', ');
        function showDraftStatus() {
          draftNotice.textContent = drafts.has(chosen?.id) ? '尚未保存' : '';
        }
        let chosen;
        function selectCommand(command) {
          chosen = command;
          detail.hidden = !chosen;
          if (chosen) {
            title.textContent = command.title;
            const words=[...new Set(command.keywords.filter(word=>word!==command.title))];
            builtIn.textContent=words.slice(0,4).join(' · ')+(words.length>4?' …':'');
            builtIn.title=words.join(' · ');
            names.value = drafts.get(command.id) ?? savedNames(command.id);
            reset.disabled = !(prefs.commandAliases?.[command.id]?.length);
          }
          showDraftStatus();
          markSelection();
        }
        names.addEventListener('input', () => {
          if (names.value === savedNames(chosen.id)) drafts.delete(chosen.id);
          else drafts.set(chosen.id, names.value);
          showDraftStatus();
        });
        function markSelection() {
          for (const choice of list.querySelectorAll('button')) {
            const selected = choice.dataset.id === chosen?.id;
            choice.classList.toggle('selected', selected);
            choice.setAttribute('aria-pressed', String(selected));
          }
        }
        function paint() {
          const query = filter.value.trim().toLowerCase();
          const matches = window.OpenAllCatalog.filter(c =>
            [c.title, ...c.keywords, ...(prefs.commandAliases?.[c.id] || [])].some(word => word.toLowerCase().includes(query)));
          list.replaceChildren(...matches.map(command => {
            const choice = button('', () => selectCommand(command));
            choice.dataset.id = command.id;
            const custom = prefs.commandAliases?.[command.id] || [];
            const words = custom.length ? custom : command.keywords.filter(word => word !== command.title).slice(0,2);
            choice.append(h('strong', {}, command.title), h('span', {class:'muted'}, words[0] || command.title));
            return choice;
          }));
          if (!matches.length) list.append(h('p', {class:'settings-empty-list',role:'status'}, query ? '没有匹配的功能' : '暂无可配置的功能'));
          const current = matches.find(command => command.id === chosen?.id);
          if (current) markSelection();
          else selectCommand(matches[0]);
        }
        const reset = button('重置', async () => {
          const command = chosen;
          const previousDraft = drafts.get(command.id);
          const values = {...prefs.commandAliases};
          delete values[command.id];
          await save({commandAliases:values});
          if (drafts.get(command.id) === previousDraft) drafts.delete(command.id);
          if (chosen === command) selectCommand(command);
          paint();
        });
        const apply = button('保存别名', async () => {
          const command = chosen;
          const previousDraft = drafts.get(command.id);
          const values = names.value.split(/[,，、;；\n]/).map(word => word.trim()).filter(Boolean);
          for (const c of window.OpenAllCatalog) {
            if (c.id === command.id) continue;
            if ([c.title,...c.keywords,...(prefs.commandAliases?.[c.id] || [])].some(n => values.some(v => v.toLowerCase() === n.toLowerCase()))) {
              throw Error('别名与“'+c.title+'”冲突');
            }
          }
          await save({commandAliases:{...prefs.commandAliases,[command.id]:values}});
          if (drafts.get(command.id) === previousDraft) drafts.delete(command.id);
          if (chosen === command) selectCommand(command);
          paint();
        }, 'primary');
        names.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) apply.click(); });
        const detail = h('section', {class:'command-detail'}, title,
          h('div', {class:'field'}, h('span', {class:'muted'}, '系统匹配词'), builtIn),
          h('div',{class:'field'},labelFor('自定义别名',names),h('div',{class:'alias-edit-line'},names,apply)), h('div',{class:'row'},draftNotice,reset));
        const browser = h('div',{class:'alias-navigation'},filter,list);
        content.append(h('div',{class:'alias-layout command-layout'},browser,detail));
        filter.addEventListener('input',paint);
        paint();
      } else if(tab==='snippets') {
        heading('常用片段','在搜索中输入 ;关键词，快速展开并粘贴。');
        const data = await api.snippets('list');
        if (disposed || revision !== renderRevision) return;
        const all = Array.isArray(data) ? data : data.items || [];
        const picker = select([['','新建片段'], ...all.map(x => [x.id,x.name+' · ;'+x.keyword])], '', null);
        picker.style.flex = '1';
        picker.setAttribute('aria-label','选择片段');
        const name = input('','片段名称');
        const key = input('','不含空格的关键词');
        const text = h('textarea',{placeholder:'片段内容，可使用 {{date}}、{{time}}、{{clipboard}}'});
        const expanded = h('pre',{class:'snippet-expanded-text',tabindex:'0','aria-label':'片段展开结果'});
        const resultPanel = h('section',{class:'snippet-expansion',id:'snippet-expansion',hidden:true},
          h('h2',{},'展开结果'),expanded);
        let expansionRequest = 0;
        function fill(id) {
          ++expansionRequest;
          resultPanel.hidden = true;
          preview.setAttribute('aria-expanded','false'); preview.textContent='预览展开';
          const item = all.find(x => x.id === id);
          picker.value = selectedSnippetID = item?.id || '';
          name.value = item?.name || '';
          key.value = item?.keyword || '';
          text.value = item?.body || '';
          remove.hidden = !item;
        }
        const create = button('新建',() => {fill('');name.focus();});
        const remove = button('删除',async () => {
          if (selectedSnippetID && await confirm('删除片段','确认删除所选常用片段？')) {
            await api.snippets('delete',{id:selectedSnippetID});
            selectedSnippetID = undefined;
            if (revision === renderRevision) render();
          }
        },'danger');
        const apply = button('保存',async () => {
          if (!key.value.trim() || /\s/.test(key.value.trim()) || !text.value) throw Error('关键词不能含空格，内容不能为空');
          const item = await api.snippets('save',{id:selectedSnippetID || undefined,name:name.value.trim(),keyword:key.value.trim(),body:text.value});
          if (item?.ok === false) throw Error(item.error || '关键词已存在');
          selectedSnippetID = item.id;
          notify('片段已保存');
          if (revision === renderRevision) render();
        },'primary');
        async function updateExpansion() {
          const request = ++expansionRequest;
          const parts = await api.snippets('expand',{body:text.value,parts:true});
          if (request === expansionRequest && revision === renderRevision && !resultPanel.hidden) {
            expanded.replaceChildren(...parts.map(part => part.variable ? h('mark',{},part.text) : document.createTextNode(part.text)));
          }
        }
        const preview = button('预览展开',async () => {
          resultPanel.hidden = !resultPanel.hidden;
          preview.setAttribute('aria-expanded',String(!resultPanel.hidden));
          preview.textContent = resultPanel.hidden ? '预览展开' : '收起预览';
          if (!resultPanel.hidden) await updateExpansion();
        },'ghost');
        preview.setAttribute('aria-controls',resultPanel.id);
        text.addEventListener('input',() => {
          if (!resultPanel.hidden) updateExpansion().catch(error=>notify(error.message,true));
        });
        picker.onchange = () => fill(picker.value);
        fill(selectedSnippetID ?? all[0]?.id);
        const variables = h('div',{class:'snippet-variables',role:'group','aria-label':'插入变量'},h('span',{},'插入变量'));
        for (const [label,token] of [['日期','{{date}}'],['时间','{{time}}'],['剪贴板','{{clipboard}}']]) {
          const insert = button(label,()=>{
            text.setRangeText(token,text.selectionStart,text.selectionEnd,'end');
            text.focus();text.dispatchEvent(new Event('input',{bubbles:true}));
          },'ghost');
          insert.title=token;variables.append(insert);
        }
        text.placeholder='例如：已于 {{date}} 收到，稍后回复。';
        content.append(h('div',{class:'row snippet-picker'},all.length ? picker : h('h2',{},'新建片段'),all.length ? create : null),
          h('div',{class:'editor-form'},h('div',{class:'grid'},field('名称',name),field('关键词 · 用 ; 调用',key)),h('div',{class:'field snippet-body-field'},h('div',{class:'snippet-body-heading'},labelFor('内容',text),variables),text),h('div',{class:'snippet-template-actions'},preview),resultPanel,
            h('div',{class:'row'},remove,h('span',{class:'spacer'}),apply)));
      } else if(tab==='permissions') {
        heading('权限与隐私','本地运行，内容保存在当前 Windows 用户目录。');const d=await api.diagnostics();
        if (disposed || revision !== renderRevision) return;
        const extraActions = [];
        function capability(title,state,description,actions) {
          extraActions.push(...actions.slice(1));
          return h('section',{class:'permission-row'},h('div',{},h('h2',{},title),h('p',{},description)),
            h('div',{class:'permission-actions'},h('strong',{},state),actions[0]));
        }
        const shortcuts = ['search','clipboard','stack','selection'].map(key=>d.shortcuts?.[key]);
        const active = shortcuts.filter(value=>value===true).length;
        content.append(
          capability('快捷键与自动粘贴',d.shortcutRecording?'录制中':shortcuts.every(value=>typeof value==='boolean')?active+' / 4 项快捷键已启用':'快捷键状态待确认',
            '粘贴到以管理员身份运行的应用时，OpenAll 需要相同权限。',[button('查看快捷键 →',()=>render('general'),'ghost'),button('重新检查快捷键',()=>render(),'ghost')]),
          capability('文件访问',prefs.searchFiles?'文件搜索已开启':'文件搜索已关闭','只读取可访问目录的文件名。',
            [button('打开搜索设置 →',()=>render('search'),'ghost'),...(prefs.searchFiles?[button('重新扫描',()=>api.windowAction('rescan'),'ghost')]:[])]),
          capability('图片文字识别',d.ocrAvailable===false?'需要 OCR 语言包':'使用本机 OCR','识别使用 Windows 语言包，图片与结果保存在本机。',
            [button('打开 Windows 语言设置 ↗',()=>api.fileAction('openSystemSettings',{uri:'ms-settings:regionlanguage'}),'ghost')]),
          capability('本地数据','当前 Windows 账户','查看 OpenAll 的设置与历史文件。',
            [button('打开数据目录 ↗',()=>api.fileAction('dataDirectory'),'ghost')]),
          h('details',{class:'permission-more'},h('summary',{},'其他操作'),h('div',{class:'row'},...extraActions)));
      } else if(tab==='diagnostics') {
        heading('状态与诊断');const d=await api.diagnostics();
        if (disposed || revision !== renderRevision) return;
        const shortcutNames = [['search','打开搜索'],['clipboard','剪贴板'],['stack','复制堆栈'],['selection','对选中内容操作']];
        const failed = shortcutNames.filter(([key]) => d.shortcuts?.[key] === false);
        if (failed.length && !d.shortcutRecording) {
          content.append(h('section',{class:'shortcut-issue'},
            h('div',{},h('strong',{},`${failed.length} 项快捷键未启用`),
              h('p',{},failed.map(([,name])=>name).join('、'))),
            button('查看快捷键',()=>render('general'))));
        }
        if (!failed.length || d.shortcutRecording) {
          const keysReady = shortcutNames.every(([key])=>d.shortcuts?.[key] === true);
          const summary = d.shortcutRecording ? '正在录制快捷键' : d.index?.indexing ? '索引正在更新'
            : keysReady ? '全局快捷键已启用' : '快捷键状态待确认';
          content.append(h('div',{class:'diagnostic-summary'},h('strong',{},summary),
            h('span',{},'检查于 '+new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}))));
        }
        const rows=[['版本',d.version||'—'],['平台',d.platform==='win32'?'Windows':d.platform||'Windows'],['应用索引',d.index?.apps??0],['文件索引',d.index?.files??0],['Chrome 配置',d.index?.profiles??0],['剪贴板记录',d.clipboard??d.clipboardCount??0],['内存',d.memoryMB?d.memoryMB+' MB':'—'],['索引状态',d.index?.indexing?'正在更新':'就绪'],['系统文件索引',d.index?.systemIndex?.available?'已连接 Windows Search':d.index?.systemIndex?.reason||'搜索文件时自动连接']];
        const stats=entries=>h('dl',{class:'status-grid'},entries.flatMap(([name,value])=>[h('dt',{},name),h('dd',{},String(value))]));
        const environment=new Set(['版本','平台','内存']);
        content.append(stats(rows.filter(([name])=>!environment.has(name))),h('details',{class:'diagnostic-environment'},h('summary',{},'系统与版本信息'),stats(rows.filter(([name])=>environment.has(name)))),h('div',{class:'row'},button('刷新状态',()=>render()),button('重新建立索引',()=>api.windowAction('rescan')),button('复制诊断',async()=>{await api.copyText(JSON.stringify(d,null,2));notify('诊断信息已复制');})),h('details',{class:'diagnostic-updates'},h('summary',{},'应用更新'),h('div',{class:'row'},bind(input(prefs.updateFeedURL,'更新源地址（HTTPS）'),value=>save({updateFeedURL:value})),button('检查更新',async()=>{const result=await api.windowAction('checkUpdates');notify(result?.message||'已完成更新检查');render();})),h('div',{class:'row',style:{marginTop:'12px'}},button('安装更新',async()=>{if(await confirm('安装更新','将下载并校验安装包，然后关闭 OpenAll 启动安装器。'))await api.windowAction('installUpdate');},'primary'),button('回退上一版',async()=>{if(await confirm('回退上一版','将关闭 OpenAll，重新安装上次保留的版本。'))await api.windowAction('rollbackUpdate');})),h('p',{class:'hint small'},d.updates?.message||'填写可信的 HTTPS 更新源后检查更新。')));
      } else if(tab==='appearance') {
        heading('外观','调整背景和强调色，所有窗口同步生效。');
        const backgrounds=[['石墨','#242626'],['深蓝','#172838'],['暖棕','#30251F'],['雾白','#F2F1ED'],['跟随系统','system']],accents=[['香槟','#d8c19e'],['海蓝','#5e9ccd'],['青绿','#63b8a4'],['珊瑚','#d9917b']];
        function palette(title, values, key) {
          const choices = values.map(([label, value]) => {
            const patch = value === 'system' ? {theme: 'system'} :
              {[key]: value, ...(key === 'backgroundHex' ? {theme: 'custom'} : {})};
            const choice = button('', () => save(patch, true), 'color-choice');
            const sample = h('span',{class:'color-sample','aria-hidden':'true'});
            sample.style.background = value === 'system' ? 'linear-gradient(90deg,#f2f1ed 50%,#242626 50%)' : value;
            choice.dataset.key = key;
            choice.dataset.value = value.toLowerCase();
            choice.append(sample, h('span',{},label), h('span',{class:'color-check','aria-hidden':'true'},'✓'));
            return choice;
          });
          return h('div',{class:'palette-group',role:'group','aria-label':title},
            h('h2',{},title), h('div',{class:'palette-row'},choices));
        }
        function customColor(label, key) {
          const input = h('input',{type:'color',value:prefs[key]});
          input.dataset.colorKey = key;
          input.oninput = () => save({[key]:input.value,...(key === 'backgroundHex' ? {theme:'custom'} : {})},true);
          return h('label',{class:'custom-color'},input,label,h('span',{class:'custom-value'}),h('span',{class:'color-check','aria-hidden':'true'},'✓'));
        }
        const preview = h('section',{class:'appearance-preview'},
          h('h3',{},'预览'),
          h('div',{class:'search-result'},
            h('span',{class:'search-result-icon'},icon('json',24)),
            h('div',{class:'search-result-copy'},h('div',{class:'search-result-title'},'JSON 工具'),
              h('div',{class:'search-result-detail'},'校验、键名自然排序与转义')),h('span',{class:'preview-open'},'↵ 打开')));
        content.append(palette('背景',backgrounds,'backgroundHex'),palette('强调色',accents,'accentHex'),
          h('div',{class:'custom-colors'},customColor('自定义背景','backgroundHex'),customColor('自定义强调色','accentHex')),
          preview, h('div',{class:'settings-footer'},button('恢复默认',async()=>{
            await save({theme:'dark',backgroundHex:'#242626',accentHex:'#d8c19e'});render();
          })));
        syncAppearance(prefs);
      }
    }
    function syncAppearance(next) {
      prefs = next;
      if (tab !== 'appearance') return;
      for (const choice of content.querySelectorAll('.color-choice')) {
        const {key, value} = choice.dataset;
        const selected = key === 'backgroundHex' && prefs.theme === 'system' ? value === 'system' : prefs[key]?.toLowerCase() === value;
        choice.classList.toggle('selected', selected);
        choice.setAttribute('aria-pressed', String(selected));
      }
      for (const color of content.querySelectorAll('input[data-color-key]')) {
        const key = color.dataset.colorKey;
        color.value = prefs[key];
        const selected = content.querySelector('.color-choice[data-key="'+key+'"][aria-pressed="true"]');
        color.parentElement.classList.toggle('active',!selected);
        color.nextElementSibling.textContent = color.value.toUpperCase();
      }
    }
    async function clearHistory(all) {if(await confirm('清理剪贴板历史',all?'将删除全部历史记录，包括收藏。':'将删除未收藏的历史记录，收藏保留。')){await api.clipboardAction('clear',{includeFavorites:all});notify('历史记录已清理');}}
    async function searchRules() {
      const revision = ++renderRevision;
      const back = button('← 返回搜索设置', () => render('search'), 'ghost');
      content.replaceChildren(h('div',{class:'settings-rule-heading'},back,h('h1',{},'搜索排序管理')));
      const data = await api.windowAction('searchRules',{includeUsage:true});
      if (disposed || revision !== renderRevision) return;
      const rules = Array.isArray(data) ? data : data?.rules || [];
      if (rules.length) {
        const rows = rules.map(item => h('tr',{},h('td',{},item.title || item.value),h('td',{},item.hidden ? '已隐藏' : '已置顶'),
          h('td',{},button('恢复默认',async () => {
            await api.windowAction('searchRule',{action:'reset',item});
            if (!disposed && revision === renderRevision) searchRules();
          }))));
        content.append(h('table',{class:'data-table'},h('thead',{},h('tr',{},...['名称','规则','操作'].map(label => h('th',{},label)))),h('tbody',{},rows)));
      } else {
        content.append(h('div',{class:'rules-empty'},h('h2',{},'暂无置顶或隐藏的结果'),
          h('p',{},'在搜索中选中结果，按 Ctrl+K 即可置顶或隐藏。'),
          button('打开搜索',()=>api.windowAction('showSearch'),'primary')));
      }
      if (!data?.hasUsage) return;
      content.append(h('section',{class:'ranking-history'},h('div',{},h('h2',{},'使用频率记录'),h('p',{},'清除后重新学习使用频率，手动规则会保留。')),button('清除记录',async () => {
        if (await confirm('清除使用记录','搜索排序将恢复为默认顺序。')) {
          await api.windowAction('searchRule',{action:'clearUsage'});
          notify('已清除使用记录');
          if (!disposed && revision === renderRevision) searchRules();
        }
      },'ghost')));
    }
    await render();return {dispose(){disposed=true;recording?.cancel();},selectTab:render,getTab:()=>tab,settingsChanged:syncAppearance};
  }
  window.OpenAllPages.settings=settingsPage;
  for(const id of ['permissions','diagnostics','snippets','linkAliases','commandAliases'])window.OpenAllPages[id]=(root,ctx)=>settingsPage(root,{...ctx,initialValue:id});
})();
