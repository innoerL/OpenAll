/* 手册正文由宿主的 Markdown 渲染器生成，筛选与复制只处理已有条目。 */
window.mountOpenAllManual = function (host, article, actions) {
  const toolbar = document.createElement('div');
  toolbar.className = 'manual-toolbar';
  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'aux-input';
  search.placeholder = '搜索命令或用途';
  search.setAttribute('aria-label', search.placeholder);
  const status = document.createElement('span');
  status.className = 'manual-count';
  status.setAttribute('role', 'status');
  toolbar.append(search, status);
  function button(title, action) {
    const element = document.createElement('button');
    element.type = 'button'; element.textContent = title;
    element.addEventListener('click', action);
    toolbar.append(element);
  }
  let feedbackTimer, copiedEntry;
  let copyRevision = 0;
  let searchSummary = '';
  function clearFeedback() {
    clearTimeout(feedbackTimer);
    copiedEntry?.classList.remove('manual-copied');
    copiedEntry = null;
    copyRevision++;
  }
  async function copyCommand(action, entry) {
    clearFeedback();
    const revision = copyRevision;
    try {
      await action();
      if (revision !== copyRevision) return;
      copiedEntry = entry;
      entry?.classList.add('manual-copied');
      status.textContent = '已复制';
    } catch {
      if (revision !== copyRevision) return;
      status.textContent = '复制失败';
    }
    feedbackTimer = setTimeout(() => { clearFeedback(); status.textContent = searchSummary; }, 1500);
  }
  button('复制全文', () => copyCommand(actions.copyAll));
  if (actions.openOriginal) button('用默认应用打开', actions.openOriginal);
  article.classList.add('manual-article');
  host.classList.add('manual-reader');
  host.replaceChildren(toolbar, article);
  const groups = [];
  for (const heading of article.querySelectorAll('h2')) {
    const blocks = [];
    for (let next = heading.nextElementSibling; next && next.tagName !== 'H2'; next = next.nextElementSibling) blocks.push(next);
    const rows = blocks.flatMap(block => [...block.querySelectorAll('tbody tr')]);
    const entries = rows.length ? rows : blocks.filter(block => block.matches('pre,p,ul,ol'));
    groups.push({heading, blocks, entries});
  }
  const sectionPicker = document.createElement('select');
  if (groups.length > 1) {
    sectionPicker.className = 'manual-sections';
    sectionPicker.setAttribute('aria-label', '跳转到手册章节');
    sectionPicker.add(new Option('跳转章节', ''));
    groups.forEach(({ heading }, index) => sectionPicker.add(new Option(heading.textContent, String(index))));
    sectionPicker.addEventListener('change', () => {
      if (sectionPicker.value === '') return;
      const heading = groups[Number(sectionPicker.value)].heading;
      heading.tabIndex = -1;
      heading.focus({preventScroll:true});
      heading.scrollIntoView({block:'start'});
      sectionPicker.value = '';
    });
    toolbar.insertBefore(sectionPicker, toolbar.querySelector('button'));
  }
  const title = article.querySelector(':scope > h1');
  if (title && groups.length) {
    article.setAttribute('aria-label', title.textContent);
    title.remove();
  }
  const intro = [...article.children].filter(element => !groups.some(group => group.heading === element || group.blocks.includes(element)));
  const notes = intro.filter(node => node.matches('p,ul,ol,blockquote'));
  if (notes.length && groups.length) {
    const details = document.createElement('details');
    details.className = 'manual-notes';
    const summary = document.createElement('summary');
    summary.textContent = '适用环境与使用说明';
    notes[0].before(details);
    details.append(summary, ...notes);
    intro.push(details);
  }
  const empty = document.createElement('div');
  empty.className = 'manual-empty';
  const reset = document.createElement('button');
  reset.type = 'button'; reset.textContent = '清除搜索';
  reset.onclick = () => { search.value = ''; filter(); search.focus(); };
  empty.append('没有找到相关命令', reset);
  empty.hidden = true;
  article.append(empty);
  for (const entry of article.querySelectorAll('td code, pre')) {
    entry.classList.add('aux-copyable'); entry.tabIndex = 0; entry.setAttribute('role', 'button');
    entry.title = '复制命令'; entry.setAttribute('aria-label', '复制命令 ' + entry.textContent);
    entry.addEventListener('click', () => copyCommand(() => actions.copy(entry.textContent), entry));
    entry.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); entry.click(); }
    });
  }
  const filter = () => {
    const query = search.value.trim().toLowerCase();
    let matches = 0;
    for (const {heading, blocks, entries} of groups) {
      const headingMatch = heading.textContent.toLowerCase().includes(query);
      const visible = entries.filter(entry => headingMatch || entry.textContent.toLowerCase().includes(query));
      heading.hidden = !visible.length;
      for (const block of blocks) block.hidden = !visible.length;
      for (const entry of entries) entry.hidden = !visible.includes(entry);
      matches += visible.length;
    }
    if (groups.length > 1) {
      groups.forEach(({ heading }, i) => { sectionPicker.options[i + 1].disabled = heading.hidden; });
      sectionPicker.disabled = matches === 0;
    }
    for (const block of intro) block.hidden = !!query;
    empty.hidden = !query || matches > 0;
    clearFeedback();
    searchSummary = query ? (matches ? `${matches} 项匹配` : '没有匹配项') : '';
    status.textContent = searchSummary;
    article.scrollTop = 0;
  };
  search.addEventListener('input', filter);
  const shortcut = event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault(); search.focus(); search.select();
    }
  };
  host.addEventListener('keydown', shortcut);
  return {focus: () => search.focus(), dispose: () => { clearFeedback(); host.removeEventListener('keydown', shortcut); host.classList.remove('manual-reader'); }};
};
