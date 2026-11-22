(() => {
  'use strict';
  window.OpenAllSurfaceEffects.install();
  const api=window.openall, root=document.getElementById('app'),title=document.getElementById('window-title');
  const UI=window.OpenAllUI,{h,button,icon,iconButton,notify,menu,prompt,confirm}=UI;
  let settings={},page='',controller=null,generation=0,lastEditable=null;
  const legacy={'JSON 工具':'json','文本对比':'comparison','Markdown 编辑器':'markdown','结构化配置对比':'configDiff','执行计划阅读器':'explain','SQL 执行计划':'explain','SQL 参数还原':'sqlRestore','日志时间线':'logTimeline','剪贴板':'clipboard','设置':'settings'};
  const titles={search:'OpenAll',settings:'OpenAll 设置',clipboard:'剪贴板',stack:'复制堆栈',selection:'对选中内容操作',clipboardPreview:'剪贴板预览',...Object.fromEntries(window.OpenAllCatalog.map(c=>[c.id,c.title])),settings:'OpenAll 设置'};
  const normalize=id=>legacy[id]||id;
  const call=async(action,payload={})=>api.windowAction(action,payload);
  function applyTheme(prefs) {
    settings=prefs||settings;
    const palette=window.OpenAllTheme.palette(settings,matchMedia('(prefers-color-scheme: light)').matches);
    window.OpenAllTheme.apply(document,palette);
    window.dispatchEvent(new CustomEvent('openall-theme',{detail:{...palette.vars,light:palette.light}}));
  }
  function openTool(id,value='') {id=normalize(id);return ['permissions','diagnostics','snippets','linkAliases','commandAliases'].includes(id)?api.openTool('settings',id):api.openTool(id,value);}
  async function render(id,initialValue='') {
    id=normalize(id);const revision=++generation;controller?.dispose?.();controller=null;page=id;document.body.dataset.page=id;title.textContent=titles[id]||'OpenAll';document.title=title.textContent;root.replaceChildren();root.className='';
    const ctx={api,...UI,openPage:openTool,initialValue,settings};
    try {
      const mount=window.OpenAllPages[id];if(!mount)throw Error('找不到工具：'+id);
      const c=await mount(root,ctx);if(revision!==generation){c?.dispose?.();return;}controller=c||{};window.OpenAllApp.controller=controller;controller.focus?.();
    } catch(error) {root.replaceChildren(h('div',{class:'tool-error'},h('h2',{},'页面载入失败'),h('p',{},error.message),button('重试',()=>render(id,initialValue))));console.error(error);throw error;}
    return controller;
  }
  document.addEventListener('focusin',e=>{if(e.target.matches('input,textarea,[contenteditable=true]'))lastEditable=e.target;});
  function pasteText(value) {
    const text=typeof value==='string'?value:value?.text||'';let target=document.activeElement;
    if(!target?.matches?.('input,textarea,[contenteditable=true]')&&lastEditable?.isConnected)target=lastEditable;
    if(target?.matches('input,textarea')&&!target.readOnly&&!target.disabled&&typeof target.selectionStart==='number') {target.focus();const start=target.selectionStart??target.value.length,end=target.selectionEnd??start;target.setRangeText(text,start,end,'end');target.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertFromPaste',data:text}));return;}
    if(target?.isContentEditable&&!target.closest('.cm-editor')){target.focus();document.execCommand('insertText',false,text);return;}
    controller?.paste?.(text);
  }
  window.addEventListener('keydown',e=>{
    if(e.defaultPrevented)return;
    if((e.ctrlKey||e.metaKey)&&e.key===','){e.preventDefault();openTool('settings');}
    if(e.key==='Escape'&&!document.querySelector('dialog[open],.context-menu')&&!document.querySelector('.cm-search')){e.preventDefault();call('close');}
  });
  window.addEventListener('unhandledrejection',e=>{notify(e.reason?.message||String(e.reason),true);console.error(e.reason);});
  api.onNavigate((id,value)=>{if(id&&typeof id==='object'){value=id.initialValue;id=id.page;}if(normalize(id)===page&&page!=='search'&&(value==null||value==='')){controller?.focus?.();return;}render(id,value).catch(()=>{});});
  api.onPaste?.(pasteText);api.onPasteImage?.(value=>{if(page==='image')render('image',value);else openTool('image',value);});api.onSettingsChanged?.(prefs=>{applyTheme(prefs);controller?.settingsChanged?.(prefs);});api.onNotice?.(message=>notify(message,true));
  matchMedia('(prefers-color-scheme: light)').addEventListener('change',()=>applyTheme(settings));
  window.OpenAllApp={render,openTool,applyTheme,pasteText,get page(){return page;},controller:null};

  // 仅标记当前可见文本里的首个字面匹配，保留原始大小写和纯文本内容。
  function literalMatcher(term) {
    if (!term || term.length > 256) return null;
    return new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu');
  }
  function markFirst(text, pattern) {
    const match = pattern?.exec(text);
    if (!match) return [text];
    return [text.slice(0, match.index), h('mark', {}, match[0]), text.slice(match.index + match[0].length)];
  }

  window.OpenAllPages.search=async(host,ctx)=>{
    const ownContext=await call('context');
    const panel = h('div', {class: 'search-panel idle'}), head = h('div', {class: 'search-header'});
    const input = h('input', {
      class: 'search-input', type: 'text', role: 'combobox', placeholder: '搜索应用、文件与更多',
      autocomplete: 'off', spellcheck: 'false', 'aria-label': '搜索应用、文件与更多',
      'aria-controls': 'launcher-results', 'aria-expanded': 'false', 'aria-autocomplete': 'list',
      'aria-describedby': 'launcher-hint'
    });
    const list = h('div', {class: 'search-results', id: 'launcher-results', role: 'listbox', 'aria-label': '搜索结果'});
    const footer = h('div', {class: 'search-footer', id: 'launcher-hint'});
    const returnHint = h('kbd', {class: 'search-result-action'});
    const contextHint = h('span', {class: 'search-result-context'});
    const rowCommands = h('span', {class: 'search-result-commands'}, returnHint, contextHint);
    let rows = [], selected = -1, request = 0, pinned = !!ownContext.pinned, disposed = false, searchMessage = '';
    const pin = iconButton('pin', '固定搜索窗口', async () => {
      pinned = !pinned;
      await call('pin', {pinned});
      pin.classList.toggle('selected', pinned);
      pin.setAttribute('aria-pressed', String(pinned));
    });
    pin.classList.add('search-pin'); pin.classList.toggle('selected', pinned);
    pin.setAttribute('aria-pressed', String(pinned));
    head.append(h('span', {class: 'search-glyph'}, icon('search', 16)), input, pin);
    panel.append(head, h('div', {class: 'search-divider'}), list, footer);
    host.append(panel);
    function rowSymbol(item){const k=item.kind||item.type;if(k==='application')return'application';if(k==='url'||k==='bookmark')return'link';if(k==='text')return'text';if(k==='file')return'file';return ({gold:'chart',json:'json',comparison:'comparison',configDiff:'comparison',clipboard:'clipboard',image:'image',settings:'settings',snippets:'snippets',linkAliases:'link',commandAliases:'command',translate:'translate',unicode:'unicode',markdown:'markdown',id:'person',manual:'terminal',converter:'convert',explain:'chart',logTimeline:'list',sqlRestore:'json',configFormat:'sliders',sqlFormat:'database',stack:'stack',selection:'cursor',permissions:'permissions',diagnostics:'diagnostics'})[item.value||item.id]||'command';}
    function returnAction(item) {
      if (item.type === 'text') return '复制';
      if (item.type === 'snippet') return '使用片段';
      return '打开';
    }
    const isCatalog = () => /^[?？]/.test(input.value.trim());
    const isFavorite = item => (settings.commandFavorites || []).includes(item.id || item.value);
    function updateHint() {
      const q = input.value.trim(), item = rows[selected];
      if (!input.value) { footer.textContent = ''; return; }
      let message = searchMessage;
      if (!message && !item) {
        if (!settings.searchFiles && /^(文件|文档|图片)\s/.test(q)) message = '文件搜索已关闭 · 请在设置 → 搜索中开启';
        else if (isCatalog()) message = '没有匹配的命令';
        else if (q.startsWith('=')) message = '没有精确匹配 · 例如 =记事本';
        else message = '没有匹配结果 · 输入 ? 浏览命令';
      }
      if (!message) {
        message = (q.startsWith('=') ? '精确匹配 · ' : '') + rows.length + ' 项结果' + (rows.length > 1 ? '　↑↓ 选择' : '');
      }
      if (footer.textContent !== message) footer.textContent = message;
    }
    function choose(index) {
      const previous = list.children[selected];
      if (previous) {
        previous.classList.remove('selected');
        previous.setAttribute('aria-selected', 'false');
      }
      selected = index;
      const current = list.children[selected];
      if (current) {
        current.classList.add('selected');
        current.setAttribute('aria-selected', 'true');
        input.setAttribute('aria-activedescendant', current.id);
        returnHint.textContent = '↵  ' + returnAction(rows[selected]);
        contextHint.textContent = isCatalog() && rows[selected].type === 'tool'
          ? (isFavorite(rows[selected]) ? 'Ctrl+K 取消收藏' : 'Ctrl+K 收藏') : 'Ctrl+K 操作';
        current.append(rowCommands);
      } else {
        input.removeAttribute('aria-activedescendant');
        rowCommands.remove();
      }
      updateHint();
    }
    function paint(index) {
      const pattern = literalMatcher(input.value.trim().replace(/^[=?？]/, '').trim());
      list.replaceChildren(...rows.map((item, i) => h('div', {
        id: 'launcher-result-' + i, class: 'search-result', role: 'option', 'aria-selected': 'false',
        onclick: () => execute(item), oncontextmenu: event => { event.preventDefault(); choose(i); actions(item, event); }
      }, h('span', {class: 'search-result-icon'}, item.icon ? h('img', {src: item.icon, alt: ''}) : icon(rowSymbol(item), 28)),
      h('div', {class: 'search-result-copy'},
        h('div', {class: 'search-result-title'}, markFirst(item.title, pattern), item.type === 'tool' && isFavorite(item) ? ' ★' : ''),
        h('div', {class: 'search-result-detail'}, item.detail || '')
      ))));
      choose(index);
    }
    async function execute(item){if(!item)return;await api.open(item);if(!pinned)await call('close');}
    async function favorite(item){const id=item.id||item.value,values=new Set(settings.commandFavorites||[]);if(values.has(id))values.delete(id);else values.add(id);await api.saveSettings({commandFavorites:[...values]});settings=await api.settings();await update(false);}
    function actions(item,anchor){menu([{label:returnAction(item),action:()=>execute(item)},{label:(settings.commandFavorites||[]).includes(item.id||item.value)?'取消收藏命令':'收藏命令',disabled:item.type!=='tool',action:()=>favorite(item)},{label:'指定应用打开…',disabled:!['application','file'].includes(item.type),action:()=>api.fileAction('openWith',{path:item.value})},null,{label:item.pinned?'取消置顶':'置顶',action:async()=>{await call('searchRule',{action:'pin',item});update(false);}},{label:'隐藏此结果',action:async()=>{await call('searchRule',{action:'hide',item});update(false);}},{label:'复制内容 / 路径',action:()=>api.copyText(item.value)},null,{label:'搜索设置',action:()=>openTool('settings','search')}],anchor);}
    async function update(changed = true) {
      const token = ++request, q = input.value;
      const previous = !changed && rows[selected];
      const found = await api.search(q);
      if (disposed || token !== request || q !== input.value) return;
      rows = Array.isArray(found) ? found : found?.items || [];
      searchMessage = found?.message || '';
      const index = previous ? rows.findIndex(item => item.value === previous.value && item.type === previous.type) : 0;
      panel.classList.toggle('idle', !q);
      input.setAttribute('aria-expanded', String(!!q && rows.length > 0));
      paint(rows.length ? Math.max(0, index) : -1);
      if (changed) list.scrollTop = 0;
      await call('resizeSearch', {count: rows.length, idle: !q});
    }
    input.addEventListener('input', () => update());
    input.addEventListener('keydown', event => {
      if (event.isComposing) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (!rows.length) return;
        const next = Math.max(0, Math.min(rows.length - 1, selected + (event.key === 'ArrowDown' ? 1 : -1)));
        if (next !== selected) { choose(next); list.children[next].scrollIntoView({block: 'nearest'}); }
      } else if (event.key === 'Enter') {
        event.preventDefault(); execute(rows[selected]);
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && rows[selected]) {
        event.preventDefault();
        if (isCatalog() && rows[selected].type === 'tool') favorite(rows[selected]);
        else actions(rows[selected], input);
      }
    });
    const off=api.onSearchUpdated?.(()=>update(false));input.value=typeof ctx.initialValue==='string'?ctx.initialValue:'';await update();return {focus:()=>input.focus(),dispose(){disposed=true;off?.();},search:async text=>{input.value=text;await update();},getResults:()=>rows,paste:text=>{input.setRangeText(text,input.selectionStart??input.value.length,input.selectionEnd??input.value.length,'end');update();}};
  };

  window.OpenAllPages.clipboard=async(host,ctx)=>{
    let all=await api.history(),filtered=[],selected=new Set(),current=0,activeBoard='历史',disposed=false,filter='全部';const dragContent=new Map();const p=ctx.settings.clipboardPreferences||{};
    const shelf=h('div',{class:'clipboard-shelf'}),search=h('input',{class:'clipboard-search',placeholder:'搜索剪贴板',type:'text',autocomplete:'off','aria-label':'搜索剪贴板'}),tabs=h('div',{class:'clipboard-tabs'}),track=h('div',{class:'clip-track',role:'listbox','aria-label':'剪贴板记录','aria-multiselectable':'true'});
    const info = h('span', {class:'clip-count', role:'status', 'aria-atomic':'true'});
    const hint = h('div', {class:'clip-key-hints'});
    const previewButton = button('预览卡片', preview);
    const footer = h('div', {class:'clipboard-footer'}, previewButton, info, hint);
    const select=h('select',{class:'clipboard-filter','aria-label':'内容类型'},['全部','文本','链接','图片','文件','JSON','Markdown','HTML','富文本'].map(x=>h('option',{value:x},x)));
    let layout = p.shelfLayout === 'list' ? 'list' : 'cards', pendingLayout = 0;
    const layoutButton = button('', async () => {
      const target = layout === 'cards' ? 'list' : 'cards';
      pendingLayout++;
      showLayout(target);
      try { await api.clipboardAction('setLayout', {layout:target}); }
      catch (error) {
        if (!disposed && target === layout) showLayout((await api.settings()).clipboardPreferences?.shelfLayout);
        throw error;
      } finally { pendingLayout--; }
    }, 'clipboard-layout');
    layoutButton.addEventListener('mousedown', event => {
      if (event.button === 0 && (document.activeElement === search || document.activeElement?.matches('.clip-card'))) event.preventDefault();
    });
    const close=iconButton('close','关闭剪贴板',()=>call('close'));close.classList.add('clipboard-close');shelf.append(h('div',{class:'clipboard-header'},search,tabs,layoutButton,select,close),track,footer);host.append(shelf);
    function showLayout(value) {
      layout = value === 'list' ? 'list' : 'cards';
      const list = layout === 'list';
      shelf.dataset.layout = layout;
      track.setAttribute('aria-orientation', list ? 'vertical' : 'horizontal');
      layoutButton.replaceChildren(icon(list ? 'cards' : 'list', 16));
      layoutButton.title = list ? '切换到大卡片' : '切换到紧凑列表';
      layoutButton.setAttribute('aria-label', '紧凑列表');
      layoutButton.setAttribute('aria-pressed', String(list));
      if (filtered.length) track.children[current]?.scrollIntoView({block:'nearest',inline:'nearest'});
      updateHints(document.activeElement);
    }
    const id=r=>r.id||r.hash;
    const type=r=>r.type||({image:'图片',link:'链接',files:'文件'})[r.kind]||(/^[\s]*[\[{]/.test(r.text||r.value||'')&&(()=>{try{JSON.parse(r.text||r.value);return true;}catch{return false;}})()?'JSON':r.html?'HTML':'文本');
    const hasFilter = () => Boolean(search.value.trim()) || filter !== '全部';
    function updateHints(target) {
      const commands = [];
      if (filtered.length && target === search) commands.push(layout === 'list' ? '↓ 选择记录，再按空格预览' : '↓ 选择卡片，再按空格预览');
      const card = target?.matches?.('.clip-card') ? filtered[Number(target.dataset.index)] : null;
      if (card) {
        const enterAction = settings.clipboardPreferences?.directPaste === false ? '复制' : '粘贴';
        commands.push(`↵ ${enterAction}${selected.size > 1 ? '所选' : ''}`);
        if (!card.favorite && !card.pinned && !card.tags?.length) commands.push('Backspace 删除此卡');
        commands.push(layout === 'list' ? '↑ ↓ 浏览' : '← → 浏览', '空格 预览', 'Ctrl 点击多选');
      }
      hint.replaceChildren(...commands.map(label => h('span', {}, label)));
      hint.title = commands.join('　');
    }
    shelf.addEventListener('focusin', e => updateHints(e.target));
    shelf.addEventListener('focusout', e => updateHints(e.relatedTarget));
    function boards(){tabs.replaceChildren();const names=['历史',...(settings.clipboardPreferences?.pinboards||p.pinboards||['收藏'])];for(const name of names){const b=button('',()=>{activeBoard=name;selected.clear();current=0;boards();paint();},'clipboard-tab'+(activeBoard===name?' selected':''));const color=({blue:'#6e9bb5',purple:'#a08cb4',green:'#79a58a',red:'#cb8980',yellow:'#c5af78'})[(settings.clipboardPreferences?.pinboardColors||p.pinboardColors||{})[name]]||'#bbbdb9';b.setAttribute('aria-pressed', String(name === activeBoard));b.append(h('span',{class:'tab-dot',style:{'--dot':color}}),name);if(name!=='历史')b.addEventListener('contextmenu',e=>{e.preventDefault();menu([{label:'重命名标签',action:async()=>{const value=await prompt('标签名称',name);if(value?.trim()&&value.trim()!==name){await api.clipboardAction('renameTag',{tag:name,name:value.trim()});settings=await api.settings();activeBoard=value.trim();boards();refresh();}}},{label:'标签颜色',action:()=>menu(['blue','purple','green','red','yellow'].map((color,i)=>({label:['蓝色','紫色','绿色','红色','黄色'][i],action:async()=>{await api.clipboardAction('tagColor',{tag:name,color});settings=await api.settings();boards();}})),b)},{label:'删除标签',danger:true,action:async()=>{if(await confirm('删除标签','仅删除标签，记录会保留在历史中。')){await api.clipboardAction('deleteTag',{tag:name});settings=await api.settings();activeBoard='历史';boards();refresh();}}}],b);});tabs.append(b);}const add = button('', () => {
        const field=h('input',{type:'text',placeholder:'新标签名称','aria-label':'新标签名称',maxLength:30});
        const create=button('创建',()=>{},'clip-tag-submit');
        create.type='submit';
        const cancel=iconButton('close','取消新建标签',finish);
        const form=h('form',{class:'clip-tag-create','aria-label':'新建标签'},field,create,cancel);
        function finish(){form.replaceWith(add);add.focus();}
        form.addEventListener('keydown',e=>{if(e.key==='Escape'&&!e.isComposing){e.preventDefault();e.stopPropagation();finish();}});
        form.addEventListener('submit',async e=>{
          e.preventDefault();
          const value=field.value.trim();
          if (!value || create.disabled){field.focus();return;}
          create.disabled=true;
          try {
            await api.clipboardAction('newTag',{tag:value});
            settings=await api.settings();activeBoard=value;boards();paint();
            tabs.querySelector('[aria-pressed=true]')?.focus();
          } catch(error){notify(error.message,true);create.disabled=false;field.focus();}
        });
        add.replaceWith(form);field.focus();form.scrollIntoView({block:'nearest',inline:'nearest'});
      }, 'clipboard-tab clipboard-add-tab');
      add.title = '新建标签';
      add.setAttribute('aria-label', '新建标签');
      add.append(icon('plus', 13), h('span', {}, '新建标签'));
      tabs.append(add);
      tabs.querySelector('[aria-pressed=true]')?.scrollIntoView({block:'nearest', inline:'nearest'});
    }
    function normalizeCursor() {
      if (!filtered.length) return;
      if (!selected.size) selected.add(id(filtered[current]));
      if (!selected.has(id(filtered[current]))) current = filtered.findIndex(item => selected.has(id(item)));
    }
    function finishSelection(focus) {
      const count = `${filtered.length} 条${hasFilter() ? '匹配' : '记录'}`;
      info.textContent = selected.size ? `${count} · ${selected.size} 项已选` : count;
      previewButton.disabled = !selected.size;
      if (focus) (filtered.length ? track.children[current] : search).focus({preventScroll:true});
      updateHints(document.activeElement);
    }
    function syncSelection(focus) {
      normalizeCursor();
      for (let index = 0; index < filtered.length; index++) {
        const item = track.children[index], isSelected = selected.has(id(filtered[index]));
        if (item.classList.contains('selected') !== isSelected) {
          item.classList.toggle('selected', isSelected);
          item.setAttribute('aria-selected', String(isSelected));
        }
        const tabIndex = current === index ? 0 : -1;
        if (item.tabIndex !== tabIndex) item.tabIndex = tabIndex;
      }
      finishSelection(focus);
    }
    function paint(focus=false) {
      const q=search.value.trim().toLowerCase();filtered=all.filter(r=>(activeBoard==='历史'||activeBoard==='收藏'&&(r.favorite||r.pinned)||(r.tags||[]).includes(activeBoard)||r.pinboard===activeBoard)&&(filter==='全部'||type(r)===filter||filter==='文本'&&['文本','JSON','Markdown','HTML','富文本'].includes(type(r)))&&(!q||[r.title,r.kind==='image'?'':(r.text||r.value),r.sourceName,r.ocrText,r.recognizedText,type(r),...(r.files||[])].filter(Boolean).join(' ').toLowerCase().includes(q)));
      const hadCardFocus = document.activeElement?.matches('.clip-card');
      const available=new Set(filtered.map(id));selected=new Set([...selected].filter(x=>available.has(x)));current=Math.min(current,Math.max(0,filtered.length-1));
      normalizeCursor();
      const pattern = literalMatcher(search.value.trim());
      const fragment = document.createDocumentFragment();
      filtered.forEach((r, index) => {
        const format = type(r), content = h('div', {class:'clip-content'});
        if (r.kind === 'image') {
          content.append(h('img', {src:r.dataUrl || 'data:image/png;base64,' + (r.thumbnail || r.value), alt:r.title || '剪贴板图片', loading:'lazy'}));
          content.append(h('span', {class:'clip-list-image-title'}, r.title || '剪贴板图片'));
        } else {
          const body = r.kind === 'files' ? (r.files || []).map(x => x.split(/[\\/]/).pop()).join('\n') : r.text || r.value || r.title || '';
          const excerpt = markFirst(body.slice(0, 1800), pattern);
          if (format === 'JSON') content.append(h('pre', {}, excerpt));
          else content.append(...excerpt);
        }
        const card=h('article',{draggable:true,onpointerdown:()=>{if(r.truncated&&!dragContent.has(id(r)))api.clipboardAction('read',{ids:[id(r)]}).then(full=>dragContent.set(id(r),Array.isArray(full)?full[0]:full)).catch(()=>{});},ondragstart:e=>{if(['files','image'].includes(r.kind)){e.preventDefault();api.clipboardAction('drag',{ids:selected.has(id(r))?[...selected]:[id(r)]}).catch(error=>notify(error.message,true));return;}const data=dragContent.get(id(r))||r;if(data.truncated){e.preventDefault();notify('正在读取全文，请稍后重新拖动');return;}e.dataTransfer.setData('text/plain',data.text||data.value||'');if(data.html)e.dataTransfer.setData('text/html',data.html);e.dataTransfer.effectAllowed='copy';},class:'clip-card'+(selected.has(id(r))?' selected':''),tabIndex:index === current ? 0 : -1,'data-index':index,role:'option','aria-selected':String(selected.has(id(r))),onclick:e=>{if(e.shiftKey){const low=Math.min(current,index),high=Math.max(current,index);for(let n=low;n<=high;n++)selected.add(id(filtered[n]));}else if(e.ctrlKey||e.metaKey){if(selected.has(id(r)))selected.delete(id(r));else selected.add(id(r));}else selected=new Set([id(r)]);current=index;syncSelection(true);},ondblclick:e=>{if(!e.target.closest('button'))paste();},oncontextmenu:e=>{e.preventDefault();if(!selected.has(id(r)))selected=new Set([id(r)]);current=index;syncSelection(true);cardMenu(e);}},content);
        if((r.text||r.value||'').length>110&&r.kind!=='image')card.append(button('查看全文 ↗',e=>{e.stopPropagation();current=index;selected=new Set([id(r)]);syncSelection(true);preview();},'clip-preview-link'));
        const source=r.icon?h('img',{src:r.icon,class:'clip-source',alt:r.sourceName||''}):h('span',{class:'clip-source',title:r.sourceName||r.source||''},icon(r.kind==='files'?'file':'application',16));card.append(h('div',{class:'clip-type-bar','data-format':r.kind==='files'?'文件':format},h('strong',{},format),h('time',{},UI.relativeTime(r.time||r.date)),h('span',{class:'clip-origin',title:r.sourceName||r.source||''},source,h('span',{class:'clip-origin-name'},r.sourceName||r.source||''))));fragment.append(card);});
      const empty = hasFilter() ? '没有匹配的记录' : activeBoard === '历史' ? '复制内容后会出现在这里' : '这个标签还没有记录';
      track.replaceChildren(filtered.length ? fragment : h('div', {class:'empty'}, empty));
      finishSelection(focus || hadCardFocus);
    }
    async function refresh(){all=await api.history();if(!disposed)paint();}
    async function action(name,payload={}){const result=await api.clipboardAction(name,{ids:[...selected],...payload});if(result?.ok===false)throw Error(result.error||'操作失败');if(['delete','favorite','tag','copy','clear'].includes(name))await refresh();return result;}
    async function paste(){if(!selected.size)return;await action('paste');}
    async function preview(){if(!selected.size)return;await action('preview');}
    async function remove(){if(!selected.size)return;await action('delete');paint(true);}
    async function deleteCard(item) {
      if (item.favorite || item.pinned || item.tags?.length) { notify('固定卡片不能直接删除，请先取消固定'); return; }
      await action('delete', {ids:[id(item)]});
    }
    function cardMenu(anchor){const r=filtered[current];if(!r)return;const text=r.text||r.value||'';const rows=[{label:'对内容操作…',action:()=>api.clipboardAction('selection',{ids:[id(r)]})},null,{label:'粘贴',action:paste},{label:'粘贴为纯文本',action:()=>action('paste',{plain:true})},{label:'复制',action:()=>action('copy')},{label:'预览全文',action:preview},null,{label:r.favorite?'取消收藏':'收藏',action:()=>action('favorite')},{label:'添加到标签',action:()=>menu((settings.clipboardPreferences?.pinboards||['收藏']).map(tag=>({label:tag,action:()=>action('tag',{tag})})),anchor)},{label:'两条卡片对比',disabled:selected.size!==2,action:()=>action('compare')},{label:'合并为新文本卡片',disabled:selected.size<2||filtered.filter(x=>selected.has(id(x))).some(x=>['image','files'].includes(x.kind)),action:async()=>{await action('merge');await refresh();}},{label:'编辑后粘贴…',disabled:['image','files'].includes(r.kind),action:async()=>{const full=await api.clipboardAction('read',{ids:[id(r)]}),record=Array.isArray(full)?full[0]:full;const editor=h('textarea',{value:record.text||record.value,'aria-label':'编辑后粘贴'});const d=UI.dialog('编辑本次粘贴内容',editor,[button('取消',()=>d.close()),button('粘贴',async()=>{await api.clipboardAction('editPaste',{ids:[id(r)],text:editor.value});d.close();},'primary')]);d.classList.add('clip-edit-dialog');editor.focus();}},{label:'加入复制堆栈',action:()=>api.stack('add',{ids:[...selected]})},null,...[['json','JSON 工具'],['comparison','文本对比'],['markdown','Markdown'],['translate','翻译'],['snippets','保存为常用片段']].map(([tool,label])=>({label,disabled:r.kind==='image'&&tool!=='translate',action:async()=>{if(tool==='snippets'){await api.clipboardAction('snippet',{ids:[id(r)]});notify('已保存常用片段');}else await api.clipboardAction('openTool',{ids:[id(r)],page:tool});}}))];
      if(r.kind==='image')rows.push({label:'识别图片文字',action:async()=>{const v=await api.clipboardAction('ocr',{ids:[id(r)]});notify(v.text?'文字识别完成':'未识别到文字');await refresh();}},{label:'图片处理',action:async()=>{const full=await api.clipboardAction('read',{ids:[id(r)]}),record=Array.isArray(full)?full[0]:full;await openTool('image',{dataUrl:record.dataUrl||'data:image/png;base64,'+record.value});}});
      if(r.kind==='link'||/^https?:\/\/\S+$/.test(text))rows.push({label:'打开链接',action:()=>api.open({type:'url',value:text.trim()})});
      if(r.kind==='files')rows.push({label:'指定应用打开…',action:()=>api.fileAction('openWith',{path:r.files?.[0]})},{label:'在文件夹中显示',action:()=>api.fileAction('reveal',{path:r.files?.[0]})});rows.push(null,{label:'删除未固定记录',danger:true,disabled:[...selected].every(key=>all.find(x=>id(x)===key)?.favorite),action:remove});menu(rows,anchor);
    }
    search.addEventListener('input',()=>{current=0;selected.clear();paint();});search.addEventListener('keydown',e=>{if(!e.isComposing&&e.key==='ArrowDown'&&filtered.length){e.preventDefault();track.children[current]?.focus();}});select.addEventListener('change',()=>{filter=select.value;current=0;selected.clear();paint();});
    const keydown=e=>{if(e.defaultPrevented||e.isComposing||!e.target.matches?.('.clip-card')||document.querySelector('dialog[open],.context-menu'))return;
      const item = filtered[Number(e.target.dataset.index)];
      if (!item) return;
      const step = {ArrowLeft:-1, ArrowRight:1, ...(layout === 'list' ? {ArrowUp:-1, ArrowDown:1} : {})}[e.key];
      if (step) {e.preventDefault();current=Math.max(0,Math.min(filtered.length-1,current+step));if(!e.shiftKey)selected.clear();if(filtered[current])selected.add(id(filtered[current]));syncSelection(true);track.children[current]?.scrollIntoView({inline:'nearest',block:'nearest'});}
      if(e.key==='Backspace'||e.key==='Delete'){e.preventDefault();if(!e.ctrlKey&&!e.metaKey&&!e.shiftKey&&!e.altKey&&!e.repeat)deleteCard(item).catch(error=>notify(error.message,true));}if(e.key==='Enter'){e.preventDefault();paste();}if(e.key===' '){e.preventDefault();preview();}if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='a'){e.preventDefault();selected=new Set(filtered.map(id));syncSelection(true);}if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='c'){e.preventDefault();action('copy');}
    };
    window.addEventListener('keydown',keydown);const off=api.onClipboard(items=>{all=Array.isArray(items)?items:items?.items||all;if(!disposed)paint();});
    showLayout(layout);boards();paint();
    return {focus:()=>search.focus(),dispose(){disposed=true;window.removeEventListener('keydown',keydown);off?.();},getItems:()=>filtered,getSelected:()=>[...selected],select(ids){selected=new Set(ids);paint();},settingsChanged(prefs){
      const next = (prefs || settings).clipboardPreferences?.shelfLayout === 'list' ? 'list' : 'cards';
      if (!pendingLayout && layout !== next) showLayout(next);
      boards();paint();
    },refresh,paste:text=>{search.value+=text;paint();}};
  };
  window.OpenAllPages.clipboardPreview = async (host, ctx) => {
    const record = ctx.initialValue && typeof ctx.initialValue === 'object' ? ctx.initialValue : {text:ctx.initialValue};
    const image = record.kind === 'image', files = record.kind === 'files' ? record.files || [] : null;
    const text = files ? files.join('\n') : image ? '' : record.text || record.value || '';
    const format = record.type || (image ? '图片' : files ? '文件' : record.kind === 'link' ? '链接' : '文本');
    const title = h('h1', {}, ['Markdown','HTML'].includes(format) ? format + ' 原文' : format + '预览');
    const copiedAt = new Date(record.time ?? record.date ?? NaN);
    const timestamp = Number.isNaN(copiedAt.getTime()) ? '' : copiedAt.toLocaleString(undefined, {dateStyle:'short', timeStyle:'short'});
    const provenance = [record.sourceName, timestamp].filter(Boolean).join(' · ');
    const source = h('span', {class:'clip-preview-source', title:provenance}, provenance);
    const content = h('div', {class:'preview-content', tabIndex:0, 'aria-label':'卡片内容'});
    const status = h('span', {class:'clip-preview-status', role:'status'}, 'Esc 关闭预览');
    const tools = h('div', {class:'clip-preview-tools'});
    const warn = error => { status.textContent = error.message || '操作失败，请重试'; };
    let copy;
    if (image) {
      const dataUrl = record.dataUrl || ('data:image/png;base64,' + record.value);
      const img = h('img', {src:dataUrl, alt:'剪贴板图片'});
      img.onerror = () => { content.textContent = '无法载入这张图片'; };
      content.classList.add('is-image'); content.append(img);
      copy = () => api.fileAction('copyImage', {dataUrl});
      tools.append(button('图片处理', () => openTool('image', {dataUrl})));
    } else {
      if (files) {
        content.classList.add('is-files');
        for (const file of files) {
          const name = String(file);
          const link = button(name, () => api.fileAction('reveal', {path:name}).catch(warn));
          link.title = '在资源管理器中显示 ' + name;
          content.append(link);
        }
      } else {
        content.textContent = text;
        if (['JSON', 'HTML'].includes(format)) content.classList.add('is-code');
      }
      copy = () => api.copyText(text);
      const openIn = button('用工具打开 ▾', () => menu(['json','comparison','markdown','translate'].map(id =>
        ({label:titles[id], action:()=>openTool(id, text)})), openIn));
      openIn.setAttribute('aria-haspopup','menu');
      tools.append(openIn);
    }
    const copyButton = button(image ? '复制图片' : files ? '复制路径' : '复制全文', async () => {
      try { await copy(); status.textContent = '已复制'; } catch (error) { warn(error); }
    });
    const pasteButton = button('粘贴此项', async () => {
      pasteButton.disabled = true;
      try {
        if (await api.clipboardAction('pastePreview')) await call('close');
        else status.textContent = '未能粘贴到目标窗口';
      } catch (error) { warn(error); }
      finally { pasteButton.disabled = false; }
    }, 'primary');
    host.append(h('section', {class:'preview-page clip-preview'},
      h('header', {class:'clip-preview-heading'}, title, source), content,
      h('footer', {class:'clip-preview-footer'}, status, h('div', {class:'clip-preview-action'}, tools, copyButton, pasteButton))));
    let desiredContent = 325;
    if (!image) {
      content.style.flex = 'none';
      content.style.height = 'auto';
      desiredContent = Math.min(500, Math.max(49, content.offsetHeight));
      content.style.removeProperty('height');
      content.style.removeProperty('flex');
    }
    const chromeHeight = innerHeight - content.offsetHeight;
    await call('fitClipboardPreview', {height:chromeHeight + desiredContent});
    return {focus:() => content.focus()};
  };
  (async()=>{if(!api)throw Error('应用桥接未加载');settings=await api.settings();applyTheme(settings);const initial=await call('context').catch(()=>null);const params=new URLSearchParams(location.search);await render(initial?.page||params.get('page')||'search',initial?.initialValue||'');window.OpenAllApp.ready=true;})();
})();
