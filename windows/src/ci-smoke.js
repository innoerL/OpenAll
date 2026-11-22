const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');

// 在真实安装目录运行；用户数据和剪贴板全部隔离，结果同时保留截图与功能断言。
module.exports = async function smoke(searchWindow, output, version, runtimeErrors) {
  fs.mkdirSync(output, { recursive: true });
  const report = { passed: false, version, platform: process.platform, arch: process.arch, checks: [], screenshots: [], performance: {} };
  let active = searchWindow;
  const watch = (_event, win) => { win.webContents.on('preload-error', (_e, _file, error) => runtimeErrors.push(error.message)); win.webContents.on('render-process-gone', (_e, details) => runtimeErrors.push(details.reason)); };
  app.on('browser-window-created', watch);
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const evaluate = (fn, ...args) => active.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`, true);
  const check = (condition, name) => { assert.ok(condition, name); report.checks.push(name); };
  async function until(fn, name, timeout = 20000) { const start = Date.now(); while (!await fn()) { if (Date.now() - start > timeout) throw Error('等待超时：' + name); await pause(40); } }
  async function capture(name) {
    await evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    const filename = name + '.png';
    fs.writeFileSync(path.join(output, filename), (await active.webContents.capturePage()).toPNG());
    report.screenshots.push(filename);
  }
  async function open(id, value = '') {
    await evaluate((page, value) => openall.openTool(page, value), id, value);
    await focusPage(id);
  }
  async function focusPage(id) {
    const target = ['permissions', 'diagnostics', 'snippets', 'linkAliases', 'commandAliases'].includes(id) ? 'settings' : id;
    await until(async () => {
      const win = BrowserWindow.getAllWindows().find(w => new URL(w.webContents.getURL() || 'about:blank').searchParams.get('page') === target);
      if (!win) return false;
      const ready = await win.webContents.executeJavaScript('!!window.OpenAllApp?.ready && !!window.OpenAllApp.controller').catch(() => false);
      if (ready) active = win;
      return ready;
    }, id);
    // 键盘与选区断言要求真实前台焦点，CLI 启动的 macOS 测试进程不会自动激活。
    if (process.platform === 'darwin') app.focus({ steal: true });
    active.focus();
    active.webContents.focus();
    await until(() => evaluate(() => document.hasFocus()), id + ' 前台焦点');
    await pause(70);
    check(await evaluate(() => !document.querySelector('.tool-error')), id + ' 页面加载');
  }
  async function click(text) { await evaluate(label => { const b = [...document.querySelectorAll('#app button')].find(x => x.textContent === label); if (!b) throw Error('按钮不存在：' + label); b.click(); }, text); }
  try {
    await until(() => evaluate(() => !!window.OpenAllApp?.ready), '应用桥接');
    check(await evaluate(async () => !!(await openall.settings()).search), '预加载与设置 IPC');
    if (process.env.OPENALL_CHECK_LEGACY_APPEARANCE === '1') {
      check(await evaluate(async () => {
        const prefs = await openall.settings();
        return !('glass' in prefs) && prefs.theme === 'custom' && prefs.accentHex === '#7ba796';
      }), '升级后移除旧材质偏好并保留用户配色');
    }
    await capture('01-search-idle');
    await evaluate(async () => { await openall.windowAction('pin', { pinned: true }); await OpenAllApp.render('search'); });
    check(await evaluate(() => document.querySelector('.search-pin').classList.contains('selected')), '重新打开搜索保留固定状态');
    await evaluate(() => openall.windowAction('pin', { pinned: false }));
    await evaluate(async () => { await OpenAllApp.render('search'); });
    const fixtures = {
      apps: [{ type: 'application', title: '记事本', detail: '应用 · Windows', value: 'C:\\Windows\\notepad.exe', rank: 70 }],
      files: ['团队说明.pdf', '团队数据.json', '团队图.png', '团队计划.xmind'].map(title => ({ type: 'file', title, detail: '文件 · Documents', value: 'C:\\Documents\\' + title, rank: 58 }))
    };
    await evaluate(async data => { await openall.saveSettings({ searchFiles: true }); await openall.windowAction('smokeFixture', { search: data }); }, fixtures);
    for (const [query, count] of [['文档 团队', 2], ['图片 团队', 1], ['json 团队', 1], ['文件 团队', 4]]) {
      check(await evaluate(async (q, n) => (await openall.search(q)).length === n, query, count), '文件限定词：' + query);
    }
    check(await evaluate(async () => (await openall.search('jishiben')).some(x => x.title === '记事本')), '中文应用拼音搜索');
    await evaluate(() => OpenAllApp.controller.search('json'));
    await capture('02-search-results');
    await evaluate(() => OpenAllApp.controller.search('?json'));
    await evaluate(() => document.querySelector('.search-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true })));
    await until(() => evaluate(async () => (await openall.settings()).commandFavorites?.includes('json')), '命令收藏');
    check(true, '命令目录 Ctrl+K 收藏与持久化');
    report.performance.search = await evaluate(async () => { const start = performance.now(); for (let i = 0; i < 50; i++) await OpenAllApp.controller.search(['j', 'js', 'json'][i % 3]); return { queries: 50, elapsedMS: performance.now() - start }; });
    check(report.performance.search.elapsedMS < 5000, '连续输入 50 次搜索响应');

    await open('json', '{"type":"import_preview_ready","data":{"companyId":988,"companyName":"OpenAll 示例项目","items":[{"action":"update","name":"企业基本资料","enabled":true},{"action":"create","name":"财务状况表","amount":12345.67}]}}');
    await evaluate(async () => { await OpenAllApp.controller.format(); await OpenAllApp.controller.waitIdle(); });
    check(await evaluate(() => { const c = OpenAllApp.controller; return c.getState().valid && c.getText().includes('\n') && document.querySelectorAll('.cm-editor').length === 1; }), 'JSON 原位格式化、可编辑行号区');
    await evaluate(() => OpenAllApp.controller.foldLine(3));
    check(await evaluate(() => OpenAllApp.controller.getState().folded > 0), 'JSON 嵌套折叠');
    await capture('03-json');
    check(await evaluate(async () => (await OpenAllApp.controller.search('企业')) > 0 && !OpenAllApp.controller.getState().folded), 'JSON 搜索自动展开命中位置');
    report.performance.json = await evaluate(async () => {
      const c = OpenAllApp.controller, text = JSON.stringify(Array.from({ length: 24000 }, (_, i) => ({ id: i, value: '长文本稳定性验证 '.repeat(10) }))), start = performance.now();
      let beats = 0; const timer = setInterval(() => beats++, 10);
      c.setText(text); await c.format(); await c.waitIdle(); clearInterval(timer);
      return { bytes: new TextEncoder().encode(text).length, elapsedMS: performance.now() - start, heartbeats: beats, renderedLines: c.getState().renderedLines, valid: c.getState().valid };
    });
    check(report.performance.json.valid && report.performance.json.heartbeats > 0 && report.performance.json.renderedLines < 500, '大 JSON 工作线程与编辑器虚拟化');

    await open('comparison', { left: '项目名称：OpenAll\n状态：待发布\n平台：macOS\n版本：0.25.6', right: '项目名称：OpenAll\n状态：测试中\n平台：Windows\n版本：0.25.6\n云端自动构建' });
    await evaluate(() => OpenAllApp.controller.waitIdle());
    check(await evaluate(() => OpenAllApp.controller.getState().hunks > 0), '左右编辑与原位差异结果');
    check(await evaluate(() => {
      const frame = OpenAllApp.controller.frame, doc = frame.contentDocument;
      const line = doc.querySelector('.cm-diffLine.changed-left'), token = doc.querySelector('.cm-diffToken');
      return doc.querySelectorAll('.natural-sort').length === 2 && line && token &&
        frame.contentWindow.getComputedStyle(line).backgroundColor !== 'rgba(0, 0, 0, 0)' &&
        frame.contentWindow.getComputedStyle(token).boxShadow !== 'none';
    }), '修改行底色与精确字符标记已包含在安装包');
    await capture('04-comparison');
    check(await evaluate(async () => {
      const c = OpenAllApp.controller, saved = c.getTexts(), original = 'item10\nitem2\nitem1\n';
      try {
        c.setTexts(original, 'item1\nitem2\nitem10\n'); await c.waitIdle();
        c.frame.contentDocument.querySelector('.natural-sort').click(); await c.waitIdle();
        const sorted = c.getTexts()[0] === c.getTexts()[1] && !c.getState().hunks;
        const undone = c.getEditors()[0].undo(); await c.waitIdle();
        return sorted && undone && c.getTexts()[0] === original;
      } finally { c.setTexts(...saved); await c.waitIdle(); }
    }), '自然排序按钮按数字顺序重比并支持撤销');
    const diffChecks = await evaluate(() => OpenAllApp.controller.verify());
    report.comparisonChecks = diffChecks;
    check(diffChecks.passed, '文本对比算法、编辑和查找回归');
    report.performance.comparison = await evaluate(() => OpenAllApp.controller.verifyPerformance());
    check(report.performance.comparison.passed, '8 万行对比、搜索与滚动压力验证');

    await evaluate(() => openall.windowAction('smokeFixture', { clipboard: [
      { kind: 'text', value: 'education_certificate', text: 'education_certificate' },
      { kind: 'text', value: 'choose', text: 'choose' },
      { kind: 'text', value: '{"type":"import_preview_ready","items":[1,2,3]}', text: '{"type":"import_preview_ready","items":[1,2,3]}' },
      { kind: 'text', value: '请提取以下资质组：\n{groups_json}', text: '请提取以下资质组：\n{groups_json}' },
      { kind: 'text', value: '# OpenAll\n\n剪贴板底部通栏、大卡片与彩色类型栏。', text: '# OpenAll\n\n剪贴板底部通栏、大卡片与彩色类型栏。' }
    ] }));
    await open('clipboard');
    check(await evaluate(() => document.querySelectorAll('.clip-card').length === 5 && document.querySelectorAll('.clip-type-bar').length === 5), '剪贴板大卡片与彩色类型栏');
    check(await evaluate(() => {
      const colors = new Map([...document.querySelectorAll('.clip-type-bar')].map(bar =>
        [bar.dataset.format, getComputedStyle(bar).backgroundColor]));
      const samples = ['文本', 'JSON', 'Markdown'].map(format => colors.get(format));
      return samples.every(color => color && color !== 'rgba(0, 0, 0, 0)') && new Set(samples).size === 3;
    }), '普通文本、JSON 与 Markdown 实际绘制为三种类型色');
    await capture('05-clipboard');
    const before = await evaluate(() => openall.history());
    const previewText = await evaluate(() => {
      const current = OpenAllApp.controller;
      return current.getItems().find(item => current.getSelected().includes(item.id)).text;
    });
    await click('预览卡片');
    await focusPage('clipboardPreview');
    check(await evaluate(expected => document.querySelector('.clip-preview .preview-content')?.textContent === expected
      && [...document.querySelectorAll('.clip-preview-tools button')].filter(button => !button.disabled).length === 4, previewText), '从剪贴板打开独立预览并显示所选全文与可用工具');
    await click('复制全文');
    await until(() => evaluate(() => document.querySelector('.clip-preview-status')?.textContent === '已复制'), '预览复制全文');
    await capture('tool-clipboard-preview');
    active.close();
    await focusPage('clipboard');
    check(await evaluate(() => {
      const input = document.querySelector('.clipboard-search');
      input.focus();
      input.value = '找不到的记录_OpenAll_';
      input.dispatchEvent(new Event('input'));
      return document.querySelector('.clip-count').textContent === '0 条匹配'
        && document.querySelector('.clipboard-footer button').disabled
        && !document.querySelector('.clip-key-hints').textContent;
    }), '剪贴板空筛选无可执行的卡片提示');
    await evaluate(() => { const input = document.querySelector('.clipboard-search'); input.value = 'choose'; input.dispatchEvent(new Event('input')); input.focus(); input.setSelectionRange(6, 6); });
    check(await evaluate(() => document.querySelector('.clip-count').textContent === '1 条匹配 · 1 项已选'
      && document.querySelector('.clip-key-hints').textContent === '↓ 选择卡片'), '搜索聚焦显示匹配数和进入卡片提示');
    active.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' });
    active.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
    await pause(100);
    check(await evaluate(async n => document.querySelector('.clipboard-search').value === 'choos' && (await openall.history()).length === n, before.length), '搜索框 Backspace 只删除输入');
    const deletion = await evaluate(() => {
      const input = document.querySelector('.clipboard-search');
      input.value = '';
      input.dispatchEvent(new Event('input'));
      const second = document.querySelectorAll('.clip-card')[1];
      second.dispatchEvent(new MouseEvent('click', {bubbles:true, ctrlKey:true}));
      const controller = OpenAllApp.controller, cards = document.querySelectorAll('.clip-card');
      return {kept:controller.getItems()[0].id, deleted:controller.getItems()[1].id,
        multi:document.querySelectorAll('.clip-card[aria-selected=true]').length === 2
          && document.activeElement === cards[1] && document.querySelector('.clip-key-hints').textContent.includes('Backspace 删除此卡')};
    });
    check(deletion.multi, '多选边框、读屏选中态和焦点卡删除提示一致');
    active.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' });
    active.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
    await until(async () => (await evaluate(() => openall.history())).length === before.length - 1, '卡片删除');
    check(await evaluate(async ({kept, deleted}) => {
      const remaining = await openall.history();
      return remaining.some(r => r.id === kept) && !remaining.some(r => r.id === deleted);
    }, deletion), '多选时 Backspace 只删除焦点卡');
    await evaluate(async () => { const id = (await openall.history())[0].id; await openall.clipboardAction('newTag', { tag: '项目' }); await openall.clipboardAction('tag', { ids: [id], tag: '项目' }); await openall.clipboardAction('renameTag', { tag: '项目', name: '项目资料' }); });
    check(await evaluate(async () => (await openall.history())[0].tags.includes('项目资料')), '剪贴板标签与收藏持久化');

    check(await evaluate(async () => { const rows = await openall.history(), favorite = rows.find(x => x.favorite); await openall.clipboardAction('delete', { ids: [favorite.id] }); return (await openall.history()).some(x => x.id === favorite.id); }), '固定卡片删除保护');
    check(await evaluate(async () => { const rows = (await openall.history()).filter(x => !x.favorite).slice(0, 2); await openall.clipboardAction('merge', { ids: rows.map(x => x.id) }); const merged = (await openall.history())[0]; return rows.every(x => merged.text.includes(x.text)); }), '多条文本合并为新卡片');

    for (const [id, value] of [
      ['configFormat', 'server:\n  port: 8080\n  enabled: true'], ['sqlFormat', 'select id,name from users where status=1 order by id desc'],
      ['unicode', '你好，OpenAll 👋'], ['id', ''], ['converter', ''], ['manual', ''],
      ['configDiff', ''], ['explain', '[{"Plan":{"Node Type":"Seq Scan","Relation Name":"users","Plan Rows":200}}]'],
      ['logTimeline', '{"time":"2026-11-16T10:00:00Z","traceId":"req-001","message":"开始"}\n{"time":"2026-11-16T10:00:01Z","traceId":"req-001","message":"完成"}'],
      ['sqlRestore', 'SELECT * FROM users WHERE id = ?'],
      ['markdown', '# OpenAll 笔记\n\n- JSON 与文本对比\n- 独立窗口与剪贴板\n\n```mermaid\nflowchart LR\nA[输入] --> B[编辑]\nB --> C[导出]\n```']
    ]) {
      await open(id, value);
      if (id === 'id') {
        report.idGenerator = await evaluate(() => {
          const p = OpenAllTools.provinces, field = name => document.querySelector('[data-id-part="' + name + '"]');
          const choose = (name, value) => { field(name).value = String(value); field(name).dispatchEvent(new Event('change', { bubbles: true })); };
          const province = p.findIndex(x => x.code === '330000'); choose('province', province);
          const city = p[province].cities.findIndex(x => x.code === '330100'); choose('city', city);
          choose('region', p[province].cities[city].regions.findIndex(x => x.code === '330106'));
          field('age').value = '25'; field('age').dispatchEvent(new Event('input', { bubbles: true }));
          const date = OpenAllTools.birthdayFromAge(25);
          return { provinces: p.length, regions: p.flatMap(x => x.regions).length, expectedPrefix: '330106' + date.year + String(date.month).padStart(2, '0') + String(date.day).padStart(2, '0') };
        });
        check(report.idGenerator.provinces === 31 && report.idGenerator.regions >= 2851, '身份证完整离线地区数据');
        await click('生成测试号');
        check(await evaluate(prefix => [...document.querySelectorAll('.aux-id-row code')].length === 5 && [...document.querySelectorAll('.aux-id-row code')].every(x => x.textContent.startsWith(prefix)), report.idGenerator.expectedPrefix), '身份证省市区联动与年龄反推生日');
      }
      if (['configFormat', 'sqlFormat'].includes(id)) { await evaluate(() => OpenAllApp.controller.format()); await evaluate(() => OpenAllApp.controller.waitIdle()); check(await evaluate(() => !!OpenAllApp.controller.getResult()), id + ' 格式整理'); }
      if (id === 'configDiff') { await evaluate(() => { const [a, b] = document.querySelectorAll('.aux-editor'); a.value = '{"password":"old","port":80}'; b.value = '{"password":"new","port":81}'; }); await click('比较配置'); await until(() => evaluate(() => document.querySelector('tbody')?.textContent.includes('••••••')), '配置敏感字段'); }
      if (id === 'explain') { await click('分析计划'); await until(() => evaluate(() => document.querySelector('tbody')?.textContent.includes('Seq Scan')), '执行计划'); }
      if (id === 'logTimeline') { await click('识别字段'); await until(() => evaluate(() => document.querySelector('.aux-status')?.textContent.includes('2 条日志')), '日志识别'); }
      if (id === 'sqlRestore') { await evaluate(() => document.querySelectorAll('.aux-editor')[1].value = '[42]'); await click('还原 SQL'); await until(() => evaluate(() => document.querySelectorAll('.aux-editor')[2]?.value.includes('42')), 'SQL 还原'); }
      if (id === 'manual') {
        check(await evaluate(() => {
          const toolbar = document.querySelector('.manual-toolbar'), article = document.querySelector('.manual-article');
          const field = toolbar?.querySelector('input[type=search]');
          if (!field || !article || getComputedStyle(toolbar).display !== 'flex') return false;
          const rows = [...article.querySelectorAll('tbody tr')];
          if (rows.length < 20) return false;
          field.value = 'pwd';
          field.dispatchEvent(new Event('input', { bubbles: true }));
          const matches = rows.filter(row => row.getClientRects().length);
          const filtered = matches.length > 0 && matches.length < rows.length && matches.every(row => row.textContent.includes('pwd'));
          field.value = '';
          field.dispatchEvent(new Event('input', { bubbles: true }));
          return filtered && rows.every(row => row.getClientRects().length);
        }), '安装后手册的共享脚本、样式与命令筛选');
      }
      if (id === 'markdown') await until(() => evaluate(() => !!document.querySelector('.aux-diagram svg')), 'Mermaid 渲染');
      await capture('tool-' + id);
      if (id === 'markdown') {
        await click('语法示例');
        check(await evaluate(() => !document.querySelector('.aux-help-popover').hidden), '打开 Markdown 语法示例');
        await capture('tool-markdown-help');
        await click('关闭');
      }
    }
    const image = await evaluate(() => { const c = document.createElement('canvas'); c.width = 640; c.height = 400; const g = c.getContext('2d'), gradient = g.createLinearGradient(0, 0, 640, 400); gradient.addColorStop(0, '#d8c19e'); gradient.addColorStop(1, '#49716b'); g.fillStyle = gradient; g.fillRect(0, 0, 640, 400); g.fillStyle = '#f8f7ef'; g.font = 'bold 42px sans-serif'; g.fillText('OpenAll Windows', 50, 100); return c.toDataURL(); });
    await open('image', image);
    await until(() => evaluate(() => document.querySelector('.aux-image-size')?.textContent.includes('PNG')), '图片加载');
    await capture('tool-image');
    await click('⌗ 裁剪');
    check(await evaluate(() => !!document.querySelector('[role="dialog"] .aux-crop-fields')), '显示图片裁剪编辑器');
    await capture('tool-image-crop');
    await click('取消');
    for (const format of ['png', 'jpeg', 'tiff', 'heic']) {
      const encoded = await evaluate((dataUrl, format) => openall.fileAction('encodeImage', { dataUrl, format, quality: 0.8 }), image, format);
      check(encoded.bytes > 50 && encoded.width === 640 && encoded.height === 400, '安装后真实图片编码：' + format);
    }
    await evaluate(async () => openall.stack('add', { ids: (await openall.history()).slice(0,3).map(x=>x.id) }));
    await open('stack'); await capture('tool-stack');
    await open('selection', { text: 'OpenAll 支持对选中内容执行工具操作。' }); await capture('tool-selection');
    if (process.platform === 'win32') {
      const sample = await evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 800;
        canvas.height = 210;
        const context = canvas.getContext('2d');
        context.fillStyle = 'white';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = 'black';
        context.font = 'bold 48px Arial';
        context.fillText('OPENALL NOTES', 30, 85);
        context.font = '36px Arial';
        context.fillText('Meeting room 12345', 30, 155);
        return canvas.toDataURL('image/png');
      });
      await open('selection', {kind:'image', dataUrl:sample});
      await until(() => evaluate(() => OpenAllApp.controller.getContent().kind === 'image'), '选中 OCR 样本图片');
      await evaluate(() => { void OpenAllApp.controller.activate({id:'recognizeText'}); });
      await until(() => evaluate(() => !document.querySelector('.selection-loading').hidden), '进入 OCR 识别中状态');
      await capture('tool-selection-ocr-loading');
      await until(() => evaluate(() => /12345/.test(document.querySelector('.selection-preview')?.innerText || '')), '系统 OCR 识别结果');
      check(await evaluate(() => /OPENALL/i.test(OpenAllApp.controller.getContent().text)
        && !!document.querySelector('[data-action="translate"]')), 'Windows OCR 结果显示在可继续操作的文本窗口');
      await capture('tool-selection-ocr-result');
    }
    await open('translate', 'OpenAll'); await capture('tool-translate');
    await open('settings');
    for (const tab of ['general', 'search', 'clipboard', 'linkAliases', 'commandAliases', 'snippets', 'permissions', 'diagnostics', 'appearance']) {
      await evaluate(id => OpenAllApp.controller.selectTab(id), tab);
      check(await evaluate(() => !!document.querySelector('.settings-content h1') && !document.body.textContent.includes('小尺寸')), '设置分类：' + tab);
      if (tab === 'linkAliases') {
        check(await evaluate(() => { const form = document.querySelector('.alias-form').getBoundingClientRect(), navigation = document.querySelector('.alias-navigation').getBoundingClientRect(); return navigation.right < form.left && form.bottom <= innerHeight && document.querySelectorAll('.alias-list button').length === 9; }), '网址别名左右布局、默认九个网站与保存区可见');
        await evaluate(() => { document.querySelector('.alias-form input').value = '小红书测试'; [...document.querySelectorAll('.alias-form button')].find(x => x.textContent === '保存更改').click(); });
        await until(() => evaluate(async () => (await openall.settings()).aliases[0].name === '小红书测试'), '网址别名保存');
        await evaluate(() => { document.querySelector('.alias-form input').value = '小红书'; [...document.querySelectorAll('.alias-form button')].find(x => x.textContent === '保存更改').click(); });
        await until(() => evaluate(async () => (await openall.settings()).aliases[0].name === '小红书'), '网址别名还原');
        check(true, '网址别名编辑与持久化');
      }
      await capture('settings-' + tab);
      if (tab === 'search') {
        await click('管理置顶与隐藏结果 →');
        await until(() => evaluate(() => !!document.querySelector('.rules-empty, .settings-content .data-table')), '搜索排序管理内容');
        await capture('settings-search-manager');
      }
    }
    await evaluate(() => OpenAllApp.controller.selectTab('general'));
    await evaluate(() => document.querySelector('.shortcut-button').click());
    await until(() => evaluate(async () => (await openall.diagnostics()).shortcutRecording), '开始快捷键录制');
    check(await evaluate(async () => Object.values((await openall.diagnostics()).registeredShortcuts).every(x => !x)), '快捷键录制期间暂停全局监听');
    await evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', code: 'KeyJ', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })));
    await until(() => evaluate(async () => (await openall.settings()).search === 'Control+Shift+J' && !(await openall.diagnostics()).shortcutRecording), '快捷键录制保存');
    check(true, '快捷键录制保存并结束暂停');
    await evaluate(() => openall.saveSettings({ search: 'Control+Space' }));
    check(await evaluate(async () => { await openall.snippets('save', { keyword: 'datecheck', name: '日期模板', body: '{{date:yyyy-MM-dd}}' }); const s = (await openall.snippets('list')).find(x => x.keyword === 'datecheck'); return /^\d{4}-\d{2}-\d{2}$/.test(await openall.snippets('expand', { id: s.id })); }), '常用片段与自定义日期格式');
    if (process.platform === 'win32') {
      await evaluate(() => openall.windowAction('smokeFixture', { native: true }));
      await until(() => evaluate(async () => (await openall.diagnostics()).nativeReady), 'Windows 原生桥接', 30000);
      const shortcuts = await evaluate(() => openall.windowAction('testShortcuts'));
      check(shortcuts.failed.length === 0, 'Windows 四组全局快捷键实际注册');
    }
    report.gold = await require('./gold-check')(searchWindow, output);
    report.checks.push(...report.gold.checks); report.screenshots.push(...report.gold.screenshots);
    report.appearance = await require('./appearance-check')(searchWindow, output);
    report.checks.push(...report.appearance.checks);
    report.screenshots.push(...report.appearance.screenshots);
    for (const win of BrowserWindow.getAllWindows()) check(!win.webContents.isCrashed(), '窗口渲染稳定：' + new URL(win.webContents.getURL()).searchParams.get('page'));
    assert.deepEqual(runtimeErrors, [], '无渲染或预加载崩溃');
    report.passed = true;
    console.log('Windows 完整安装包回归通过：' + report.checks.length + ' 项，' + report.screenshots.length + ' 张截图');
  } catch (error) {
    try { await capture('failure'); } catch {}
    report.error = error.stack; report.runtimeErrors = runtimeErrors;
    throw error;
  } finally { app.removeListener('browser-window-created', watch); fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); }
};
