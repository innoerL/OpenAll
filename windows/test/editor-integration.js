const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
process.env.OPENALL_TEST_MODE = '1';
const output = path.resolve(process.env.OPENALL_EDITOR_TEST_OUTPUT || path.join(__dirname, '../artifacts/editor-integration'));
fs.mkdirSync(output, { recursive: true });
require('../src/main');
const watchdog = setTimeout(() => { console.error('编辑器集成回归总时限已到'); app.exit(1); }, 60000);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const execute = (window, fn, ...args) => window.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
const report = { passed: false, checks: [] };
const check = (condition, message) => { assert.ok(condition, message); report.checks.push(message); console.log('通过：' + message); };
async function until(fn, timeout = 20000) { const start = Date.now(); while (true) { if (await fn()) return; if (Date.now() - start > timeout) throw Error('等待集成状态超时'); await delay(25); } }
async function page(id) { let window; await until(async () => { window = BrowserWindow.getAllWindows().find(item => new URL(item.webContents.getURL() || 'about:blank').searchParams.get('page') === id); return window && await execute(window, () => !!window.OpenAllApp?.ready).catch(() => false); }); return window; }
async function pasteFromShelf(target, usePreview = false) {
  target.show(); target.focus(); await until(() => BrowserWindow.getFocusedWindow()?.id === target.id);
  await execute(target, () => openall.windowAction('showClipboard'));
  const shelf = await page('clipboard');
  await execute(shelf, async preview => {
    const rows = await openall.history();
    await openall.clipboardAction(preview ? 'preview' : 'paste', { ids: [rows.find(row => row.text === '跨窗粘贴').id] });
  }, usePreview);
  if (usePreview) {
    const preview = await page('clipboardPreview');
    await execute(preview, () => document.querySelector('.clip-preview-action button.primary').click());
    await until(() => preview.isDestroyed());
  }
  await delay(120);
}
app.whenReady().then(async () => {
  console.log('完整应用初始化，开始编辑器集成回归');
  try {
    const search = await page('search');
    await execute(search, async () => { await openall.windowAction('smokeFixture', { clipboard: [{ kind: 'text', value: '跨窗粘贴', text: '跨窗粘贴' }] }); await openall.openTool('json', '{"a":{"x":1},"b":{"y":2},"tail":"目标"}'); });
    const json = await page('json');
    await execute(json, async () => { await OpenAllApp.controller.format(); await OpenAllApp.controller.waitIdle(); });
    check(await execute(json, () => {
      const c = OpenAllApp.controller, view = c.editor.view, original = c.getText();
      c.foldLine(2); c.foldLine(5); view.dispatch({ selection: { anchor: view.state.doc.line(2).from, head: view.state.doc.line(8).from } }); view.focus();
      view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
      if (c.getText() !== original || c.getState().folded) return false;
      view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
      const deleted = c.getText(); if (deleted === original) return false; c.undo(); if (c.getText() !== original) return false; c.redo(); if (c.getText() !== deleted) return false; c.undo(); return c.getText() === original;
    }), '跨两个折叠块首次退格仅展开，二次删除及撤销重做保真');
    check(await execute(json, async () => {
      const c = OpenAllApp.controller, view = c.editor.view, original = c.getText();
      for (const key of ['Backspace', 'Delete']) {
        await c.waitIdle(); c.foldLine(2); c.foldLine(5); view.focus();
        view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: /Mac/.test(navigator.platform), ctrlKey: !/Mac/.test(navigator.platform), bubbles: true, cancelable: true }));
        if (!c.getState().folded || view.state.selection.main.from !== 0 || view.state.selection.main.to !== original.length) return false;
        view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
        if (c.getText() !== '') return false;
        c.undo(); if (c.getText() !== original) return false;
        c.redo(); if (c.getText() !== '') return false;
        c.undo(); if (c.getText() !== original) return false;
      }
      return true;
    }), 'JSON 全选后退格或 Delete 一次清空所有折叠内容，撤销重做保真');
    await execute(json, () => { const c = OpenAllApp.controller, at = c.getText().indexOf('目标'); c.editor.focus(); c.editor.view.dispatch({ selection: { anchor: at, head: at + 2 } }); });
    await pasteFromShelf(json, true);
    check(await execute(json, () => OpenAllApp.controller.getText().includes('跨窗粘贴')), '从剪贴板全文预览直接粘贴回 JSON 原选区');
    const beforeSearchPaste = await execute(json, async () => { await OpenAllApp.controller.search('tail'); const q = document.querySelector('.editor-findbar input'); q.focus(); q.select(); return OpenAllApp.controller.getText(); });
    await pasteFromShelf(json);
    check(await execute(json, original => document.querySelector('.editor-findbar input').value === '跨窗粘贴' && OpenAllApp.controller.getText() === original, beforeSearchPaste), 'JSON 查找框聚焦时跨窗粘贴仅替换查询');
    await execute(json, () => { const editor = OpenAllApp.controller.editor; editor.focus(); editor.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    check(!json.isDestroyed() && await execute(json, () => document.querySelector('.editor-findbar').hidden), '编辑区按 Escape 只关闭 JSON 查找');
    await execute(json, () => openall.openTool('comparison', { left: '左侧保持', right: '右侧目标' }));
    const comparison = await page('comparison');
    await execute(comparison, async () => { const c = OpenAllApp.controller; await c.waitIdle(); const editor = c.getEditors()[1]; editor.focus(); editor.setSelectionRange(2, 4); });
    await pasteFromShelf(comparison);
    check(await execute(comparison, () => { const texts = OpenAllApp.controller.getTexts(); return texts[0] === '左侧保持' && texts[1] === '右侧跨窗粘贴'; }), '独立剪贴板窗口保持对比右侧光标与选区');
    const beforeCompareSearch = await execute(comparison, () => { const c = OpenAllApp.controller; c.search('目标'); const q = c.frame.contentDocument.getElementById('find-query'); q.focus(); q.select(); return c.getTexts(); });
    await pasteFromShelf(comparison);
    check(await execute(comparison, original => { const c = OpenAllApp.controller; return c.frame.contentDocument.getElementById('find-query').value === '跨窗粘贴' && JSON.stringify(c.getTexts()) === JSON.stringify(original); }, beforeCompareSearch), '对比查找框聚焦时跨窗粘贴不覆盖正文');
    await execute(comparison, () => openall.saveSettings({ theme: 'light', backgroundHex: '#f2f2ef' }));
    await delay(80);
    check(await execute(json, () => getComputedStyle(document.querySelector('.editor-json-key')).color === 'rgb(31, 87, 117)'), 'JSON 浅色主题语法配色响应设置广播');
    check(await execute(comparison, () => { const root = OpenAllApp.controller.frame.contentDocument.documentElement, parent = getComputedStyle(document.documentElement); return getComputedStyle(root).colorScheme === 'light' && root.style.getPropertyValue('--removed-ink') === '#9c3345' && root.style.getPropertyValue('--secondary') === parent.getPropertyValue('--secondary').trim() && root.style.getPropertyValue('--surface') === parent.getPropertyValue('--editor').trim(); }), '对比 iframe 浅色主题、编辑表面与辅助文字响应设置广播');
    await execute(comparison, async () => {
      const tool = OpenAllApp.controller;
      tool.setTexts('版本 1.2\n文本对比\n旧值\n结束', '版本 1.3\n文本对比\n新值\n结束');
      await tool.waitIdle();
      tool.search('文本对比');
    });
    const normalSize = comparison.getContentSize();
    comparison.setContentSize(480, normalSize[1]);
    function measureNavigation() {
      const doc = OpenAllApp.controller.frame.contentDocument;
      const selectors = ['.toolbar', '.comparison-status', '.navigation', '#navigation-count', '#previous', '#next', '#summary',
        '#open-search', '#options-toggle', '#find-filters', '#findbar', '.query-field', '#find-query',
        '.match-nav', '#find-count', '#find-previous', '#find-next', '#find-close', '.editors'];
      const boxes = Object.fromEntries(selectors.map(id => [id, doc.querySelector(id).getBoundingClientRect().toJSON()]));
      const width = doc.defaultView.innerWidth;
      const compact = doc.defaultView.matchMedia('(max-width:730px)').matches &&
        doc.querySelector('#options-panel').contains(doc.querySelector('#find-filters'));
      const difference = doc.querySelector('#navigation-count').textContent;
      const match = doc.querySelector('#find-count').textContent;
      // 同一排的控件纵向交叠，且整个位于这一排内；系统字体和缩放可以改变实际行高。
      const inOneRow = (selector, ids) => {
        const row = boxes[selector], controls = ids.map(id => boxes[id]);
        return controls.every(box => box.width > 0 && box.height > 0 && box.top >= row.top - 1 &&
          box.bottom <= row.bottom + 1 && box.left >= 0 && box.right <= width + 1) &&
          Math.max(...controls.map(box => box.top)) < Math.min(...controls.map(box => box.bottom));
      };
      const differenceRow = inOneRow('.toolbar', ['#navigation-count', '#previous', '#next', '#summary', '#options-toggle']);
      const searchRow = inOneRow('#findbar', ['#find-query', '#find-count', '#find-previous', '#find-next', '#find-close']);
      const firstRowBottom = Math.max(boxes['.comparison-status'].bottom, boxes['#options-toggle'].bottom);
      const geometryCorrect = differenceRow && searchRow && firstRowBottom <= boxes['#findbar'].top + 1 &&
        boxes['#findbar'].bottom <= boxes['.toolbar'].bottom + 1 && boxes['.toolbar'].bottom <= boxes['.editors'].top + 1 &&
        boxes['.navigation'].right <= boxes['#summary'].left + 1 &&
        boxes['#find-query'].width >= 66 && boxes['#find-query'].right <= boxes['.match-nav'].left + 1 &&
        boxes['.match-nav'].right <= boxes['.query-field'].right + 1 &&
        boxes['.query-field'].right <= boxes['#find-close'].left + 1 &&
        doc.documentElement.scrollWidth <= width && !boxes['#open-search'].width && !boxes['#find-filters'].width;
      return { width, scrollWidth: doc.documentElement.scrollWidth, compact, difference, match, differenceRow, searchRow, geometryCorrect, boxes };
    }
    try {
      // 尺寸变化、断点事件和后台比较结果可能在不同的消息循环到达。
      await until(async () => {
        const state = await execute(comparison, measureNavigation);
        return state.width > 0 && state.width <= 480 && state.compact &&
          state.difference === '1 / 2' && state.match === '匹配 1 / 2 · 上栏';
      }, 5000);
      const state = await execute(comparison, measureNavigation);
      check(await execute(comparison, () => {
        const doc=OpenAllApp.controller.frame.contentDocument;
        const panes=[...doc.querySelectorAll('.pane')], [top,bottom]=panes.map(p=>p.getBoundingClientRect());
        return top.bottom <= bottom.top+1 && top.width >= 440 && Math.abs(top.left-bottom.left)<1 &&
          panes.map(p=>p.querySelector('.pane-title strong').textContent).join('/')==='上栏/下栏';
      }),'窄窗上下叠放并随栏位标记当前搜索匹配');
      check(state.geometryCorrect, '480 像素宽时差异和搜索匹配各占一排，计数与箭头完整可见');
    } finally {
      report.narrowNavigation = await execute(comparison, measureNavigation);
      fs.writeFileSync(path.join(output, 'comparison-search-narrow.png'), (await comparison.webContents.capturePage()).toPNG());
    }
    comparison.focus();
    await until(() => BrowserWindow.getFocusedWindow()?.id === comparison.id);
    await execute(comparison, () => {
      const frame = OpenAllApp.controller.frame;
      frame.contentWindow.focus();
      frame.contentDocument.getElementById('options-toggle').focus();
    });
    function key(keyCode) {
      comparison.webContents.sendInputEvent({ type: 'keyDown', keyCode });
      comparison.webContents.sendInputEvent({ type: 'keyUp', keyCode });
    }
    key('Space');
    await until(() => execute(comparison, () => !OpenAllApp.controller.frame.contentDocument.getElementById('options-panel').hidden));
    key('Tab');
    await until(() => execute(comparison, () => OpenAllApp.controller.frame.contentDocument.activeElement.id === 'sync-scroll'));
    check(await execute(comparison, () => {
      const doc = OpenAllApp.controller.frame.contentDocument, panel = doc.getElementById('options-panel');
      return ['sync-scroll', 'ignore-space', 'find-scope', 'find-case'].every(id => panel.contains(doc.getElementById(id))) &&
        !doc.getElementById('find-filters').hidden;
    }), '窄窗选项可用键盘打开，保留搜索范围、大小写和对比设置');
    key('Escape');
    await until(() => execute(comparison, () => OpenAllApp.controller.frame.contentDocument.activeElement.id === 'options-toggle'));
    key('Escape');
    await until(() => execute(comparison, () => OpenAllApp.controller.frame.contentDocument.querySelector('#findbar').hidden));
    check(await execute(comparison, () => {
      const doc = OpenAllApp.controller.frame.contentDocument;
      return doc.querySelector('#open-search').getBoundingClientRect().width > 0 &&
        OpenAllApp.controller.getEditors().some(editor => doc.activeElement === editor.view.contentDOM);
    }), '退出搜索恢复搜索入口，键盘焦点回到当前编辑栏');
    const paneMenuState = await execute(comparison, () => {
      const doc = OpenAllApp.controller.frame.contentDocument;
      const menu = doc.querySelector('.pane-menu');
      const summary = menu.querySelector('summary'), actions = menu.querySelector('.pane-actions');
      const compact = !menu.open && summary.getBoundingClientRect().width >= 28;
      summary.click();
      const visible = [...actions.querySelectorAll('button')].every(b => b.getBoundingClientRect().width >= 44);
      menu.querySelector('.copy').click();
      return compact && visible && !menu.open;
    });
    check(paneMenuState, '窄窗可从栏操作展开自然排序与复制，执行后自动收起');
    await execute(comparison, () => OpenAllApp.controller.search('文本对比'));
    comparison.setContentSize(...normalSize);
    await delay(100);
    check(await execute(comparison, () => {
      const doc = OpenAllApp.controller.frame.contentDocument;
      const range = id => doc.querySelector(id).getBoundingClientRect();
      const difference = range('.navigation'), find = range('#findbar'), query = range('#find-query');
      const panes=[...doc.querySelectorAll('.pane')].map(p=>p.getBoundingClientRect());
      return panes[0].right<=panes[1].left+1 && Math.abs(panes[0].top-panes[1].top)<1 &&
        difference.right <= find.left && find.top < difference.bottom && query.width >= 100 &&
        doc.querySelector('.pane-menu').open && range('.natural-sort').width > 0;
    }), '宽窗的差异与查找同排独立显示，两栏操作直接可见');
    fs.writeFileSync(path.join(output, 'json-light.png'), (await json.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(output, 'comparison-light.png'), (await comparison.webContents.capturePage()).toPNG());
    report.passed = true;
  } catch (error) { report.error = error.stack; console.error(error.stack); }
  finally { clearTimeout(watchdog); console.log(JSON.stringify(report, null, 2)); fs.writeFileSync(path.join(output, 'integration-report.json'), JSON.stringify(report, null, 2)); app.isQuitting = true; app.exit(report.passed ? 0 : 1); }
});
