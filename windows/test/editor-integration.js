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
async function pasteFromShelf(target) {
  target.show(); target.focus(); await until(() => BrowserWindow.getFocusedWindow()?.id === target.id);
  await execute(target, () => openall.windowAction('showClipboard'));
  const shelf = await page('clipboard');
  await execute(shelf, async () => { const rows = await openall.history(); await openall.clipboardAction('paste', { ids: [rows.find(row => row.text === '跨窗粘贴').id] }); });
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
    await execute(json, () => { const c = OpenAllApp.controller, at = c.getText().indexOf('目标'); c.editor.focus(); c.editor.view.dispatch({ selection: { anchor: at, head: at + 2 } }); });
    await pasteFromShelf(json);
    check(await execute(json, () => OpenAllApp.controller.getText().includes('跨窗粘贴')), '独立剪贴板窗口粘贴回 JSON 原选区');
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
    fs.writeFileSync(path.join(output, 'json-light.png'), (await json.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(output, 'comparison-light.png'), (await comparison.webContents.capturePage()).toPNG());
    report.passed = true;
  } catch (error) { report.error = error.stack; console.error(error.stack); }
  finally { clearTimeout(watchdog); console.log(JSON.stringify(report, null, 2)); fs.writeFileSync(path.join(output, 'integration-report.json'), JSON.stringify(report, null, 2)); app.isQuitting = true; app.exit(report.passed ? 0 : 1); }
});
