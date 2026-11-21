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
    const settings = await open('settings', 'appearance');
    await until(() => run(settings, () => !!document.querySelector('#appearance-glass')), '外观页材质开关');
    await run(settings, () => { if (!document.querySelector('#appearance-glass').checked) document.querySelector('#appearance-glass').click(); });
    await until(() => run(comparison, () => OpenAllApp.controller.frame.contentDocument.documentElement.dataset.material === 'glass'), '对比窗口材质广播');
    check(await run(settings, async () => (await openall.settings()).glass &&
      document.documentElement.dataset.material === 'glass'), '设置中的材质开关立即保存');
    const material = await run(settings, () => {
      const card = getComputedStyle(document.querySelector('.appearance-preview'));
      return {
        accessible: matchMedia('(prefers-reduced-transparency: reduce), (forced-colors: active), (prefers-contrast: more)').matches,
        color: card.backgroundColor, blur: card.backdropFilter, border: card.borderTopWidth,
        background: getComputedStyle(document.querySelector('.settings-layout')).backgroundImage,
      };
    });
    check(material.accessible || (material.color === 'rgba(255, 255, 255, 0.15)' && material.blur === 'blur(16px)' &&
      material.border === '1px' && material.background.includes('radial-gradient')), '毛玻璃卡片绘制材质、描边和彩色背景');
    await capture(settings, 'appearance-glass-settings');
    const effects = await run(settings, async () => {
      const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const button = document.querySelector('.settings-nav.selected'), bounds = button.getBoundingClientRect();
      const reduce = matchMedia('(prefers-reduced-motion: reduce), (forced-colors: active), (prefers-contrast: more)').matches;
      const fine = matchMedia('(any-hover: hover) and (any-pointer: fine)').matches;
      const point = {bubbles: true, isPrimary: true, pointerType: 'mouse', clientX: bounds.left + 7, clientY: bounds.top + 8};
      button.dispatchEvent(new PointerEvent('pointerdown', point));
      const ripple = button.querySelector('.oa-ripple-circle');
      const wave = reduce ? !ripple : !!ripple && getComputedStyle(ripple).animationDuration === '0.6s' &&
        getComputedStyle(ripple.parentNode).overflow === 'hidden' &&
        Math.abs(parseFloat(ripple.style.left) + parseFloat(ripple.style.width) / 2 - 7) < 2;
      const scroller = document.querySelector('.settings-body'), before = scroller.scrollHeight;
      const anchor = scroller.closest('.settings-viewport'), box = anchor.getBoundingClientRect();
      scroller.dispatchEvent(new PointerEvent('pointermove', {...point, clientX: box.left + 40, clientY: box.top + 60}));
      await frame();
      const glow = anchor.querySelector('.oa-halo.oa-visible');
      const clipped = !reduce && fine ? !!glow && getComputedStyle(glow).overflow === 'hidden' &&
        Math.abs(glow.getBoundingClientRect().height - box.height) <= 1 : !glow;
      scroller.dispatchEvent(new PointerEvent('pointerout', {bubbles:true, relatedTarget:null}));
      const left = !glow || !glow.classList.contains('oa-visible');
      await wait(740);
      return { wave, clipped, left, stable: before === scroller.scrollHeight,
        clean: !button.querySelector('.oa-ripple') && !anchor.querySelector('.oa-halo') };
    });
    check(effects.wave && effects.clean, '波纹从按下位置展开，限于按钮边界，结束后释放图层');
    check(effects.clipped && effects.left && effects.stable && effects.clean,
      '光晕限制于可视面板，离开后消退且滚动范围保持稳定');
    check(await run(shelf, () => document.documentElement.dataset.material === 'glass' &&
      document.querySelector('.clipboard-search').value === '保留可见输入'), '剪贴板接受材质广播并保留已输入的文本');
    await run(settings, () => {
      const first = document.querySelector('.settings-nav');
      first.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
      const second = first.nextElementSibling;
      second.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    });
    await pause(720);
    check(await run(settings, () => {
      const active = document.querySelector('.settings-nav[aria-current=page]');
      const indicator = document.querySelector('.settings-indicator path').getBoundingClientRect();
      const button = active.getBoundingClientRect();
      return active.textContent === '搜索' && active.classList.contains('selected') &&
        Math.abs(indicator.top + indicator.height / 2 - button.top - button.height / 2) < 1;
    }), '连续切换后导航胶囊收拢在最终分类，文字与焦点控件保留');
    await run(settings, () => openall.saveSettings({ glass: false }));
    await until(() => run(comparison, () => OpenAllApp.controller.frame.contentDocument.documentElement.dataset.material === 'solid'), '恢复实色材质');
    check(await run(json, value => OpenAllApp.controller.getText() === value, contents) &&
      await run(comparison, value => JSON.stringify(OpenAllApp.controller.getTexts()) === JSON.stringify(value), texts),
    '开启及关闭毛玻璃时保留两个编辑器中的正文');
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
