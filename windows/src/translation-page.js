(() => {
  'use strict';
  window.OpenAllPages.translate = async (root, ctx) => {
    const { h, button, api } = ctx;
    const spinner = h('span', { class: 'translation-spinner', 'aria-hidden': true });
    const icon = h('div', { class: 'translation-offline', hidden: true, 'aria-hidden': true });
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key, value] of Object.entries({ viewBox: '0 0 34 26', width: '52', height: '40', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round' })) svg.setAttribute(key, value);
    const signal = document.createElementNS(svg.namespaceURI, 'path'); signal.setAttribute('d', 'M2 7a19 19 0 0 1 25 0M6 12a13 13 0 0 1 17 0M10 17a6 6 0 0 1 9 0M14.5 22h.01M30 13v5M30 22h.01'); svg.append(signal); icon.append(svg);
    const title = h('h2', {}, '正在连接有道翻译'), detail = h('p', {}, '连接完成后，即可输入或粘贴内容进行翻译。');
    const retry = button('重新连接', () => invoke('retry').then(paint)), browser = button('在浏览器打开 ↗', () => invoke('browser'));
    retry.disabled = true;
    const panel = h('section', { class: 'translation-state', role: 'status' }, h('div', { class: 'translation-card' }, h('div', {class:'translation-symbol'}, spinner, icon), h('div', {class:'translation-message'}, title, detail, h('div', { class: 'translation-actions' }, retry, browser))));
    root.append(panel);
    let dead = false, timer, layoutFrame, state = { phase: 'loading' };
    const invoke = (command, payload = {}) => api.windowAction('translation', { command, ...payload });
    function paint(next) { if (dead || !next?.phase) return; state = next; panel.hidden = next.phase === 'ready'; spinner.hidden = next.phase === 'failed'; icon.hidden = next.phase !== 'failed'; title.textContent = next.title || '正在连接有道翻译'; detail.textContent = next.detail || '连接完成后，即可输入或粘贴内容进行翻译。'; retry.disabled = ['loading', 'idle'].includes(next.phase); retry.hidden = retry.disabled; retry.classList.toggle('primary', !retry.disabled); }
    async function poll() { if (dead) return; try { paint(await invoke('status')); } catch (error) { paint({ phase: 'failed', title: '暂时无法连接有道翻译', detail: error.message }); } finally { if (!dead) timer = setTimeout(poll, state.phase === 'loading' ? 400 : 1000); } }
    function bounds() { const box = root.getBoundingClientRect(); return { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) }; }
    const observer = new ResizeObserver(() => { cancelAnimationFrame(layoutFrame); layoutFrame = requestAnimationFrame(() => { if (!dead) invoke('layout', { bounds: bounds() }).catch(() => {}); }); }); observer.observe(root);
    paint(await invoke('attach', { text: typeof ctx.initialValue === 'string' ? ctx.initialValue : ctx.initialValue?.text || '', bounds: bounds() })); poll();
    return { focus: () => { if (state.phase === 'ready') invoke('focus'); }, paste: text => invoke('paste', { text }), getSelection: () => invoke('selection'), getState: () => state, retry: () => invoke('retry').then(paint),
      dispose() { dead = true; clearTimeout(timer); cancelAnimationFrame(layoutFrame); observer.disconnect(); invoke('release').catch(() => {}); panel.remove(); }
    };
  };
})();
