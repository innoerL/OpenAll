const { app, BrowserWindow, screen } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// 开发环境和真实安装包共用相同的金价回归，数据由宿主测试模式提供。
module.exports = async function verifyGold(searchWindow, output) {
  const checks = [], screenshots = [];
  const execute = (win, fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const check = (condition, label) => { assert.ok(condition, label); checks.push(label); };
  async function until(fn, label) {
    const start = Date.now();
    while (!await fn()) { if (Date.now() - start > 15000) throw Error('金价回归超时：' + label); await pause(35); }
  }
  let gold, stranger;
  const hostSettings = await execute(searchWindow, () => openall.settings());
  async function locate() {
    await until(async () => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (await execute(win, () => !!window.openallGold && !!document.querySelector('#date')?.textContent).catch(() => false)) { gold = win; return true; }
      }
      return false;
    }, 'OpenAll 金价页面加载');
  }
  const read = () => execute(gold, () => openallGold.read());
  const click = id => execute(gold, value => document.getElementById(value).click(), id);
  async function capture(name) {
    fs.mkdirSync(output, { recursive: true });
    await execute(gold, async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    const filename = 'gold-' + name + '.png';
    fs.writeFileSync(path.join(output, filename), (await gold.webContents.capturePage()).toPNG()); screenshots.push(filename);
  }
  try {
    const result = await execute(searchWindow, async () => (await openall.search('金价')).find(item => item.value === 'gold'));
    check(!!result, '金价搜索返回内置工具');
    await execute(searchWindow, item => openall.open(item), result); await locate();
    await until(async () => {
      const state = await read();
      return ['gold', 'ctf'].every(id => state.instruments[id].quote && state.instruments[id].history.length > 300);
    }, '离线行情与历史加载');
    const snapshot = await read();
    check(snapshot.instruments.gold.history.length > 300 && snapshot.instruments.ctf.history.length > 300, '两品种近一年历史完整加载');
    check(await execute(gold, () => ['gold', 'ctf'].every(id => document.querySelector('#' + id + ' .quote-price').textContent !== '—') && document.querySelectorAll('.change-chip').length >= 4), '国际金价、周大福牌价与日周涨跌已渲染');
    check(await execute(gold, () => typeof window.openall === 'undefined' && typeof window.goldDesk === 'undefined' && typeof window.require === 'undefined'), '金价页面只暴露受限宿主桥接');
    const preferences = gold.webContents.getLastWebPreferences();
    check(/gold-ui\/index\.html/.test(gold.webContents.getURL()), '金价加载新工具页面');
    check(preferences.sandbox && preferences.contextIsolation && !preferences.nodeIntegration, '金价宿主桥接在隔离沙箱中运行');
    check(!Object.keys(require.cache).some(file => /gold-desk[\\/]app[\\/]/.test(file)), '宿主未加载旧金价应用模块');
    const originalId = gold.id;
    await execute(searchWindow, () => Promise.all([openall.openTool('gold'), openall.openTool('金价桌台')]));
    await locate(); check(gold.id === originalId, '连续打开金价复用同一窗口');
    if ((await read()).edgeEnabled) await click('edge-setting');
    await until(async () => !(await read()).edgeEnabled, '关闭贴边');
    await execute(gold, () => { const canvas = document.querySelector('#gold canvas'); canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })); });
    check(await execute(gold, () => !document.querySelector('#gold .hover').hidden), '走势图支持键盘查看历史点');
    await capture('quotes');
    await click('layout');
    await until(() => execute(gold, () => !document.querySelector('#combined').hidden), '合并图表');
    check((await read()).combined, '合并报价卡和双轴走势图');
    for (const currency of ['EUR', 'CNY', 'USD']) {
      await execute(gold, value => { const field = document.querySelector('#currency'); field.value = value; field.dispatchEvent(new Event('change', { bubbles: true })); }, currency);
      await until(async () => (await read()).currency === currency, '切换币种 ' + currency);
    }
    check(true, '美元、欧元、人民币报价及历史换算');
    await execute(searchWindow, () => openall.saveSettings({ theme: 'light', backgroundHex: '#f2f2ef', accentHex: '#926fad' }));
    await until(async () => (await read()).theme.background === '#f2f2ef' && await execute(gold, () => document.documentElement.dataset.theme === 'light'), '宿主浅色外观同步');
    check(gold.getBackgroundColor().toLowerCase() === '#f2f2ef', '金价原生背景跟随宿主浅色外观');
    await execute(searchWindow, () => openall.saveSettings({ theme: 'dark', backgroundHex: '#242626', accentHex: '#d8c19e' }));
    await until(async () => (await read()).theme.dark && await execute(gold, () => document.documentElement.dataset.theme === 'dark'), '宿主深色外观同步');
    const pinned = (await read()).pinned; await click('pin');
    await until(async () => (await read()).pinned !== pinned, '置顶切换');
    check(gold.isAlwaysOnTop() === !pinned, '置顶设置同步原生窗口');
    await click('outlook-view');
    await until(() => execute(gold, () => !document.querySelector('#outlook').hidden && document.querySelectorAll('#forecast-rows tr').length === 7), '七日展望');
    const toolbar = () => execute(gold, () => ['layout', 'currency'].map(id => document.getElementById(id).getClientRects().length > 0));
    assert.deepEqual(await toolbar(), [false, true], '国际展望仅显示币种切换');
    await click('forecast-ctf');
    await until(() => execute(gold, () => document.querySelector('#forecast-ctf').getAttribute('aria-pressed') === 'true'), '周大福展望');
    check(await execute(gold, async () => {
      const state = await openallGold.read();
      const quote = state.instruments.ctf.quote;
      const days = state.outlook.forecasts.ctf.days;
      const format = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
      const price = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(quote.price);
      const rows = [...document.querySelectorAll('#forecast-rows tr')];
      const header = document.querySelector('.forecast-baseline');
      return header.textContent.includes('今日周大福牌价') && header.querySelector('time').dateTime === quote.date &&
        header.querySelector('strong').textContent.trim() === price + ' 人民币/克' &&
        document.querySelector('#forecast-price-heading').textContent === '每日参考价' &&
        rows.length === 7 && days.length === 7 && rows.every((row, i) => {
          const day = days[i];
          const track = row.querySelector('.range-track');
          if (!track) return false;
          const [low, mid, high] = ['--low', '--mid', '--high'].map(name => Number.parseFloat(track.style.getPropertyValue(name)));
          return 0 <= low && low <= mid && mid <= high && high <= 100 &&
            day.pointMethod === 'joint-history' && Number.isFinite(day.mid) &&
            row.querySelector('time').dateTime === day.date &&
            row.cells[1].matches('.forecast-price') && row.cells[1].textContent === format.format(day.mid) &&
            row.cells[2].matches('.forecast-direction') && row.cells[2].textContent.includes(day.confidence + '%') &&
            row.cells[3].matches('.forecast-range') && row.cells[3].textContent.includes(format.format(day.high));
        });
    }), '当日周大福牌价与日期在表头，七个目标日逐行展示双品种模型实际参考价');
    assert.deepEqual(await toolbar(), [false, false], '周大福展望隐藏无关控件');
    gold.show();
    gold.focus();
    gold.webContents.focus();
    const disclosureIds = ['verification-breakdown', 'method-details'];
    for (const id of disclosureIds) {
      check(await execute(gold, id => {
        const details = document.getElementById(id);
        const summary = details?.querySelector(':scope > summary');
        summary?.focus();
        return !details?.open && summary && document.activeElement === summary;
      }, id), '详情摘要可获键盘焦点：' + id);
      for (const opened of [true, false]) {
        gold.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
        gold.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
        gold.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
        await until(() => execute(gold, (id, opened) => document.getElementById(id).open === opened, id, opened), '回车切换详情 ' + id);
      }
    }
    await execute(gold, () => { document.activeElement.blur(); document.querySelector('main').scrollTop = 0; window.scrollTo(0,0); });
    check(true, '回车可分别展开与收拢验证统计、预测说明');
    const normalSize = gold.getContentSize();
    try {
      gold.setContentSize(345, normalSize[1]);
      await until(() => execute(gold, () => window.innerWidth <= 345), '调整至最小行情窗口');
      check(await execute(gold, () => {
        const table = document.querySelector('#forecast-table');
        const card = document.querySelector('#outlook').getBoundingClientRect();
        return document.querySelector('.forecast-baseline strong')?.textContent.includes('/克') &&
          table.querySelectorAll('tbody time[datetime]').length === 7 &&
          table.getBoundingClientRect().right <= card.right &&
          document.querySelector('#close').getBoundingClientRect().right <= document.documentElement.clientWidth;
      }), '最窄窗口可同时查看七行日期、完整情景区间和窗口操作');
      await capture('outlook-narrow');
    } finally {
      gold.setContentSize(...normalSize);
    }
    check(await execute(gold, () => document.querySelector('#forecast-ctf').getAttribute('aria-pressed') === 'true' && document.querySelectorAll('#forecast-rows tr').length === 7), '两品种七日展望切换');
    check(await execute(gold, () => !!document.querySelector('#verification-note').textContent && document.querySelector('#drivers').children.length > 0 && document.querySelector('#events').children.length > 0 && document.querySelector('#calendar').children.length > 0), '报价验证、市场因素、国际事件与财经日历');
    check(await execute(gold, () => ['gold', 'goldHistory', 'ctf', 'ctfHistory', 'fx', 'news'].every(key => !!document.querySelector('[data-source="' + key + '"]'))), '报价与新闻来源链接保留');
    await execute(gold, () => { window.__goldDocument = document.documentElement; window.__goldForecast = document.querySelector('#forecast-ctf'); });
    await execute(searchWindow, () => openall.saveSettings({ theme: 'custom', backgroundHex: '#203448', accentHex: '#f5ad52' }));
    await until(async () => (await read()).theme.background === '#203448' && (await read()).theme.accent === '#f5ad52', '自定义背景与强调色同步');
    check(await execute(gold, () => window.__goldDocument === document.documentElement && window.__goldForecast === document.querySelector('#forecast-ctf') && document.querySelector('#forecast-ctf').getAttribute('aria-pressed') === 'true'), '外观更新保留当前展望品种且不重建页面');
    check(gold.getBackgroundColor().toLowerCase() === '#203448', '自定义背景同步原生金价窗口');
    check(await execute(gold, () => {
      const style = getComputedStyle(document.documentElement), get = name => style.getPropertyValue('--' + name).trim();
      return get('background') === '#203448' && get('accent') === '#f5ad52' &&
        new Set(['rise', 'fall', 'flat'].map(get)).size === 3 && get('gold-line') !== get('ctf-line') &&
        ['rise', 'fall', 'flat', 'gold-line', 'ctf-line'].every(name => OpenAllGoldTheme.contrast(get(name), get('surface')) >= 3.5);
    }), '宿主自定义外观保留涨跌持平语义色与两条清晰不同的曲线');
    const railTheme = BrowserWindow.getAllWindows().find(win => /gold-edge-rail\.html/.test(win.webContents.getURL()));
    check(await execute(railTheme, () => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === '#f5ad52'), '贴边条实时使用宿主强调色');
    await click('theme');
    await until(async () => {
      const settingsWindow = BrowserWindow.getAllWindows().find(win => /page=settings/.test(win.webContents.getURL()));
      return settingsWindow && execute(settingsWindow, () => document.querySelector('.settings-body')?.textContent.includes('自定义背景'));
    }, '打开宿主外观设置');
    check(true, '金价外观按钮直接进入 OpenAll 外观设置');
    await capture('outlook'); await click('quotes-view'); await capture('combined-dark');
    assert.deepEqual(await toolbar(), [true, true], '返回行情恢复币种与布局切换');
    check(true, '窗口操作随行情、国际展望及周大福展望切换');
    await execute(gold, () => { const canvas = document.querySelector('#combined canvas'); canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })); window.__goldCanvas = canvas; window.__goldHover = document.querySelector('#combined .hover'); });
    await execute(searchWindow, () => openall.saveSettings({ theme: 'custom', backgroundHex: '#e6e2dc', accentHex: '#4455aa' }));
    await until(async () => (await read()).theme.background === '#e6e2dc', '再次同步自定义背景');
    check(await execute(gold, () => window.__goldCanvas === document.querySelector('#combined canvas') && window.__goldHover === document.querySelector('#combined .hover') && !window.__goldHover.hidden), '外观更新保留走势图节点与悬停位置');
    stranger = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } });
    await stranger.loadURL('about:blank');
    check(await execute(stranger, async () => {
      const ipc = require('electron').ipcRenderer;
      for (const channel of ['read', 'action', 'rail-read', 'rail-expand']) {
        try { await ipc.invoke('openall:gold-' + channel, 'close'); return false; } catch {}
      }
      return true;
    }), '其他窗口不能读取或修改金价 IPC');
    await pause(80); check(!gold.isDestroyed() && !gold.isMinimized(), '其他窗口不能关闭或最小化金价');
    stranger.destroy(); stranger = null;
    await click('minimize'); await until(() => gold.isMinimized(), '金价最小化');
    await execute(searchWindow, () => openall.openTool('gold')); await until(() => !gold.isMinimized(), '再次打开恢复窗口');
    const area = screen.getDisplayMatching(gold.getBounds()).workArea;
    gold.setBounds({ ...gold.getBounds(), x: area.x, y: area.y + 24 });
    await click('edge-setting');
    await until(() => execute(gold, () => document.body.dataset.edgeSide === 'left' && document.body.dataset.edgeCollapsing === 'true'), '贴边收起');
    const rail = BrowserWindow.getAllWindows().find(win => /gold-edge-rail\.html/.test(win.webContents.getURL()));
    check(!!rail, '贴边浮条创建并保留展开入口');
    await execute(searchWindow, () => openall.openTool('gold'));
    await until(() => execute(gold, () => document.body.dataset.edgeCollapsing === 'false'), '搜索重新展开贴边窗口');
    await click('edge-setting'); await until(async () => !(await read()).edgeEnabled, '退出贴边模式');
    const retained = await read();
    await click('close'); await until(() => gold.isDestroyed(), '关闭金价窗口');
    check(!searchWindow.isDestroyed() && !app.isQuitting && (!rail || rail.isDestroyed()), '关闭金价只销毁工具与浮条，宿主继续运行');
    check((await execute(searchWindow, () => openall.search('金价'))).some(item => item.value === 'gold'), '关闭金价后宿主搜索仍可用');
    await execute(searchWindow, () => openall.openTool('gold')); await locate();
    const reopened = await read();
    check(gold.id !== originalId && ['pinned', 'combined', 'currency', 'edgeEnabled'].every(key => reopened[key] === retained[key]), '重新打开金价保留设置与后台调度数据');
    check(reopened.theme.background === '#e6e2dc' && reopened.theme.accent === '#4455aa', '重新打开金价继续跟随宿主外观');
    check(!fs.existsSync(path.join(app.getPath('userData'), 'gold-desk/quotes.sqlite')), '离线金价样例只使用内存数据库');
    await click('close'); await until(() => gold.isDestroyed(), '回归清理金价窗口');
    return { checks, screenshots };
  } catch (error) {
    if (gold && !gold.isDestroyed()) await capture('failure').catch(() => {});
    error.goldReport = { checks, screenshots };
    throw error;
  } finally {
    if (stranger && !stranger.isDestroyed()) stranger.destroy();
    if (gold && !gold.isDestroyed()) gold.close();
    await execute(searchWindow, prefs => openall.saveSettings(prefs), hostSettings).catch(() => {});
  }
};
