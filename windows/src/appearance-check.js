const { app, BrowserWindow, nativeImage } = require('electron');
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
  async function capture(win, name, regions = []) {
    if (regions.length) {
      win.show();
      win.focus();
      win.webContents.focus();
    }
    await run(win, async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    const contentBounds = () => run(win, selectors => selectors.map(selector => {
      const frame = document.querySelector('iframe');
      const local = document.querySelector(selector), element = local || frame?.contentDocument?.querySelector(selector);
      if (!element) throw Error('截图缺少内容：' + selector);
      const rect = element.getBoundingClientRect(), offset = local ? { x: 0, y: 0 } : frame.getBoundingClientRect();
      return { selector, x: rect.x + offset.x, y: rect.y + offset.y, width: Math.min(180, rect.width), height: Math.min(40, rect.height) };
    }), regions);
    // DWM 完成组合可能晚于页面的动画帧。直接核对文字区域的像素，避免只有标题栏的空帧通过。
    const started = Date.now();
    let image;
    while (true) {
      image = await win.webContents.capturePage();
      if (!regions.length) break;
      const bounds = await contentBounds();
      const [width, height] = await run(win, () => [innerWidth, innerHeight]);
      const pixels = nativeImage.createFromBuffer(image.toPNG()).resize({ width, height }).toBitmap();
      const samples = bounds.map(rect => {
        const intensities = new Uint32Array(256);
        for (let y = Math.max(0, Math.ceil(rect.y)); y < Math.min(height, Math.floor(rect.y + rect.height)); y++) {
          for (let x = Math.max(0, Math.ceil(rect.x)); x < Math.min(width, Math.floor(rect.x + rect.width)); x++) {
            const i = (y * width + x) * 4;
            const value = (pixels[i] + pixels[i + 1] * 2 + pixels[i + 2]) >> 2;
            intensities[value]++;
          }
        }
        // 忽略少量描边和抗锯齿极值，要求笔画及其底色各至少有八个像素。
        let min = 0, max = 255, dark = 0, bright = 0;
        while (min < 255 && (dark += intensities[min]) < 8) min++;
        while (max > 0 && (bright += intensities[max]) < 8) max--;
        return { ...rect, min, max };
      });
      if (samples.every(({ min, max }) => max - min >= 58)) break;
      if (Date.now() - started > 2500) {
        fs.writeFileSync(path.join(output, name + '-failed.png'), image.toPNG());
        throw Error('实际截图缺少可读的前景内容：' + name + ' ' + JSON.stringify(samples));
      }
      await pause(70);
    }
    fs.writeFileSync(path.join(output, name + '.png'), image.toPNG());
    report.screenshots.push(name + '.png');
    if (regions.length) check(true, name + '：实际截图中可见前景文字');
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
    await until(() => run(settings, () => !!document.querySelector('.appearance-preview')), '外观页就绪');
    check(await run(settings, () => {
      const preview = getComputedStyle(document.querySelector('.appearance-preview'));
      return !document.querySelector('#appearance-glass') && preview.backdropFilter === 'none' &&
        preview.backgroundColor.startsWith('rgb(') && getComputedStyle(document.querySelector('.settings-layout')).backgroundImage === 'none';
    }), '外观使用实色预览');
    const selectedColor = '[data-key="accentHex"][data-value="#5e9ccd"]';
    await run(settings, selector => document.querySelector(selector).click(), selectedColor);
    await until(() => run(settings, selector => document.querySelector(selector).getAttribute('aria-pressed') === 'true', selectedColor), '强调色同步');
    check(await run(settings, selector => {
      const choice = document.querySelector(selector);
      const selected = document.querySelectorAll('.color-choice[data-key="accentHex"][aria-pressed=true]');
      const names = [...document.querySelectorAll('.color-choice')].map(button => button.innerText.trim());
      return selected.length === 1 && choice.textContent.includes('海蓝') && getComputedStyle(choice.querySelector('.color-check')).visibility === 'visible' &&
        names.length === 9 && names.every(Boolean);
    },selectedColor), '命名色样与勾选标记');
    check(await run(shelf, () => document.querySelector('.clipboard-search').value === '保留可见输入'), '切换强调色保留剪贴板输入');
    await capture(settings, 'appearance-solid-settings', ['.settings-nav.selected', '.settings-content h1', '.appearance-preview h3']);
    await capture(json, 'appearance-solid-json', ['.editor-action-group button', '.cm-line:nth-child(2)']);
    await capture(comparison, 'appearance-solid-comparison', ['.heading strong', '#left .cm-line', '#right .cm-line']);
    const effects = await run(settings, async () => {
      const button = document.querySelector('.settings-nav.selected'), bounds = button.getBoundingClientRect();
      const reduce = matchMedia('(prefers-reduced-motion: reduce), (forced-colors: active), (prefers-contrast: more)').matches;
      const point = {bubbles: true, isPrimary: true, pointerType: 'mouse', clientX: bounds.left + 7, clientY: bounds.top + 8};
      button.dispatchEvent(new PointerEvent('pointermove', point));
      await new Promise(resolve => requestAnimationFrame(resolve));
      const staticSurface = !document.querySelector('.oa-halo');
      button.dispatchEvent(new PointerEvent('pointerdown', point));
      const ripple = button.querySelector('.oa-ripple-circle');
      const wave = reduce ? !ripple : !!ripple && getComputedStyle(ripple).animationDuration === '0.6s' &&
        getComputedStyle(ripple.parentNode).overflow === 'hidden' &&
        Math.abs(parseFloat(ripple.style.left) + parseFloat(ripple.style.width) / 2 - 7) < 2;
      await new Promise(resolve => setTimeout(resolve, 740));
      return { wave, staticSurface, clean: !button.querySelector('.oa-ripple') };
    });
    check(effects.wave && effects.clean && effects.staticSurface, '面板保持静止，按钮波纹按下后展开并清理');
    await run(shelf, async () => {
      await openall.windowAction('smokeFixture', { clipboard: [{ kind: 'text', value: '核对卡片文字与类型栏', text: '核对卡片文字与类型栏' }] });
      const search = document.querySelector('.clipboard-search');
      search.value = '';
      search.dispatchEvent(new Event('input'));
    });
    await until(() => run(shelf, () => document.querySelector('.clip-content')?.textContent === '核对卡片文字与类型栏'), '剪贴板卡片就绪');
    await capture(shelf, 'appearance-solid-clipboard', ['.clipboard-tab.selected', '.clip-content']);
    check(await run(settings, () => {
      const [first, second] = document.querySelectorAll('.settings-nav');
      first.click(); second.focus(); second.click();
      return second.getAttribute('aria-current') === 'page' && !first.hasAttribute('aria-current') &&
        document.activeElement === second && getComputedStyle(second, '::before').height === '16px' &&
        !document.querySelector('.settings-indicator');
    }), '快速切换分类时选中标记即时就位，保留键盘焦点');
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
