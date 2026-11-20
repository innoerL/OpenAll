const { app, BrowserWindow, nativeTheme, screen } = require('electron');
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
  const themeSource = nativeTheme.themeSource;
  const hostSettings = await execute(searchWindow, () => openall.settings());
  async function locate() {
    await until(async () => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (await execute(win, () => !!window.goldDesk && !!document.querySelector('#date')?.textContent).catch(() => false)) { gold = win; return true; }
      }
      return false;
    }, '原版金价页面加载');
  }
  const read = () => execute(gold, () => goldDesk.read());
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
    check(await execute(gold, () => typeof window.openall === 'undefined' && typeof window.require === 'undefined'), '金价渲染器只暴露自身隔离桥接');
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
    await click('theme'); await until(async () => (await read()).dark, '深色模式');
    check(nativeTheme.themeSource === themeSource, '金价独立主题不改变宿主系统主题');
    const background = gold.getBackgroundColor();
    await execute(searchWindow, () => openall.saveSettings({ theme: 'light', backgroundHex: '#f2f2ef' }));
    check(gold.getBackgroundColor() === background && await execute(gold, () => document.documentElement.dataset.theme === 'dark'), '宿主主题切换保留金价独立主题');
    const pinned = (await read()).pinned; await click('pin');
    await until(async () => (await read()).pinned !== pinned, '置顶切换');
    check(gold.isAlwaysOnTop() === !pinned, '置顶设置同步原生窗口');
    await click('outlook-view');
    await until(() => execute(gold, () => !document.querySelector('#outlook').hidden && document.querySelectorAll('#forecast-rows tr').length === 7), '七日展望');
    await click('forecast-ctf');
    await until(() => execute(gold, () => document.querySelector('#forecast-ctf').getAttribute('aria-pressed') === 'true'), '周大福展望');
    check(await execute(gold, () => document.querySelector('#forecast-ctf').getAttribute('aria-pressed') === 'true' && document.querySelectorAll('#forecast-rows tr').length === 7), '两品种七日展望切换');
    check(await execute(gold, () => !!document.querySelector('#verification-note').textContent && document.querySelector('#drivers').children.length > 0 && document.querySelector('#events').children.length > 0 && document.querySelector('#calendar').children.length > 0), '报价验证、市场因素、国际事件与财经日历');
    check(await execute(gold, () => ['gold', 'goldHistory', 'ctf', 'ctfHistory', 'fx', 'news'].every(key => !!document.querySelector('[data-source="' + key + '"]'))), '报价与新闻来源链接保留');
    await capture('outlook'); await click('quotes-view'); await capture('combined-dark');
    stranger = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } });
    await stranger.loadURL('about:blank');
    check(await execute(stranger, async () => {
      const ipc = require('electron').ipcRenderer;
      for (const channel of ['read-snapshot', 'pin', 'theme', 'layout', 'currency', 'view', 'edge-setting']) {
        try { await ipc.invoke('openall-gold:' + channel); return false; } catch {}
      }
      ipc.send('openall-gold:quit-window'); ipc.send('openall-gold:minimize'); return true;
    }), '其他窗口不能读取或修改金价 IPC');
    await pause(80); check(!gold.isDestroyed() && !gold.isMinimized(), '其他窗口不能关闭或最小化金价');
    stranger.destroy(); stranger = null;
    await click('minimize'); await until(() => gold.isMinimized(), '金价最小化');
    await execute(searchWindow, () => openall.openTool('gold')); await until(() => !gold.isMinimized(), '再次打开恢复窗口');
    const area = screen.getDisplayMatching(gold.getBounds()).workArea;
    gold.setBounds({ ...gold.getBounds(), x: area.x, y: area.y + 24 });
    await click('edge-setting');
    await until(() => execute(gold, () => document.body.dataset.edgeSide === 'left' && document.body.dataset.edgeCollapsing === 'true'), '贴边收起');
    const rail = BrowserWindow.getAllWindows().find(win => /edge-rail\.html/.test(win.webContents.getURL()));
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
    check(gold.id !== originalId && ['dark', 'pinned', 'combined', 'currency', 'edgeEnabled'].every(key => reopened[key] === retained[key]), '重新打开金价保留设置与后台调度数据');
    check(fs.existsSync(path.join(app.getPath('userData'), 'gold-desk/quotes.sqlite')), '金价数据保存在宿主隔离子目录');
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
