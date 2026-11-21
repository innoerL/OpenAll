(() => {
  'use strict';
  const inputs = [];
  const footerStatus = document.getElementById('footer-status');
  const counts = [document.getElementById('left-count'), document.getElementById('right-count')];
  const summary = document.getElementById('summary');
  const previous = document.getElementById('previous');
  const next = document.getElementById('next');
  const navigationCount = document.getElementById('navigation-count');
  const syncScroll = document.getElementById('sync-scroll');
  const ignoreSpace = document.getElementById('ignore-space');
  const findBar = document.getElementById('findbar');
  const findQuery = document.getElementById('find-query');
  const findCount = document.getElementById('find-count');
  const findScope = document.getElementById('find-scope');
  const findCase = document.getElementById('find-case');
  const searchButton = document.getElementById('open-search');
  const findPrevious = document.getElementById('find-previous');
  const findNext = document.getElementById('find-next');
  const sortButtons = [...document.querySelectorAll('.natural-sort')];
  let findMatches = [[], []], findResults = [], findIndex = -1;
  let findLimited = false, findComposing = false, findTimer = null;
  const lineHeight = 22;
  const padding = 12;
  const composing = new Set();
  const programmaticScroll = [null, null];
  let timer = null;
  let painting = false;
  let pending = false;
  let activeSide = 0;
  let current = -1;
  let generation = 0;
  let lineCounts = [0, 0];
  let marks = [[], []];
  let rowByLine = [[], []];
  let anchors = [[], []];
  let spacers = [[], []];
  let rows = [];
  let hunks = [];
  let totals = { added: 0, removed: 0, changed: 0 };
  let limited = false;
  let compareWorker = null, workerTimeout = null, jobVersion = 0;
  let lastWorkerMilliseconds = 0;
  const documentVersions = [0, 0], sortJobs = [null, null];
  let lastSortMilliseconds = 0;
  const characterCache = new Map();
  const graphemes = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

  function characterRuns(value, changed) {
    const pieces = graphemes ? Array.from(graphemes.segment(value), part => part.segment) : Array.from(value);
    const runs = [];
    let offset = 0;
    for (const piece of pieces) {
      const length = Array.from(piece).length;
      // 只扩展到完整字素，单字符、数字和标识符的其余部分不再被一起染色。
      const marked = changed.slice(offset, offset + length).some(Boolean);
      const previous = runs[runs.length - 1];
      if (previous && previous.marked === marked) previous.text += piece;
      else runs.push({ text: piece, marked });
      offset += length;
    }
    return runs;
  }

  function characterParts(rowIndex) {
    if (characterCache.has(rowIndex)) return characterCache.get(rowIndex);
    const row = rows[rowIndex];
    // 超长行保留行级标记，避免为不可见字符分配巨量差异数组。
    if (!row || row.type !== 'changed' || Math.max((row.left ?? inputs[0].lineText(row.leftLine) ?? '').length, (row.right ?? inputs[1].lineText(row.rightLine) ?? '').length) > 20000) return null;
    row.left ??= inputs[0].lineText(row.leftLine);
    row.right ??= inputs[1].lineText(row.rightLine);
    const compared = DiffCore.charMarks(ignoreSpace.checked ? row.left.trimEnd() : row.left,
                                       ignoreSpace.checked ? row.right.trimEnd() : row.right);
    const offsets = (characters, gaps) => { const values = [0]; for (const character of characters) values.push(values[values.length - 1] + character.length); return gaps.map(gap => values[gap]); };
    const parts = { parts: [characterRuns(row.left, compared.markedLeft), characterRuns(row.right, compared.markedRight)],
      gaps: [offsets(compared.left, compared.gapsLeft), offsets(compared.right, compared.gapsRight)] };
    characterCache.set(rowIndex, parts);
    // 缓存仅覆盖最近浏览的行，不随整份文档持续增长。
    if (characterCache.size > 200) characterCache.delete(characterCache.keys().next().value);
    return parts;
  }

  function currentLines(side) {
    if (current < 0 || !hunks[current]) return null;
    return hunks[current].ranges[side];
  }

  function paintSide(side) {
    const input = inputs[side];
    if (!input) return;
    // 编辑完成但差异尚未重算时，只让 CodeMirror 映射已有布局，不能套用旧行号。
    if (pending) { input.applyCharacters([]); return; }
    input.applyLayout(spacers[side], marks[side], currentLines(side), generation);
    const visible = [];
    if (!pending && !composing.size && !inputs.some(editor => editor.composing)) {
      for (const number of input.visibleLines()) {
        const index = number - 1;
        if (!(marks[side][index] || '').startsWith('changed')) continue;
        const parts = characterParts(rowByLine[side][index]);
        if (parts) visible.push({ number, parts: parts.parts[side], gaps: parts.gaps[side] });
      }
    }
    input.applyCharacters(visible);
  }

  function paint() {
    if (composing.size || inputs.some(editor => editor.composing)) return;
    paintSide(0); paintSide(1);
    paintSearch();
  }
  function schedulePaint() {
    if (painting) return;
    painting = true;
    requestAnimationFrame(() => { painting = false; paint(); });
  }

  function updateCounts() {
    lineCounts = inputs.map(input => input.lineCount);
    for (let side = 0; side < 2; side++) counts[side].textContent = lineCounts[side] + ' 行';
    updateSortControls();
  }

  function hasComposition() { return composing.size || inputs.some(input => input.composing); }
  function updateSortControls() {
    for (let side = 0; side < 2; side++) {
      const button = sortButtons[side]; if (!button) continue;
      button.disabled = !inputs[side]?.length || !!sortJobs[side] || !!hasComposition();
      button.textContent = sortJobs[side] ? '排序中…' : '自然排序';
    }
  }
  function cancelSort(side) {
    const job = sortJobs[side]; if (!job) return;
    sortJobs[side] = null; clearTimeout(job.timeout); job.worker?.terminate(); job.resolve(false); updateSortControls();
  }
  function applySorted(side, text, version) {
    if (version !== documentVersions[side] || hasComposition()) return false;
    const unchanged = inputs[side].value === text;
    if (!unchanged && !inputs[side].replaceDocument(text)) return false;
    compareNow();
    footerStatus.textContent = (side === 0 ? '左侧' : '右侧') + (unchanged ? '已是自然顺序' : '自然排序完成 · 可撤销');
    return true;
  }
  function naturalSort(side) {
    side = side === 1 ? 1 : 0;
    if (hasComposition()) { footerStatus.textContent = '输入完成后再排序'; return Promise.resolve(false); }
    if (!inputs[side].length) return Promise.resolve(false);
    cancelSort(side);
    const text = inputs[side].value, version = documentVersions[side];
    if (text.length <= 200000 && inputs[side].lineCount <= 8000) {
      return Promise.resolve(applySorted(side, DiffCore.naturalSortLines(text), version));
    }
    return new Promise(resolve => {
      const job = { resolve, worker: null, timeout: null }; sortJobs[side] = job; updateSortControls();
      footerStatus.textContent = (side === 0 ? '左侧' : '右侧') + '正在后台自然排序…';
      const url = URL.createObjectURL(new Blob([DiffCore.workerSource], { type: 'text/javascript' }));
      function finish(result, error) {
        if (sortJobs[side] !== job) return;
        sortJobs[side] = null; clearTimeout(job.timeout); job.worker?.terminate(); updateSortControls();
        if (error) { footerStatus.textContent = '排序未完成，正文已保留'; resolve(false); return; }
        lastSortMilliseconds = result.elapsed;
        resolve(applySorted(side, result.text, version));
      }
      try {
        job.worker = new Worker(url);
        job.worker.onmessage = event => finish(event.data, event.data.error);
        job.worker.onerror = () => finish(null, true);
        job.timeout = setTimeout(() => finish(null, true), 20000);
        job.worker.postMessage({ action: 'sort', text });
      } catch (_) { finish(null, true); }
      finally { URL.revokeObjectURL(url); }
    });
  }

  function renderSummary(notice = '') {
    const primary = document.createElement('span');
    const parts = [];
    const descriptions = [];
    primary.className = 'summary-primary' + (notice || !hunks.length ? ' notice' : '');
    if (!notice && hunks.length) {
      for (const [kind, label] of [['changed', '修改'], ['added', '新增'], ['removed', '删除']]) {
        if (!totals[kind]) continue;
        if (primary.childNodes.length) primary.appendChild(document.createTextNode(' · '));
        const statistic = document.createElement('span');
        statistic.className = kind;
        statistic.textContent = `${label} ${totals[kind]} 行`;
        primary.appendChild(statistic);
        descriptions.push(statistic.textContent);
      }
    } else {
      primary.textContent = notice || (inputs.some(input => input.length) ? '两侧文本一致' : '在左右两侧输入文本');
      descriptions.push(primary.textContent);
    }
    parts.push(primary);
    if (!notice) {
      const detail = document.createElement('span');
      detail.className = 'summary-details';
      function appendDetail(text, kind = '', description = text) {
        if (detail.childNodes.length) detail.appendChild(document.createTextNode(' · '));
        const span = document.createElement('span');
        span.className = kind;
        span.textContent = text;
        detail.appendChild(span);
        descriptions.push(description);
      }
      if (limited) appendDetail('按行对比', 'mode', '大文本按行位置对比');
      if (detail.childNodes.length) parts.push(detail);
      if (!inputs.some(input => input.length)) descriptions.push('差异会直接标出');
    }
    const description = descriptions.join('，');
    summary.replaceChildren(...parts);
    summary.title = description;
    summary.setAttribute('aria-label', description);
    navigationCount.textContent = `${current >= 0 ? current + 1 : hunks.length ? '—' : '0'} / ${hunks.length}`;
    const navigationDescription = current >= 0 ? `第 ${current + 1} 个差异组，共 ${hunks.length} 组` :
      hunks.length ? `尚未选择差异组，共 ${hunks.length} 组` : '没有差异组';
    navigationCount.title = navigationDescription;
    navigationCount.setAttribute('aria-label', navigationDescription);
  }

  // 只更新装饰与占位；CodeMirror 的正文、选区、撤销栈和输入法状态不参与重建。
  function compareNow() {
    if (composing.size || inputs.some(editor => editor.composing)) return false;
    clearTimeout(timer);
    timer = null;
    stopComparison();
    updateCounts();
    const texts = inputs.map(input => input.value);
    if (texts[0].length + texts[1].length > 200000 || Math.max(...lineCounts) > 8000) {
      pending = true;
      previous.disabled = next.disabled = true;
      footerStatus.textContent = '正在后台对比…';
      const version = jobVersion;
      const url = URL.createObjectURL(new Blob([DiffCore.workerSource], { type: 'text/javascript' }));
      try {
        compareWorker = new Worker(url);
        compareWorker.onmessage = event => {
          if (version !== jobVersion) return;
          stopComparison();
          if (event.data.error) { comparisonFailed(); return; }
          lastWorkerMilliseconds = event.data.elapsed;
          const { encoded, limited } = event.data, rows = [];
          const types = ['equal', 'changed', 'added', 'removed'];
          for (let i = 0; i < encoded.length; i += 3) rows.push({ type: types[encoded[i]], leftLine: encoded[i + 1] || null, rightLine: encoded[i + 2] || null });
          applyComparison({ rows, limited });
        };
        compareWorker.onerror = () => { if (version === jobVersion) { stopComparison(); comparisonFailed(); } };
        workerTimeout = setTimeout(() => { if (version === jobVersion) { stopComparison(); comparisonFailed(); } }, 15000);
        compareWorker.postMessage({ texts, ignore: ignoreSpace.checked });
      } catch (_) { stopComparison(); comparisonFailed(); }
      finally { URL.revokeObjectURL(url); }
      return true;
    }
    applyComparison(DiffCore.align(...texts, ignoreSpace.checked));
    return true;
  }

  function stopComparison() {
    jobVersion++;
    compareWorker?.terminate(); compareWorker = null;
    clearTimeout(workerTimeout); workerTimeout = null;
  }

  function comparisonFailed() {
    pending = false;
    rows = []; marks = [[], []]; rowByLine = [[], []]; spacers = [[], []]; hunks = []; current = -1;
    generation++;
    paint();
    renderSummary('对比未完成，正文已保留');
    footerStatus.textContent = '可继续编辑，或切换对比选项重试';
  }

  function applyComparison(result) {
    pending = false;
    rows = result.rows;
    characterCache.clear();
    limited = result.limited;
    marks = [[], []];
    rowByLine = [[], []];
    anchors = [[], []];
    totals = { added: 0, removed: 0, changed: 0 };
    hunks = [];
    current = -1;
    let hunk = null;
    const firstLines = [rows.find(row => row.leftLine !== null)?.leftLine || 1, rows.find(row => row.rightLine !== null)?.rightLine || 1];
    const lastLines = [...firstLines];
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      if (row.type !== 'equal') {
        totals[row.type]++;
        if (!hunk) { hunk = { start: index, end: index + 1, ranges: [null, null] }; hunks.push(hunk); }
        hunk.end = index + 1;
      } else { hunk = null; }
      for (let side = 0; side < 2; side++) {
        const number = side === 0 ? row.leftLine : row.rightLine;
        if (number !== null) {
          if (hunk) {
            if (!hunk.ranges[side]) hunk.ranges[side] = [number - 1, number - 1];
            else hunk.ranges[side][1] = number - 1;
          }
          rowByLine[side][number - 1] = index;
          lastLines[side] = number;
          marks[side][number - 1] = row.type === 'changed' ? (side === 0 ? 'changed-left' : 'changed-right') :
            row.type === 'removed' && side === 0 ? 'removed' : row.type === 'added' && side === 1 ? 'added' : '';
        }
        anchors[side][index] = lastLines[side] - 1;
      }
    }
    // 缺失行只生成块级占位；两侧文档及真实行号始终不变。
    spacers = [0, 1].map(side => {
      const values = [];
      let missing = 0;
      for (const row of rows) {
        const number = side === 0 ? row.leftLine : row.rightLine;
        if (number === null) { missing++; continue; }
        if (missing) values.push({ before: true, line: number, count: missing });
        missing = 0;
      }
      // CodeMirror 空文档自带一条可编辑空行，避免再多补一条显示行。
      if (!lineCounts[side]) missing = Math.max(0, missing - 1);
      if (missing) values.push({ before: false, line: Math.max(1, lineCounts[side]), count: missing });
      return values;
    });
    current = hunks.length ? 0 : -1;
    renderSummary();
    footerStatus.textContent = limited ? '已对齐 · 大文本按行位置比较' : '已对齐';
    previous.disabled = next.disabled = hunks.length === 0;
    generation++;
    paint();
    refreshSearch(false);
    return true;
  }

  function scheduleCompare() {
    stopComparison();
    clearTimeout(timer);
    pending = true;
    footerStatus.textContent = '编辑中';
    previous.disabled = next.disabled = true;
    updateCounts();
    schedulePaint();
    if (!composing.size) timer = setTimeout(compareNow, inputs.some(input => input.length > 200000) ? 400 : 130);
  }

  function setScroll(side, top) {
    const input = inputs[side];
    input.scrollTop = top;
    programmaticScroll[side] = input.scrollTop;
  }

  function handleScroll(side) {
    schedulePaint();
    const input = inputs[side];
    const skipped = programmaticScroll[side];
    programmaticScroll[side] = null;
    if (skipped !== null && Math.abs(skipped - input.scrollTop) < 1) return;
    if (!syncScroll.checked || pending || composing.size || !rows.length) return;
    setScroll(1 - side, input.scrollTop);
  }

  function navigate(step) {
    if (pending) { if (!compareWorker) compareNow(); if (pending) return; }
    if (!hunks.length || composing.size) return;
    current = current < 0 ? (step > 0 ? 0 : hunks.length - 1) : (current + step + hunks.length) % hunks.length;
    const row = hunks[current].start;
    const top = padding + row * lineHeight - inputs[activeSide].clientHeight / 3;
    for (let side = 0; side < 2; side++) setScroll(side, top);
    renderSummary();
    paint();
    inputs[activeSide].focus();
  }

  for (let side = 0; side < 2; side++) {
    inputs.push(window.OpenAllComparisonEditor.create({
      parent: document.getElementById(side === 0 ? 'left' : 'right'), side,
      onChange: () => { documentVersions[side]++; cancelSort(side); scheduleCompare(); },
      onReject: message => { renderSummary(message); footerStatus.textContent = message; },
      onViewport: schedulePaint,
      onFocus: () => { activeSide = side; },
      onScroll: () => handleScroll(side),
      onComposition: started => {
        if (started) { composing.add(side); cancelSort(0); cancelSort(1); clearTimeout(timer); footerStatus.textContent = '输入中'; }
        else { composing.delete(side); scheduleCompare(); }
        updateSortControls();
      },
      onDrop: async file => {
        if (file.size > 20 * 1024 * 1024) { renderSummary('文本文件请控制在 20 MB 以内'); return; }
        const value = await file.text();
        const input = inputs[side];
        input.focus();
        input.setSelectionRange(0, input.view.state.doc.length);
        input.replaceSelection(value);
      }
    }));
  }
  document.querySelectorAll('.copy').forEach(button => button.addEventListener('click', () => {
    const side = Number(button.dataset.side);
    window.webkit?.messageHandlers?.comparisonV2?.postMessage({ action: 'copy', side, text: inputs[side].value });
  }));
  sortButtons.forEach((button, side) => { button.addEventListener('mousedown', event => event.preventDefault()); button.addEventListener('click', () => { activeSide = side; inputs[side].focus(); naturalSort(side); }); });
  document.querySelectorAll('.navigation button').forEach(button => button.addEventListener('mousedown', event => event.preventDefault()));
  previous.addEventListener('click', () => navigate(-1));
  next.addEventListener('click', () => navigate(1));
  ignoreSpace.addEventListener('change', compareNow);
  window.addEventListener('resize', schedulePaint);
  document.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && !event.isComposing && (event.key === '1' || event.key === '2')) {
      event.preventDefault();
      inputs[Number(event.key) - 1].focus();
    }
  });

  function setTexts(left, right) {
    if (![left, right].every(text => window.OpenAllComparisonEditor.acceptsText(String(text)))) {
      renderSummary('内容超过 1000 万字符或 20 万行，已保留当前内容'); return false;
    }
    cancelSort(0); cancelSort(1); documentVersions[0]++; documentVersions[1]++;
    clearTimeout(timer);
    composing.clear();
    inputs[0].setText(String(left));
    inputs[1].setText(String(right));
    inputs.forEach(input => { input.scrollTop = 0; input.scrollLeft = 0; input.setSelectionRange(0, 0); });
    compareNow();
  }

  function openSearch() {
    if (composing.size || inputs.some(input => input.composing)) return;
    findBar.hidden = false;
    searchButton.setAttribute('aria-expanded', 'true');
    if (!findQuery.value) {
      const input = inputs[activeSide];
      const selected = input.value.slice(input.selectionStart, input.selectionEnd);
      if (selected.length <= 256 && !selected.includes('\n')) findQuery.value = selected;
    }
    refreshSearch(true);
    findQuery.focus();
    findQuery.select();
  }

  function closeSearch() {
    if (findComposing) return;
    clearTimeout(findTimer);
    findBar.hidden = true;
    searchButton.setAttribute('aria-expanded', 'false');
    findMatches = [[], []]; findResults = []; findIndex = -1;
    paintSearch();
    inputs[activeSide].focus();
  }

  function refreshSearch(reveal) {
    clearTimeout(findTimer);
    findTimer = null;
    if (findBar.hidden || findComposing || composing.size || inputs.some(input => input.composing)) return;
    const previous = findResults[findIndex];
    findMatches = [[], []]; findResults = []; findLimited = false;
    const query = findQuery.value;
    if (query) {
      // 搜索词按普通文本处理；转义正则字符，保持 Unicode 的原始 UTF-16 偏移。
      const expression = new RegExp(query.replace(/[.*+?^{}()|[\]\\$]/g, '\\$&'), findCase.checked ? 'gu' : 'giu');
      for (let side = 0; side < 2; side++) {
        if (findScope.value !== 'both' && findScope.value !== String(side)) continue;
        expression.lastIndex = 0;
        let match;
        const source = inputs[side].value;
        while ((match = expression.exec(source))) {
          // 高频短词限制结果索引大小，避免一次搜索耗尽内存；界面明确标示上限。
          if (findMatches[side].length === 10000) { findLimited = true; break; }
          const item = { side, from: match.index, to: match.index + match[0].length, index: findMatches[side].length };
          findMatches[side].push(item); findResults.push(item);
        }
      }
    }
    findIndex = findResults.length ? 0 : -1;
    if (!reveal && previous && findResults.length) {
      const nearest = findResults.findIndex(item => item.side === previous.side && item.from >= previous.from);
      findIndex = nearest < 0 ? findResults.length - 1 : nearest;
    }
    updateSearchCount();
    if (reveal) revealSearchMatch(); else paintSearch();
  }

  function updateSearchCount() {
    const current = findResults[findIndex];
    findCount.textContent = !findQuery.value ? '' : !current ? '无匹配结果' :
      (findIndex + 1) + ' / ' + findResults.length + (findLimited ? '+' : '') + ' · ' + (current.side === 0 ? '左侧' : '右侧');
    findCount.title = findLimited ? '每侧显示前 10,000 处匹配，请增加搜索词以缩小范围' : findCount.textContent;
    findPrevious.disabled = findNext.disabled = !findResults.length;
  }

  function paintSearch() {
    if (composing.size || inputs.some(input => input.composing)) return;
    const selected = findResults[findIndex];
    for (let side = 0; side < 2; side++) {
      inputs[side].applySearch(findBar.hidden || pending ? [] : findMatches[side],
        selected?.side === side ? selected.index : -1);
    }
  }

  function revealSearchMatch() {
    const selected = findResults[findIndex];
    if (!selected) { paintSearch(); return; }
    activeSide = selected.side;
    inputs[selected.side].revealSearch(selected.from, selected.to);
    paintSearch();
  }

  function moveSearch(direction) {
    if (findComposing || composing.size || inputs.some(input => input.composing)) return;
    if (findBar.hidden) { openSearch(); return; }
    if (pending && !compareWorker) compareNow();
    if (findTimer) { refreshSearch(true); return; }
    if (!findResults.length) return;
    findIndex = (findIndex + direction + findResults.length) % findResults.length;
    updateSearchCount();
    revealSearchMatch();
  }

  searchButton.addEventListener('click', openSearch);
  document.getElementById('find-close').addEventListener('click', closeSearch);
  findPrevious.addEventListener('click', () => moveSearch(-1));
  findNext.addEventListener('click', () => moveSearch(1));
  [findPrevious, findNext].forEach(button => button.addEventListener('mousedown', event => event.preventDefault()));
  findScope.addEventListener('change', () => refreshSearch(true));
  findCase.addEventListener('change', () => refreshSearch(true));
  findQuery.addEventListener('input', () => {
    clearTimeout(findTimer);
    if (!findComposing) findTimer = setTimeout(() => refreshSearch(true), 80);
  });
  findQuery.addEventListener('compositionstart', () => { findComposing = true; clearTimeout(findTimer); });
  findQuery.addEventListener('compositionend', () => { findComposing = false; refreshSearch(true); });
  // 在编辑器自己的键盘映射之前接收查找快捷键，焦点仍归当前窗口所有。
  document.addEventListener('keydown', event => {
    if (event.isComposing || findComposing || composing.size || inputs.some(input => input.composing)) return;
    const command = event.metaKey && !event.ctrlKey && !event.altKey;
    const key = event.key.toLowerCase();
    if (command && key === 'f' && !event.shiftKey) {
      event.preventDefault(); event.stopPropagation(); openSearch();
    } else if (command && key === 'g' && !findBar.hidden) {
      event.preventDefault(); event.stopPropagation(); moveSearch(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Escape' && !findBar.hidden) {
      event.preventDefault(); event.stopPropagation(); closeSearch();
    } else if (event.key === 'Enter' && document.activeElement === findQuery) {
      event.preventDefault(); event.stopPropagation(); moveSearch(event.shiftKey ? -1 : 1);
    }
  }, true);

  window.OpenAllSurfaceEffects.install();
  window.setOpenAllV2Theme = theme => {
    const root = document.documentElement;
    for (const key of ['canvas', 'surface', 'raised', 'ink', 'muted', 'secondary', 'rule', 'accent']) {
      if (typeof theme[key] === 'string') root.style.setProperty('--' + key, theme[key]);
    }
    root.style.colorScheme = theme.light ? 'light' : 'dark';
    const removed = theme.light ? '178,62,80' : '197,92,105';
    const added = theme.light ? '40,133,81' : '65,164,112';
    root.style.setProperty('--removed', `rgba(${removed},${theme.light ? '.14' : '.22'})`);
    root.style.setProperty('--added', `rgba(${added},${theme.light ? '.14' : '.22'})`);
    root.style.setProperty('--changed-left', `rgba(${removed},${theme.light ? '.08' : '.12'})`);
    root.style.setProperty('--changed-right', `rgba(${added},${theme.light ? '.08' : '.12'})`);
    root.style.setProperty('--removed-token', `rgba(${removed},${theme.light ? '.28' : '.50'})`);
    root.style.setProperty('--added-token', `rgba(${added},${theme.light ? '.28' : '.50'})`);
    root.style.setProperty('--removed-ink', theme.light ? '#9c3345' : '#d99b9e');
    root.style.setProperty('--added-ink', theme.light ? '#267448' : '#8dbea1');
  };
  window.setTexts = setTexts;
  window.compareV2 = {
    naturalSort,
    pasteText: text => {
      if (document.activeElement === findQuery) {
        findQuery.setRangeText(text, findQuery.selectionStart, findQuery.selectionEnd, 'end');
        findQuery.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        inputs[activeSide].focus();
        inputs[activeSide].replaceSelection(text);
      }
      return true;
    },
    texts: () => inputs.map(input => input.value),
    focus: side => inputs[side === 1 ? 1 : 0].focus(),
    copied: side => { footerStatus.textContent = (side === 0 ? '左侧' : '右侧') + '全文已复制'; },
    previewSearch: visible => {
      if (!visible) { closeSearch(); return; }
      openSearch(); findQuery.value = '文本对比'; refreshSearch(true);
      for (const input of inputs) { input.view.requestMeasure(); input.view.coordsAtPos(input.selectionStart); }
      paintSearch();
    },
    state: () => ({ totals, limited, hunks: hunks.length, generation, pending, background: !!compareWorker, composing: composing.size, sorting: sortJobs.map(Boolean),
      selection: inputs.map(input => [input.selectionStart, input.selectionEnd]), renderedLines: inputs.map(input => input.view.contentDOM.querySelectorAll('.cm-line').length) }),
    notice: message => renderSummary(message),
    verifyPerformance: async () => {
      const saved = inputs.map(input => input.value);
      const result = { passed: false, ticks: 0 };
      const wait = async () => {
        const start = performance.now();
        while (pending && performance.now() - start < 20000) {
          await new Promise(resolve => setTimeout(resolve, 25)); result.ticks++;
        }
        if (pending || !rows.length) throw new Error('后台比较未完成');
      };
      try {
        const text = Array.from({ length: 80000 }, (_, index) => index + ' ' + 'payload-'.repeat(8)).join('\n');
        const changed = text.replace('40000 ', '插入行\n40000 ');
        const start = performance.now();
        setTexts(text, changed);
        result.loadMilliseconds = performance.now() - start;
        if (!compareWorker || !pending) throw new Error('大文本没有进入后台比较');
        await wait();
        if (limited || totals.added !== 1 || totals.changed || totals.removed) throw new Error('大文本精确对齐错误');
        result.compareMilliseconds = performance.now() - start;
        result.workerMilliseconds = lastWorkerMilliseconds;
        inputs[1].scrollTop = 70000 * lineHeight;
        inputs.forEach(input => { input.view.requestMeasure(); input.view.coordsAtPos(input.selectionStart); });
        paint();
        if (inputs[1].view.contentDOM.querySelectorAll('.cm-line').length > 250) throw new Error('大文本未虚拟化');
        openSearch(); findQuery.value = 'payload';
        const searchStart = performance.now(); refreshSearch(true);
        result.searchMilliseconds = performance.now() - searchStart;
        if (findResults.length !== 20000 || !findLimited) throw new Error('大文本搜索上限错误');
        closeSearch(); findQuery.value = '';
        // 旧任务不得覆盖新文档，输入后立即更换样本也不能残留旧差异。
        setTexts(text, changed); setTexts('新内容', '新内容');
        await new Promise(resolve => setTimeout(resolve, 200));
        if (pending || hunks.length || inputs[0].value !== '新内容') throw new Error('过期任务覆盖新内容');
        setTexts(text, text.replaceAll('payload', 'changed'));
        await wait();
        if (!limited || totals.changed !== 80000) throw new Error('大范围变化降级错误');
        const descending = text.split('\n').reverse().join('\n');
        setTexts(descending, text);
        let sortTicks = 0; const heartbeat = setInterval(() => sortTicks++, 10), sortStart = performance.now();
        try {
          const sorting = naturalSort(0);
          if (!sortJobs[0]?.worker) throw new Error('大文本排序没有进入后台');
          if (!await sorting) throw new Error('大文本自然排序未完成');
          result.sortMilliseconds = performance.now() - sortStart; result.sortWorkerMilliseconds = lastSortMilliseconds;
          await wait();
          if (inputs[0].value !== text || inputs[1].value !== text || hunks.length) throw new Error('后台排序结果或重算错误');
          if (!sortTicks || inputs[0].view.contentDOM.querySelectorAll('.cm-line').length > 250) throw new Error('排序期间没有保持响应与虚拟化');
          result.sortTicks = sortTicks;
        } finally { clearInterval(heartbeat); }
        if (!inputs[0].undo() || inputs[0].value !== descending || !inputs[0].redo() || inputs[0].value !== text) throw new Error('大文本自然排序撤销重做失败');
        setTexts(descending, text);
        const outdatedSort = naturalSort(0);
        inputs[0].setSelectionRange(0, 0); inputs[0].replaceSelection('人工编辑\n');
        if (await outdatedSort || !inputs[0].value.startsWith('人工编辑\n')) throw new Error('排序覆盖了开始后新增的编辑');
        setTexts(descending, text);
        const replacedSort = naturalSort(0); setTexts('新内容', '新内容');
        if (await replacedSort || inputs[0].value !== '新内容') throw new Error('过期排序覆盖新载入内容');
        setTexts('保留左侧', '保留右侧');
        setTexts('x'.repeat(10000001), '不能覆盖');
        if (inputs[0].value !== '保留左侧' || inputs[1].value !== '保留右侧') throw new Error('超限载入覆盖现有内容');
        inputs[0].focus(); inputs[0].setSelectionRange(0, inputs[0].length);
        inputs[0].replaceSelection('\n'.repeat(200001));
        if (inputs[0].value !== '保留左侧') throw new Error('超限粘贴覆盖现有内容');
        result.passed = true;
      } catch (error) { result.error = String(error); }
      finally { closeSearch(); findQuery.value = ''; setTexts(...saved); }
      return result;
    },
    verify: async () => {
      const saved = inputs.map(input => ({ text: input.value, start: input.selectionStart, end: input.selectionEnd, top: input.scrollTop, left: input.scrollLeft }));
      const savedIgnore = ignoreSpace.checked, savedSync = syncScroll.checked;
      const savedTheme = document.documentElement.style.cssText;
      const checks = [];
      const progress = { phase: '准备验收', checks: [], waiting: false, completed: false };
      window.compareV2.lastVerification = progress;
      let sample = 0;
      function require(condition, name) {
        progress.phase = name;
        if (!condition) throw new Error(name);
        checks.push(name);
        progress.checks = [...checks];
      }
      // 离屏 WKWebView 可能暂停动画帧；验收通过公开布局查询刷新测量，不依赖 rAF。
      const settle = () => new Promise((resolve, reject) => {
        progress.waiting = true;
        setTimeout(() => {
          try {
            for (const input of inputs) {
              input.view.requestMeasure();
              input.view.coordsAtPos(input.view.state.selection.main.head);
            }
            progress.waiting = false;
            resolve();
          } catch (error) { progress.waiting = false; reject(error); }
        }, 20);
      });
      async function load(left, right) {
        progress.phase = `载入样例 ${++sample}`;
        setTexts(left, right); await settle(); paint(); await settle();
      }
      async function aligned(leftLine, rightLine) {
        await settle();
        const left = inputs[0].lineRect(leftLine), right = inputs[1].lineRect(rightLine);
        return left && right && Math.abs(left.top - right.top) < 1;
      }
      try {
        ignoreSpace.checked = false;
        await load('', '');
        const emptyStatus = summary.textContent === '在左右两侧输入文本';
        await load('相同', '相同');
        require(emptyStatus && summary.textContent === '两侧文本一致', '空白与一致文本显示明确状态');
        await load('第一行\n旧值\n结尾', '第一行\n新值\n结尾\n新增');
        require(totals.changed === 1 && totals.added === 1 && totals.removed === 0, '行级新增与修改');
        require(summary.textContent === '修改 1 行 · 新增 1 行' && summary.getAttribute('aria-label') === '修改 1 行，新增 1 行', '分类统计明确显示行数单位');
        require(navigationCount.textContent === '1 / 2' && navigationCount.title === '第 1 个差异组，共 2 组' && current === 0, '初始首个差异组与导航计数一致');
        require(document.querySelectorAll('.cm-editor').length === 2 && document.querySelectorAll('.cm-content[contenteditable=true]').length === 2, '两块区域均为可编辑的成熟编辑器');
        const originalView = inputs[1].view;
        inputs[1].focus(); inputs[1].setSelectionRange(1, 3); compareNow();
        require(inputs[1].view === originalView && inputs[1].selectionStart === 1 && inputs[1].selectionEnd === 3, '刷新保留编辑器实例和选区');
        window.compareV2.copied(0);
        require(footerStatus.textContent === '左侧全文已复制' && summary.textContent === '修改 1 行 · 新增 1 行', '复制反馈不遮盖比较统计');
        renderSummary('文本文件请控制在 20 MB 以内');
        require(summary.getAttribute('aria-label') === '文本文件请控制在 20 MB 以内', '文件限制提示保留完整读屏说明');
        compareNow();
        const beforeComposition = generation;
        originalView.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { data: '拼', bubbles: true }));
        require(compareNow() === false && generation === beforeComposition, '中文组合输入期间暂停对齐与差异刷新');
        originalView.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { data: '拼', bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 180));
        require(compareNow() && generation > beforeComposition, '组合输入结束恢复比较');
        await load('相同\n原值', '相同\n原值');
        inputs[1].focus(); inputs[1].setSelectionRange(3, 5); inputs[1].replaceSelection('修改'); compareNow();
        require(inputs[1].value === '相同\n修改' && totals.changed === 1, '编辑后直接显示最新差异');
        require(inputs[1].undo() && inputs[1].value === '相同\n原值', '编辑支持撤销');
        compareNow(); require(totals.changed === 0, '撤销后比较恢复');
        require(inputs[1].redo() && inputs[1].value === '相同\n修改', '编辑支持重做');
        await load('新的比较', '新的比较');
        require(!inputs[1].undo() && inputs[1].value === '新的比较', '载入新比较清理旧撤销历史');
        await load('a\nb\nc\nd', 'a\nb\nc\nd\n新增');
        inputs[1].setSelectionRange(1, inputs[1].view.state.doc.length);
        inputs[1].replaceSelection('');
        paint();
        require(pending && inputs[1].value === 'a' && inputs[1].view.state.doc.lines === 1, '删除多行后重算前不会使用过期行号布局');
        compareNow(); await settle();
        const characterSample = ['名称\t👩‍💻 旧值 A', '名称\t👨‍💻 新值 A'];
        await load(...characterSample);
        require(inputs.every((input, side) => input.value === characterSample[side]), '差异装饰保留中文制表符和表情正文');
        const tokens = inputs.map(input => [...input.view.contentDOM.querySelectorAll('.cm-diffToken')].map(node => node.textContent));
        require(tokens[0].some(text => text.includes('👩‍💻')) && tokens[1].some(text => text.includes('👨‍💻')), '字符差异按完整表情字素着色');
        require(inputs.every(input => [...input.view.contentDOM.querySelectorAll('.cm-line')].every(line => getComputedStyle(line).lineHeight === '22px')),
          '两侧正文与差异片段使用一致行高');
        require(inputs.every((input, side) => { const line = input.view.contentDOM.querySelector('.cm-diffLine.changed-' + (side ? 'right' : 'left')); return line && getComputedStyle(line).backgroundColor !== 'rgba(0, 0, 0, 0)'; }),
          '修改行拥有左右独立底色并与行内色块分层');
        await load('版本：0.23.4 / item2 / 旧值', '版本：0.23.5 / item3 / 新值');
        const fragments = inputs.map(input => [...input.view.contentDOM.querySelectorAll('.cm-diffToken')].map(node => node.textContent));
        require(fragments[0].join('|') === '4|2|旧' && fragments[1].join('|') === '5|3|新',
          '版本号与标识符只标实际变化字符，中文保持精确定位');
        await load('{"id":101,"name":"原值"}', '{"id":102,"name":"原值"}');
        require(inputs[0].view.contentDOM.querySelector('.cm-diffToken')?.textContent === '1' && inputs[1].view.contentDOM.querySelector('.cm-diffToken')?.textContent === '2', 'JSON 单字符值变化清晰标出');
        await load('abc tail', 'ac  tail');
        const gaps = inputs.map(input => input.view.contentDOM.querySelectorAll('.cm-diffGap').length);
        require(inputs[0].view.contentDOM.querySelector('.cm-diffToken')?.textContent === 'b' && [...inputs[1].view.contentDOM.querySelectorAll('.cm-diffToken')].some(node => node.textContent === ' ' && node.getBoundingClientRect().width > 0) && gaps.every(Boolean),
          '空格有可见色块，缺失侧以零宽标记定位且不插入正文');
        await load('a1b2c', 'a3b4c');
        require(inputs.map(input => [...input.view.contentDOM.querySelectorAll('.cm-diffToken')].map(node => node.textContent).join('')).join('|') === '12|34', '同一行多处修改分别标记而不染色相同片段');
        const prefix = '中文😀\t'.repeat(30);
        await load(prefix + '旧值', prefix + '新值');
        const token = inputs[1].view.contentDOM.querySelector('.cm-diffToken');
        const beforeLeft = token.getBoundingClientRect().left;
        inputs[1].scrollLeft = 260; await settle();
        const afterToken = inputs[1].view.contentDOM.querySelector('.cm-diffToken');
        require(inputs[1].scrollLeft > 0 && Math.abs(beforeLeft - afterToken.getBoundingClientRect().left - inputs[1].scrollLeft) < 1,
          '水平滚动由编辑器统一移动文字和高亮');
        await load('a  ', 'a'); ignoreSpace.checked = true; compareNow();
        require(!hunks.length, '忽略行尾空格');
        const markupSample = ['<img src=x onerror=alert(1)>', '<img src=x>'];
        await load(...markupSample);
        const images = [...document.querySelectorAll('img')];
        progress.renderedImages = images.map(image => image.outerHTML);
        // CodeMirror 在不可编辑行内 widget 两侧插入无 src 的零宽 img，不能将它误判为正文注入。
        require(inputs.every((input, side) => input.value === markupSample[side]) && !document.querySelector('img[src], [onerror]') &&
          images.every(image => image.classList.contains('cm-widgetBuffer') && image.getAttribute('aria-hidden') === 'true' && [...image.attributes].every(attribute => ['class', 'aria-hidden'].includes(attribute.name))),
          '输入文本完整保留且不能成为带 src 或事件的页面元素');
        ignoreSpace.checked = false;
        await load('开头\n删除内容\n相同尾段', '开头\n相同尾段');
        require(await aligned(3, 2), '单侧删除后相同尾段保持水平对齐');
        require(inputs[0].value === '开头\n删除内容\n相同尾段' && inputs[1].value === '开头\n相同尾段' && inputs[1].view.state.doc.lines === 2,
          '占位不向文档或真实行号插入换行');
        inputs[1].focus(); inputs[1].setSelectionRange(0, inputs[1].view.state.doc.length); await settle();
        const copied = {};
        const copyEvent = new Event('copy', { bubbles: true, cancelable: true });
        Object.defineProperty(copyEvent, 'clipboardData', { value: { clearData() {}, setData(type, value) { copied[type] = value; } } });
        inputs[1].view.contentDOM.dispatchEvent(copyEvent);
        require(copied['text/plain'] === '开头\n相同尾段', '原生复制序列化仅包含选区正文不包含占位');
        inputs[1].setSelectionRange(3, 3); inputs[1].replaceSelection('删除内容\n'); compareNow(); await settle();
        require(!hunks.length && !inputs[1].view.contentDOM.querySelector('.cm-diffSpacer') && await aligned(3, 3), '编辑后重新对齐并移除多余占位');
        require(inputs[1].undo(), '对齐装饰不占据撤销步骤');
        compareNow(); await settle(); require(await aligned(3, 2), '撤销编辑后自动恢复占位对齐');
        await load('共同\n结束', '头部\n共同\n中一\n中二\n结束\n尾部');
        require(await aligned(1, 2) && await aligned(2, 5) && inputs[0].value === '共同\n结束', '文件头中间连续缺行及末尾占位正确');
        await load('', '一\n二');
        require(inputs[0].value === '' && Math.abs(inputs[0].view.contentHeight - inputs[1].view.contentHeight) < 1, '空侧原生空行与占位高度一致');
        await load('一\r\n二\n三\r四\n', '一\n二\n三\n四\n');
        require(inputs[0].value === inputs[1].value && !hunks.length && inputs[0].view.state.doc.lines === 5, 'CRLF混合换行与尾空行标准化且行号一致');
        const large = Array.from({ length: 5000 }, (_, index) => '第 ' + index + ' 行').join('\n');
        await load(large, large + '\n末尾新增');
        require(!limited && totals.added === 1, '长文本共同前后缀精确对齐');
        require(!summary.querySelector('.mode'), '精确对齐时不误报位置对比');
        inputs[1].scrollTop = 4000 * lineHeight; await settle(); paint(); await settle();
        require(inputs[1].view.contentDOM.querySelectorAll('.cm-line').length < 200 && inputs[1].visibleLines().some(number => number >= 4000), '长文本使用编辑器虚拟化绘制');
        syncScroll.checked = true; inputs[1].scrollTop += 220; handleScroll(1); await settle();
        require(Math.abs(inputs[0].scrollTop - inputs[1].scrollTop) < 1, '对齐后同步滚动采用同一视觉坐标');
        await load(large, large.replaceAll('行', '项'));
        require(limited && characterCache.size > 0 && characterCache.size < 200 && summary.title.includes('大文本按行位置对比'), '长文本仅计算可见字符差异且提示降级');
        await load('a\nb\nc\nd', 'a\n插入\nb\nc\n尾');
        inputs[1].focus(); inputs[1].setSelectionRange(2, 4); navigate(1); await settle();
        progress.navigation = {
          current, groups: hunks.length, count: navigationCount.textContent, activeSide,
          documentHasFocus: document.hasFocus(), viewHasFocus: inputs.map(input => input.hasFocus),
          activeEditor: inputs.findIndex(input => document.activeElement === input.view.contentDOM),
          activeElement: { tag: document.activeElement?.tagName, className: document.activeElement?.className,
            label: document.activeElement?.getAttribute('aria-label') },
          selection: inputs[1].view.state.selection.main.toJSON()
        };
        // CodeMirror.hasFocus 同时要求系统窗口激活；离屏验收仍严格核对实际 DOM 编辑焦点。
        require(document.activeElement === inputs[1].view.contentDOM && activeSide === 1 &&
          (!document.hasFocus() || inputs[1].hasFocus) && inputs[1].selectionStart === 2 && inputs[1].selectionEnd === 4 &&
          current === 1 && navigationCount.textContent === '2 / 2' &&
          inputs[1].view.contentDOM.querySelector('.cm-diffLine.current')?.textContent === '尾',
          '差异组导航保留当前编辑焦点');
        const rootStyle = document.documentElement.style;
        window.setOpenAllV2Theme({ light: true, secondary: '#50504f' });
        const lightColors = rootStyle.getPropertyValue('--removed') === 'rgba(178,62,80,.14)' && rootStyle.getPropertyValue('--added-token') === 'rgba(40,133,81,.28)' && rootStyle.getPropertyValue('--secondary') === '#50504f';
        window.setOpenAllV2Theme({ light: false, secondary: '#b8b7b2' });
        require(lightColors && rootStyle.getPropertyValue('--removed') === 'rgba(197,92,105,.22)' && rootStyle.getPropertyValue('--added-token') === 'rgba(65,164,112,.50)', '明暗主题保持清晰的行底色、行内强标记与辅助文字配色');
        const sortedSource = 'item10\nitem02\nitem2\n\nitem1\nitem2\n';
        await load(sortedSource, 'right10\nright2');
        require(sortButtons.length === 2 && sortButtons.every(button => button.getAttribute('aria-label')?.includes('按行自然升序')), '左右分别提供明确的按行自然升序操作');
        const sortingView = inputs[0].view;
        require(await naturalSort(0) && inputs[0].view === sortingView && inputs[0].value === '\nitem1\nitem02\nitem2\nitem2\nitem10\n' && inputs[1].value === 'right10\nright2', '左侧原位自然排序保留重复、空行、尾换行且不改右侧');
        require(inputs[0].undo() && inputs[0].value === sortedSource && inputs[0].redo() && inputs[0].value === '\nitem1\nitem02\nitem2\nitem2\nitem10\n', '自然排序是独立可撤销重做的编辑事务');
        require(await naturalSort(1) && inputs[1].value === 'right2\nright10', '右侧可独立自然排序并保持无尾换行');
        inputs[0].view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { data: '拼', bubbles: true }));
        const beforeSortIME = inputs[0].value;
        require(!await naturalSort(0) && inputs[0].value === beforeSortIME && sortButtons.every(button => button.disabled), '中文组合输入期间不排序或改写文档');
        inputs[0].view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { data: '拼', bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 180));
        await load('item10\nitem2', '右侧原文');
        inputs[1].focus(); inputs[1].setSelectionRange(0, 0); inputs[1].replaceSelection('保留编辑');
        sortButtons[0].click(); await settle();
        require(document.activeElement === inputs[0].view.contentDOM && activeSide === 0 && inputs[0].value === 'item2\nitem10', '跨侧点击自然排序时焦点移到所排序的编辑区');
        inputs[0].view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', metaKey: /Mac|iPhone|iPad/.test(navigator.platform), ctrlKey: !/Mac|iPhone|iPad/.test(navigator.platform), bubbles: true, cancelable: true }));
        require(inputs[0].value === 'item10\nitem2' && inputs[1].value === '保留编辑右侧原文', '排序后键盘撤销作用于目标侧，不撤销另一侧编辑');
        progress.phase = '验收通过';
        progress.completed = true;
        await load('OpenAll 中文😀.*\n保留', 'openall 中文😀.*\n右侧');
        inputs[1].view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true, cancelable: true }));
        findQuery.value = 'openall'; refreshSearch(true); await settle(); paintSearch();
        require(!findBar.hidden && document.activeElement === findQuery && findResults.length === 2 &&
          inputs.every(input => input.view.contentDOM.querySelector('.cm-contentMatch')), '⌘F 打开内容搜索并高亮左右正文');
        const originals = inputs.map(input => input.value);
        findQuery.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        require(findResults[findIndex].side === 1 && document.activeElement === findQuery &&
          inputs[1].selectionStart === 0 && inputs[1].selectionEnd === 7, '回车跨侧跳转且保留搜索框焦点');
        findQuery.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
        require(findIndex === 0, 'Shift 回车跳转上一个搜索结果');
        moveSearch(-1);
        require(findIndex === 1 && inputs.every((input, side) => input.value === originals[side]), '搜索循环跳转不改变正文');
        findScope.value = '0'; refreshSearch(true);
        require(findResults.length === 1 && findResults[0].side === 0, '可限定只搜索左侧内容');
        findCase.checked = true; refreshSearch(true);
        require(!findResults.length && findNext.disabled && findCount.textContent === '无匹配结果', '区分大小写和无结果状态准确');
        findScope.value = '1'; refreshSearch(true);
        require(findResults.length === 1 && findResults[0].side === 1, '可限定只搜索右侧内容');
        findScope.value = 'both'; findCase.checked = false;
        findQuery.value = '.*'; refreshSearch(true);
        require(findResults.length === 2 && findResults.every(match => match.to - match.from === 2), '正则符号按普通文本搜索');
        findQuery.value = '😀'; refreshSearch(true);
        require(findResults.length === 2 && findResults.every(match => match.to - match.from === 2), '搜索表情保持正确 UTF-16 选区');
        findQuery.value = '中文'; refreshSearch(true);
        require(findResults.length === 2, '中文内容可搜索');
        findQuery.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        findQuery.value = '不存在';
        findQuery.dispatchEvent(new Event('input', { bubbles: true }));
        moveSearch(1);
        require(findResults.length === 2 && findComposing, '搜索框组合输入期间不跳转或重算');
        findQuery.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
        require(findResults.length === 0, '搜索框组合输入提交后刷新结果');
        await load('needle\n保留', 'needle');
        findQuery.value = 'needle'; refreshSearch(true);
        inputs[0].focus(); inputs[0].replaceSelection('修改'); compareNow();
        require(findResults.length === 1 && inputs[0].selectionStart === 2 && inputs[0].selectionEnd === 2,
          '搜索期间编辑更新计数且不抢光标');
        require(inputs[0].undo(), '搜索装饰不进入撤销历史');
        compareNow();
        require(inputs[0].value === 'needle\n保留' && findResults.length === 2, '撤销后内容与搜索结果一起恢复');
        findQuery.value = ''; refreshSearch(true);
        require(!findResults.length && inputs.every(input => !input.view.contentDOM.querySelector('.cm-contentMatch')), '清空搜索移除高亮');
        await load('x'.repeat(10001), '');
        findQuery.value = 'x'; refreshSearch(true);
        require(findResults.length === 10000 && findLimited && findCount.textContent.includes('+'), '高频短词搜索有明确结果上限');
        findQuery.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        require(findBar.hidden && document.activeElement === inputs[activeSide].view.contentDOM &&
          inputs.every(input => !input.view.contentDOM.querySelector('.cm-contentMatch')), 'Esc 关闭搜索清除高亮并返回编辑');
        return { passed: true, checks };
      } catch (error) {
        progress.error = String(error);
        progress.completed = true;
        return { passed: false, error: String(error), checks, navigation: progress.navigation, renderedImages: progress.renderedImages };
      } finally {
        findComposing = false;
        closeSearch();
        findQuery.value = ''; findScope.value = 'both'; findCase.checked = false;
        ignoreSpace.checked = savedIgnore; syncScroll.checked = savedSync;
        document.documentElement.style.cssText = savedTheme;
        setTexts(saved[0].text, saved[1].text);
        saved.forEach((value, side) => { inputs[side].setSelectionRange(value.start, value.end); inputs[side].scrollTop = value.top; inputs[side].scrollLeft = value.left; });
        try { await settle(); paint(); }
        catch (error) { progress.cleanupError = String(error); }
      }
    }
  };
  compareNow();
})();
