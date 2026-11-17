const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

// 使用真实设置广播和窗口按钮，覆盖已打开编辑器与正在输入的剪贴板。
module.exports = async function verifyAppearance(initialWindow, output) {
  fs.mkdirSync(output, { recursive: true });
  const report = { passed: false, checks: [], screenshots: [], palettes: [] };
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const run = async (win, fn, ...args) => {
    let timer;
    try {
      return await Promise.race([
        win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error('外观检查脚本未返回：' + fn.toString().slice(0, 160))), 15000); })
      ]);
    } finally { clearTimeout(timer); }
  };
  const check = (ok, name) => { assert.ok(ok, name); report.checks.push(name); fs.writeFileSync(path.join(output, 'appearance-progress.json'), JSON.stringify(report, null, 2)); };
  // 窗口最小化或销毁可能中止 executeJavaScript 回执，先返回脚本，再触发真实按钮。
  const clickWindowButton = (win, selector) => run(win, selector => { setTimeout(() => document.querySelector(selector).click(), 100); }, selector);
  async function until(fn, label) { const start = Date.now(); while (!await fn()) { if (Date.now() - start > 10000) throw Error('等待超时：' + label); await pause(30); } }
  async function open(id, value = '') {
    await run(initialWindow, (id, value) => openall.openTool(id, value), id, value);
    let win;
    await until(async () => {
      win = BrowserWindow.getAllWindows().find(w => new URL(w.webContents.getURL() || 'about:blank').searchParams.get('page') === id);
      return win && await run(win, () => !!window.OpenAllApp?.ready).catch(() => false);
    }, id);
    return win;
  }
  async function capture(win, name) {
    await run(win, async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
    report.screenshots.push(name + '.png');
  }
  const original = await run(initialWindow, () => openall.settings());
  try {
    const json = await open('json', '{"主题":"切换后仍可编辑","n":2}');
    const comparison = await open('comparison', { left: '保留文字\n修改前', right: '保留文字\n修改后' });
    const shelf = await open('clipboard');
    await run(json, async () => { await OpenAllApp.controller.format(); await OpenAllApp.controller.waitIdle(); });
    await run(comparison, () => OpenAllApp.controller.waitIdle());
    const contents = await run(json, () => OpenAllApp.controller.getText());
    const texts = await run(comparison, () => OpenAllApp.controller.getTexts());
    if (process.platform === 'darwin') app.focus({ steal: true });
    shelf.show(); shelf.focus(); shelf.webContents.focus();
    await run(shelf, () => { const input = document.querySelector('.clipboard-search'); input.value = '保留'; input.focus(); input.setSelectionRange(2, 2); });
    for (const [name, color] of [['dark', '#242626'], ['blue', '#192b3a'], ['light', '#f2f1ed'], ['blue-again', '#192b3a'], ['dark-again', '#242626']]) {
      await run(initialWindow, backgroundHex => openall.saveSettings({ theme: 'custom', backgroundHex }), color);
      await until(() => run(comparison, value => OpenAllApp.controller.frame.contentDocument.documentElement.style.getPropertyValue('--canvas').toLowerCase() === value, color), '主题广播');
      const jsonColors = await run(json, () => {
        const style = getComputedStyle(document.documentElement);
        return { canvas: style.getPropertyValue('--canvas').trim(), surface: (style.getPropertyValue('--editor') || style.getPropertyValue('--surface')).trim(), title: getComputedStyle(document.getElementById('chrome')).backgroundColor, editor: getComputedStyle(document.querySelector('.editor-json-page > .editor-codemirror')).backgroundColor };
      });
      const compareColors = await run(comparison, () => {
        const doc = OpenAllApp.controller.frame.contentDocument, win = doc.defaultView;
        return { surface: win.getComputedStyle(doc.documentElement).getPropertyValue('--surface').trim(), editor: win.getComputedStyle(doc.querySelector('.editors')).backgroundColor };
      });
      const rgb = hex => 'rgb(' + hex.slice(1).match(/../g).map(x => parseInt(x, 16)).join(', ') + ')';
      check(jsonColors.canvas.toLowerCase() === color && jsonColors.title === rgb(color), name + '：标题栏跟随背景');
      check(jsonColors.editor === rgb(jsonColors.surface) && compareColors.editor === rgb(compareColors.surface) && jsonColors.surface === compareColors.surface, name + '：JSON 与对比编辑区使用同一主题表面色');
      if (name === 'blue') check(jsonColors.surface !== report.palettes[0].json.surface, '自定义深色改变编辑区底色');
      const input = await run(shelf, () => {
        const input = document.querySelector('.clipboard-search'), style = getComputedStyle(input);
        const luminance = color => { const rgb = color.match(/[\d.]+/g).slice(0, 3).map(x => { const v = Number(x) / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722; };
        const fore = luminance(style.color), back = luminance(style.backgroundColor);
        return { value: input.value, focused: document.activeElement === input, start: input.selectionStart, end: input.selectionEnd, color: style.color, background: style.backgroundColor, caret: style.caretColor, contrast: (Math.max(fore, back) + .05) / (Math.min(fore, back) + .05) };
      });
      check(input.value === '保留' && input.focused && input.start === 2 && input.end === 2, name + '：外观切换保留剪贴板输入及光标');
      check(input.contrast >= 4.5 && input.caret !== input.background, name + '：剪贴板文字及光标清晰可见');
      report.palettes.push({ name, json: jsonColors, comparison: compareColors, input });
      if (['blue', 'light', 'dark-again'].includes(name)) {
        await capture(json, 'appearance-' + name + '-json');
        await capture(comparison, 'appearance-' + name + '-comparison');
        await capture(shelf, 'appearance-' + name + '-clipboard');
      }
    }
    await shelf.webContents.insertText('可见输入');
    check(await run(shelf, () => document.querySelector('.clipboard-search').value === '保留可见输入'), '外观往返后真实输入继续正常');
    check(await run(json, value => OpenAllApp.controller.getText() === value, contents), '主题切换保留 JSON 文档');
    check(await run(comparison, value => JSON.stringify(OpenAllApp.controller.getTexts()) === JSON.stringify(value), texts), '主题切换保留对比文档');
    check(await run(json, () => {
      const controls = document.querySelector('.window-controls'), buttons = [...controls.children], rect = controls.getBoundingClientRect(), title = document.querySelector('.window-title').getBoundingClientRect();
      return !document.querySelector('.traffic-lights') && buttons.map(x => x.className).join(',') === 'window-minimize,window-maximize,window-close' && Math.abs(rect.right - innerWidth) < 2 && rect.left > title.right && buttons.every(x => x.getBoundingClientRect().width >= 44);
    }), '窗口按钮在右侧，按最小化、最大化、关闭排列');
    const probe = await open('unicode', '标题栏按钮检查');
    probe.show(); probe.focus();
    await clickWindowButton(probe, '.window-maximize');
    await until(() => probe.isMaximized(), '最大化');
    await until(() => run(probe, () => document.querySelector('.window-maximize').getAttribute('aria-label') === '还原'), '还原图标同步');
    await run(probe, () => document.querySelector('.window-maximize').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    await pause(80);
    check(probe.isMaximized(), '双击窗口按钮不会额外切换标题栏状态');
    await clickWindowButton(probe, '.window-maximize');
    await until(() => !probe.isMaximized(), '还原');
    await until(() => run(probe, () => document.querySelector('.window-maximize').getAttribute('aria-label') === '最大化'), '最大化图标同步');
    check(true, '最大化及还原按钮与实际窗口状态一致');
    await clickWindowButton(probe, '.window-minimize');
    await until(() => probe.isMinimized(), '最小化');
    probe.restore(); await until(() => !probe.isMinimized(), '恢复窗口');
    check(true, '最小化按钮实际生效');
    await clickWindowButton(probe, '.window-close');
    await until(() => probe.isDestroyed(), '关闭');
    check(true, '关闭按钮实际生效');
    report.passed = true;
    return report;
  } catch (error) {
    report.error = error.stack;
    throw error;
  } finally {
    await run(initialWindow, prefs => openall.saveSettings(prefs), original).catch(() => {});
    fs.writeFileSync(path.join(output, 'appearance-report.json'), JSON.stringify(report, null, 2));
  }
};
