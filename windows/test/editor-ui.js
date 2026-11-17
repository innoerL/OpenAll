const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'OpenAll-editor-tests-')));
const output = path.resolve(process.env.OPENALL_EDITOR_TEST_OUTPUT || path.join(__dirname, '../artifacts/editors'));
fs.mkdirSync(output, { recursive: true });
const watchdog = setTimeout(() => { console.error('编辑器回归总时限已到'); app.exit(1); }, 120000);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 960, height: 600, show: false, webPreferences: { contextIsolation: true, backgroundThrottling: false } });
  const errors = [];
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  const run = (fn, ...args) => window.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
  const screenshot = async name => fs.writeFileSync(path.join(output, name + '.png'), (await window.webContents.capturePage()).toPNG());
  const report = { passed: false, platform: process.platform, checks: [] };
  const check = (condition, name) => { assert.ok(condition, name); report.checks.push(name); };
  try {
    await window.loadFile(path.join(__dirname, '../assets/editor-test.html'));
    const source = '{"id":900719925474099312345,"data":{"list":[{"a":1},{"a":2}]},"tail":"保留"}';
    await run(async text => { await renderEditorTest('json', text); await controller.waitIdle(); }, source);
    check(await run(() => controller.getText().includes('900719925474099312345')), '大整数未丢失');
    check(await run(async () => controller.format()), '原位格式化');
    await run(async () => controller.waitIdle());
    check(await run(() => controller.getState().valid && controller.getText().includes('\n')), '格式化后仍是同一编辑区');
    check(await run(() => { const formatted = controller.getText(); controller.undo(); const result = controller.getText().indexOf('\n') === -1; controller.redo(); return result && controller.getText() === formatted; }), '格式化独立撤销重做');
    await run(async () => controller.waitIdle());
    const folded = await run(() => { controller.foldLine(3); return controller.getState().folded; });
    check(folded, '嵌套对象可折叠');
    check(await run(() => {
      const text = controller.getText(), at = text.indexOf('保留');
      controller.editor.view.dispatch({ changes: { from: at, to: at + 2, insert: '可编辑' }, userEvent: 'input.type' });
      return controller.getText().includes('可编辑') && controller.getState().folded;
    }), '折叠时非折叠内容可编辑');
    check(await run(() => {
      const text = controller.getText(); controller.editor.view.dispatch({ changes: { from: 0, to: text.length, insert: '' }, userEvent: 'delete.selection' });
      return controller.getText() === text && !controller.getState().folded;
    }), '第一次删除只展开');
    check(await run(() => { const text = controller.getText(); controller.editor.view.dispatch({ changes: { from: 0, to: text.length, insert: '' }, userEvent: 'delete.selection' }); return controller.getText() === ''; }), '第二次删除生效');
    await run(async () => { controller.setText('{"x":{"nested":"needle"},"tail":1}'); await controller.format(); await controller.waitIdle(); controller.foldAll(); });
    check(await run(async () => (await controller.search('needle')) === 1 && !controller.getState().folded), '搜索揭示折叠内容');
    await screenshot('json-search');
    check(await run(() => {
      controller.editor.focus(); const at = controller.getText().indexOf('needle');
      controller.editor.view.dispatch({ selection: { anchor: at, head: at + 6 } });
      controller.paste('来自剪贴板'); return controller.getText().includes('来自剪贴板');
    }), '剪贴板内容插入 JSON 原光标位置');
    const performance = await run(async () => {
      const row = '{"id":900719925474099312345,"text":"' + 'payload-'.repeat(40) + '"}';
      const text = '[' + Array(14000).fill(row).join(',') + ']';
      let ticks = 0; const timer = setInterval(() => ticks++, 10), start = performance.now();
      controller.setText(text); const formatted = await controller.format(); await controller.waitIdle();
      const state = controller.getState(); clearInterval(timer);
      return { bytes: new TextEncoder().encode(text).length, milliseconds: performance.now() - start, ticks, formatted, ...state };
    });
    check(performance.formatted && performance.valid && performance.bytes > 4_000_000 && performance.ticks > 1 && performance.renderedLines < 300, '大 JSON 后台格式化与虚拟化');
    report.jsonPerformance = performance;
    await run(async () => renderEditorTest('comparison', { left: '共同\n旧值\n结束', right: '共同\n新值\n新增\n结束' }));
    await run(async () => controller.waitIdle());
    check(await run(() => controller.getState().hunks > 0 && controller.getTexts()[1].includes('新增')), '两侧原位编辑对比');
    check(await run(() => controller.search('新') === 2), '对比内容搜索');
    await screenshot('comparison');
    check(await run(async () => {
      const editors = controller.getEditors(); editors[1].focus(); editors[1].setSelectionRange(3, 5);
      controller.paste('剪贴板'); await new Promise(resolve => setTimeout(resolve, 30));
      return controller.getTexts()[0] === '共同\n旧值\n结束' && controller.getTexts()[1].startsWith('共同\n剪贴板');
    }), '剪贴板内容插入对比当前侧光标位置');
    const compared = await run(async () => controller.verify());
    check(compared.passed, '复用 macOS 文本对比回归');
    report.comparisonVerification = compared;
    const comparisonPerformance = await run(async () => controller.verifyPerformance());
    check(comparisonPerformance.passed, '复用 macOS 大文本压力回归');
    report.comparisonPerformance = comparisonPerformance;
    await run(async () => renderEditorTest('configFormat', 'server:\n    port: 8080'));
    check(await run(async () => (await controller.format()) && controller.getResult() === 'server:\n  port: 8080'), '配置格式化');
    await screenshot('config-format');
    await run(async () => renderEditorTest('sqlFormat', 'select a,b from t where id=1'));
    check(await run(async () => (await controller.format()) && controller.getResult().startsWith('SELECT\n')), 'SQL 格式化');
    await screenshot('sql-format');
    check(!errors.length, '编辑器无运行时错误');
    report.passed = true;
    console.log(JSON.stringify(report, null, 2));
  } catch (error) { report.error = error.stack; report.consoleErrors = errors; console.error(error.stack); await screenshot('failure'); }
  finally { clearTimeout(watchdog); fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); window.destroy(); app.exit(report.passed ? 0 : 1); }
});
