(() => {
  'use strict';
  const pages = window.OpenAllPages ||= {};
  const loaded = new Map();
  const asset = name => new URL('../assets/' + name, document.baseURI).href;
  function load(name) {
    if (name === 'editor-json.js' && window.OpenAllJSONEditor) return Promise.resolve();
    if (!loaded.has(name)) loaded.set(name, new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = asset(name); script.onload = resolve; script.onerror = () => reject(Error('编辑器资源载入失败')); document.head.append(script);
    }));
    return loaded.get(name);
  }
  function task(action, text, extra = {}) {
    const worker = new Worker(asset('editor-worker.js'));
    let ended = false, timer, rejectTask;
    const promise = new Promise((resolve, reject) => {
      rejectTask = reject;
      timer = setTimeout(() => finish(Error('处理超时，已保留原文')), 20000);
      worker.onmessage = ({ data }) => data.error ? finish(Object.assign(Error(data.error), { offset: data.offset })) : finish(null, data.result);
      worker.onerror = event => finish(Error(event.message || '后台处理失败，已保留原文'));
      worker.postMessage({ id: 1, action, text, ...extra });
      function finish(error, result) { if (ended) return; ended = true; clearTimeout(timer); worker.terminate(); error ? reject(error) : resolve(result); }
    });
    return { promise, cancel() { if (ended) return; ended = true; clearTimeout(timer); worker.terminate(); rejectTask(Object.assign(Error('已取消过期处理'), { cancelled: true })); } };
  }
  async function waitUntil(check, milliseconds = 25000) { const start = performance.now(); while (!check()) { if (performance.now() - start > milliseconds) throw Error('编辑器等待超时'); await new Promise(resolve => setTimeout(resolve, 20)); } }

  pages.json = async (root, ctx) => {
    await load('editor-json.js');
    const { h, button, api, notify } = ctx;
    const host = h('section', { class: 'editor-page editor-json-page' }); root.append(host);
    const toolbar = h('div', { class: 'editor-toolbar' }), actions = h('div', { class: 'editor-action-group', role: 'group', 'aria-label': '格式操作' }), views = h('div', { class: 'editor-action-group editor-view-group', role: 'group', 'aria-label': '文档操作' });
    const formatButton = button('格式化', () => format('format'), 'primary');
    formatButton.append(h('kbd', { 'aria-hidden': 'true' }, 'Ctrl+↵'));
    formatButton.setAttribute('aria-keyshortcuts', 'Control+Enter');
    formatButton.title = '格式化（Ctrl+Enter）';
    formatButton.dataset.action = 'format';
    const compact = button('压缩', () => format('compact')); compact.dataset.action = 'compact';
    const more = h('select', { 'aria-label': '更多操作', class: 'editor-more' });
    for (const [value, title] of [['', '更多操作'], ['sort', '自然排序'], ['escape', '添加转义'], ['unescape', '去除转义'], ['validate', '校验']]) more.append(h('option', { value }, title));
    more.onchange = () => { const mode = more.value; more.value = ''; if (mode === 'fold') foldButton.click(); else if (mode === 'copy') copyButton.click(); else if (mode) format(mode); };
    const foldButton = button('全部折叠', () => { editor.folded ? editor.unfoldAll() : editor.foldAll(); updateFold(); }); foldButton.dataset.action = 'fold';
    const copyButton = button('复制全文', async () => { await api.copyText(editor.value); status.textContent = '已复制全文'; }); copyButton.dataset.action = 'copy';
    const searchButton = button('搜索', () => showSearch(), 'editor-search-button');
    searchButton.append(h('kbd', { 'aria-hidden': 'true' }, 'Ctrl+F'));
    searchButton.setAttribute('aria-keyshortcuts', 'Control+F');
    searchButton.title = '搜索内容（Ctrl+F）';
    actions.append(formatButton, compact, more); views.append(foldButton, copyButton); toolbar.append(actions, views, searchButton);
    const searchBar = h('div', { class: 'editor-findbar', id: 'json-search', hidden: true, role: 'search' });
    searchButton.setAttribute('aria-controls', searchBar.id);
    searchButton.setAttribute('aria-expanded', 'false');
    const query = h('input', { type: 'search', placeholder: '搜索内容', 'aria-label': '搜索 JSON 内容', spellcheck: false });
    const searchCount = h('span', { class: 'editor-find-count', role: 'status' }, '');
    const caseBox = h('input', {type:'checkbox','aria-label':'区分大小写'}), caseLabel = h('label', {title:'区分大小写'}, caseBox, 'Aa');
    const previous = button('↑', () => moveSearch(-1)), next = button('↓', () => moveSearch(1)), close = button('×', () => hideSearch());
    previous.setAttribute('aria-label', '上一个搜索结果'); next.setAttribute('aria-label', '下一个搜索结果'); close.setAttribute('aria-label', '关闭搜索');
    const findNav = h('div', { class: 'editor-find-nav', role: 'group', 'aria-label': '匹配导航' }, previous, next);
    close.classList.add('editor-find-close');
    searchBar.append(query, searchCount, caseLabel, findNav, close);
    const container = h('div', { class: 'editor-codemirror', 'data-editor': 'json' });
    const status = h('span', { role: 'status' }, '就绪'), count = h('span', { class: 'editor-document-count' }, '0 行');
    const footer = h('footer', { class: 'editor-footer' }, status, count); toolbar.append(searchBar); host.append(toolbar, container, footer);
    let editor, revision = 0, disposed = false, metadataJob, operationJob, searchJob, metadataTimer, searchTimer;
    let valid = false, regions = [], matches = [], activeMatch = -1, limited = false, busy = false;
    let pendingMetadata = false, queryComposing = false;
    function notice(message, error = false) { status.textContent = message; status.classList.toggle('error', error); }
    const overflowFold = h('option',{value:'fold'},'全部折叠');
    const overflowCopy = h('option',{value:'copy'},'复制全文');
    const narrowFind = window.matchMedia('(max-width:850px)');
    function placeDocumentActions() {
      const overflow = narrowFind.matches && !searchBar.hidden;
      views.hidden = overflow;
      if (overflow) more.append(overflowFold,overflowCopy);
      else { overflowFold.remove(); overflowCopy.remove(); }
      overflowFold.textContent = foldButton.textContent;
      overflowFold.disabled = foldButton.disabled;
      overflowCopy.disabled = copyButton.disabled;
    }
    narrowFind.addEventListener('change',placeDocumentActions);
    function updateFold() {
      const folds = editor.foldCount;
      foldButton.textContent = folds ? '全部展开' : '全部折叠';
      foldButton.disabled = !valid || !regions.length;
      overflowFold.textContent = foldButton.textContent; overflowFold.disabled=foldButton.disabled; overflowCopy.disabled=copyButton.disabled;
      count.textContent = editor.lineCount + ' 行' + (folds ? ' · 折叠 ' + folds + ' 处' : '');
    }
    function changed() {
      revision++; valid = false; regions = []; matches = []; activeMatch = -1;
      copyButton.disabled = !editor.length;
      notice(editor.length ? '已编辑' : '就绪'); updateFold();
      clearTimeout(metadataTimer); metadataJob?.cancel(); pendingMetadata = !!editor.length;
      if (!searchBar.hidden) {
        if (query.value && editor.length) scheduleSearch();
        else showCount();
      }
      if (!editor.length) { editor.setRegions([]); pendingMetadata = false; return; }
      metadataTimer = setTimeout(metadata, editor.length > 200000 ? 240 : 120);
    }
    editor = window.OpenAllJSONEditor.create({ parent: container, onChange: changed,
      onNotice: message => notice(message), onFind: showSearch, onFindNext: moveSearch, onFormat: () => format('format'),
      onFold: () => queueMicrotask(updateFold), onViewport: () => queueMicrotask(paintSearch),
      onDrop: async file => { if (file.size > 20000000) return notice('文件超过 20 MB，已保留原文', true); editor.setText(await file.text()); }
    });
    async function metadata() {
      const version = revision;
      metadataJob = task('metadata', editor.value);
      try {
        const result = await metadataJob.promise;
        if (disposed || version !== revision) return;
        valid = true; regions = result.regions; editor.setRegions(regions); updateFold();
      } catch (error) { if (error.cancelled || disposed || version !== revision) return; valid = false; regions = []; editor.unfoldAll(); editor.setRegions([]); updateFold(); notice(error.message, true); }
      finally { if (version === revision) pendingMetadata = false; }
    }
    async function format(mode = 'format') {
      if (!editor.length) { notice('请先输入内容'); return false; }
      operationJob?.cancel(); const version = revision;
      busy = true; formatButton.disabled = compact.disabled = true; notice('正在后台处理…');
      const current = operationJob = task(mode, editor.value);
      try {
        const result = await current.promise;
        if (disposed) return false;
        if (version !== revision) { notice('内容已修改，未覆盖新的编辑'); return false; }
        if (mode !== 'validate') editor.setText(result.text, true);
        notice(({ format: '格式化完成', compact: '压缩完成', sort: '已按键名自然排序', escape: '已转换为带引号的 JSON 字符串', unescape: '已去除 JSON 字符串转义', validate: 'JSON 校验通过' })[mode]);
        return true;
      } catch (error) { if (!error.cancelled && !disposed) notice(error.message, true); return false; }
      finally { if (operationJob === current) { busy = false; formatButton.disabled = compact.disabled = false; } }
    }
    function paintSearch() { if (!disposed && editor) editor.setSearch(searchBar.hidden ? [] : matches, activeMatch); }
    function setSearchVisible(visible) {
      searchBar.hidden = !visible;
      searchButton.hidden = visible;
      placeDocumentActions();
      searchButton.setAttribute('aria-expanded', String(visible));
    }
    function showSearch() { setSearchVisible(true); if (!query.value && editor.selectedText.length < 256) query.value = editor.selectedText; query.focus(); query.select(); if (query.value) refreshSearch(true); else showCount(); }
    function hideSearch() { setSearchVisible(false); clearTimeout(searchTimer); searchJob?.cancel(); editor.setSearch([]); editor.focus(); }
    function scheduleSearch() { clearTimeout(searchTimer); if (!queryComposing) searchTimer = setTimeout(() => refreshSearch(false), editor.length > 200000 ? 200 : 90); }
    function showCount() { searchCount.textContent = !query.value ? '' : !matches.length ? '无匹配结果' : `${activeMatch + 1} / ${matches.length}${limited ? '+' : ''}`; previous.disabled = next.disabled = !matches.length; }
    async function refreshSearch(reveal = true) {
      searchJob?.cancel(); const version = revision, needle = query.value;
      if (!needle) { matches = []; activeMatch = -1; showCount(); paintSearch(); return; }
      const current = searchJob = task('search', editor.value, { query: needle, caseSensitive: caseBox.checked });
      try { const result = await current.promise; if (disposed || revision !== version || query.value !== needle) return; matches = result.matches; limited = result.limited; activeMatch = matches.length ? 0 : -1; showCount(); if (reveal && matches.length) editor.reveal(matches[0].from, matches[0].to); paintSearch(); }
      catch (error) { if (!error.cancelled && !disposed) notice(error.message, true); }
    }
    function moveSearch(direction) { if (!matches.length) { showSearch(); return; } activeMatch = (activeMatch + direction + matches.length) % matches.length; const match = matches[activeMatch]; editor.reveal(match.from, match.to); showCount(); paintSearch(); }
    query.oninput = scheduleSearch; caseBox.onchange = () => refreshSearch(true);
    query.oncompositionstart = () => { queryComposing = true; clearTimeout(searchTimer); searchJob?.cancel(); };
    query.oncompositionend = () => { queryComposing = false; refreshSearch(false); };
    query.onkeydown = event => { if (event.isComposing || queryComposing) return; if (event.key === 'Enter') { event.preventDefault(); moveSearch(event.shiftKey ? -1 : 1); } if (event.key === 'Escape') { event.preventDefault(); hideSearch(); } };
    host.addEventListener('keydown', event => {
      if (event.isComposing || queryComposing) return;
      const command = (event.ctrlKey || event.metaKey) && !event.altKey;
      if (command && event.key.toLowerCase() === 'f') { event.preventDefault(); event.stopPropagation(); showSearch(); }
      else if (!searchBar.hidden && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); hideSearch(); }
      else if (!searchBar.hidden && (event.key === 'F3' || command && event.key.toLowerCase() === 'g')) { event.preventDefault(); event.stopPropagation(); moveSearch(event.shiftKey ? -1 : 1); }
    }, true);
    function paste(text) {
      if (document.activeElement === query) { query.setRangeText(text, query.selectionStart, query.selectionEnd, 'end'); scheduleSearch(); }
      else editor.paste(text);
    }
    editor.setText(typeof ctx.initialValue === 'string' ? ctx.initialValue : ctx.initialValue?.text || '');
    if (['format', 'compact'].includes(ctx.initialValue?.action)) await format(ctx.initialValue.action);
    copyButton.disabled = !editor.length; updateFold(); editor.focus();
    return {
      editor, getText: () => editor.value, getSelection: () => document.activeElement === query ? query.value.slice(query.selectionStart, query.selectionEnd) : editor.selectedText, setText: text => editor.setText(text), format, paste, focus: () => editor.focus(),
      foldAll: () => { editor.foldAll(); updateFold(); }, unfoldAll: () => { editor.unfoldAll(); updateFold(); }, foldLine: line => editor.foldLine(line),
      undo: () => editor.undo(), redo: () => editor.redo(),
      search: async (text, sensitive = false) => { setSearchVisible(true); query.value = text; caseBox.checked = sensitive; await refreshSearch(true); return matches.length; },
      getState: () => ({ revision, valid, regions: regions.length, folded: editor.folded, matches: matches.length, limited, busy, pendingMetadata, renderedLines: container.querySelectorAll('.cm-line').length }),
      waitIdle: () => waitUntil(() => !pendingMetadata && !busy),
      dispose() { disposed = true; narrowFind.removeEventListener('change',placeDocumentActions); clearTimeout(metadataTimer); clearTimeout(searchTimer); metadataJob?.cancel(); operationJob?.cancel(); searchJob?.cancel(); editor.destroy(); host.remove(); }
    };
  };

  pages.comparison = async (root, ctx) => {
    const frame = ctx.h('iframe', { class: 'editor-comparison-frame', title: '文本对比，左右可直接编辑', src: asset('editor-diff.html') }); root.append(frame);
    let disposed = false;
    const send = data => frame.contentWindow?.postMessage({ openallComparison: true, ...data }, '*');
    function applyTheme(event) {
      if (disposed) return;
      const styles = getComputedStyle(root), vars = {};
      for (const name of ['canvas', 'editor', 'raised', 'ink', 'muted', 'secondary', 'comparison-rule', 'accent-text']) vars['--' + name] = styles.getPropertyValue('--' + name).trim();
      // 主题事件已完成整套变量更新；首次载入直接读取同一份根主题，不能混用旧 body 状态。
      const light = typeof event?.detail?.light === 'boolean' ? event.detail.light : document.documentElement.dataset.theme === 'light';
      send({ action: 'theme', theme: window.OpenAllTheme.comparison(vars, light) });
    }
    const ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('文本对比载入超时')), 15000);
      function onMessage(event) {
        if (event.source !== frame.contentWindow || !event.data?.openallComparison || disposed) return;
        const message = event.data;
        if (message.action === 'ready') { try { const initial = ctx.initialValue; send({ action: 'setTexts', left: typeof initial === 'string' ? initial : initial?.left || '', right: initial?.right || '' }); applyTheme(); resolve(); } catch (error) { reject(error); } finally { clearTimeout(timeout); } }
        else if (message.action === 'copy') Promise.resolve(ctx.api.copyText(String(message.text))).then(() => send({ action: 'copied', side: message.side })).catch(error => ctx.notify(error.message));
      }
      window.addEventListener('message', onMessage);
      frame._cleanup = () => { clearTimeout(timeout); window.removeEventListener('message', onMessage); };
    });
    const observer = new MutationObserver(applyTheme); observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-theme'] });
    window.addEventListener('openall-theme', applyTheme);
    await ready;
    const controller = () => frame.contentWindow.compareV2;
    return { frame, ready, getTexts: () => controller().texts(), getSelection: () => controller().selectionText(), getState: () => controller().state(),
      setTexts: (left, right) => frame.contentWindow.setTexts(left, right), paste: text => send({ action: 'paste', text }), focus: side => send({ action: 'focus', side }),
      getEditors: () => controller().editors(),
      search: (text, scope = 'both', sensitive = false) => controller().search(text, scope, sensitive),
      waitIdle: () => waitUntil(() => !controller().state().pending),
      verify: () => controller().verify(), verifyPerformance: () => controller().verifyPerformance(),
      dispose() { disposed = true; observer.disconnect(); window.removeEventListener('openall-theme', applyTheme); frame._cleanup?.(); frame.remove(); }
    };
  };
  async function textFormatter(root, ctx, mode) {
    await load('editor-json.js');
    const { h, button, api } = ctx, host = h('section', { class: 'editor-page editor-formatter' }); root.append(host);
    const grid = h('div', { class: 'editor-formatter-panes' });
    const inputPane = h('section', { class: 'editor-formatter-pane' }), outputPane = h('section', { class: 'editor-formatter-pane output' });
    const inputBox = h('div', { class: 'editor-codemirror' }), outputBox = h('div', { class: 'editor-codemirror' });
    const inputCount = h('span', { class: 'formatter-count' }, '0 行');
    const outputCount = h('span', { class: 'formatter-count' });
    const status = h('span', { class: 'editor-formatter-status', role: 'status' });
    const action = button('格式化', () => run(), 'primary');
    action.append(h('kbd', { 'aria-hidden': 'true' }, 'Ctrl+↵'));
    action.setAttribute('aria-keyshortcuts', 'Control+Enter');
    const copy = button('复制结果', async () => { await api.copyText(output.value); status.textContent = '已复制结果'; });
    const expand = button('展开结果', () => {
      const expanded = host.classList.toggle('expanded-result');
      expand.textContent = expanded ? '并排查看' : '展开结果';
      expand.setAttribute('aria-pressed',String(expanded));
      (expanded ? output : input).focus();
    });
    expand.setAttribute('aria-pressed','false');
    copy.disabled = true;
    inputPane.append(h('div', { class: 'editor-pane-heading' }, '原文', inputCount, action), inputBox);
    outputPane.append(h('div', { class: 'editor-pane-heading' }, '结果', outputCount, copy, expand), outputBox);
    grid.append(inputPane, outputPane);
    host.append(grid, h('footer', { class: 'editor-formatter-footer' }, status));
    let input, output, work, disposed = false, revision = 0, busy = false;
    function sourceChanged() {
      revision++;
      if (!input) return;
      inputCount.textContent = (input.length ? input.lineCount : 0) + ' 行';
      if (output?.length) outputCount.textContent = '等待重新处理';
      copy.disabled = true;
      status.classList.remove('error');
      status.textContent = '';
    }
    input = window.OpenAllJSONEditor.create({ parent: inputBox, syntax: mode === 'sqlFormat' ? 'sql' : 'config', placeholder: mode === 'sqlFormat' ? '粘贴 SQL 语句' : '粘贴 YAML 或 Properties 内容', label: '格式化输入', onChange: sourceChanged, onFormat: () => run(), onNotice: text => status.textContent = text });
    output = window.OpenAllJSONEditor.create({ parent: outputBox, syntax: mode === 'sqlFormat' ? 'sql' : 'config', placeholder: '格式化结果显示在这里', label: '格式化结果', readOnly: true });
    async function run() {
      work?.cancel(); const version = revision, current = work = task(mode, input.value); busy = true; action.disabled = copy.disabled = true; status.textContent = '正在后台整理…';
      try { const result = await current.promise; if (disposed || version !== revision) return false; output.setText(result.text, true); copy.disabled = !output.length; const kind = result.kind?.split(' · ')[0] || 'SQL'; outputCount.textContent = kind+' · '+output.lineCount+' 行 · '+(result.changedLines ? '调整 '+result.changedLines+' 行' : '无改动'); status.textContent = ''; status.classList.remove('error'); return true; }
      catch (error) { if (!error.cancelled && !disposed && version === revision) { status.textContent = error.message; status.classList.add('error'); } return false; }
      finally { if (work === current) { busy = false; action.disabled = false; } }
    }
    input.setText(typeof ctx.initialValue === 'string' ? ctx.initialValue : ''); input.focus();
    return { getText: () => input.value, getResult: () => output.value, getSelection: () => (output.hasFocus ? output : input).selectedText, setText: text => input.setText(text), format: run, paste: text => input.paste(text), focus: () => input.focus(), waitIdle: () => waitUntil(() => !busy), dispose() { disposed = true; work?.cancel(); input.destroy(); output.destroy(); host.remove(); } };
  }
  pages.configFormat = (root, ctx) => textFormatter(root, ctx, 'configFormat');
  pages.sqlFormat = (root, ctx) => textFormatter(root, ctx, 'sqlFormat');
})();
