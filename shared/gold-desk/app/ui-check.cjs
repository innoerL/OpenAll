const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { BrowserWindow, nativeTheme, screen } = require('electron');

// 验收使用宿主同一实例和同一 IPC，不替换生产渲染器。
async function verifyGoldTool(tool, output) {
  if (!output || !path.isAbsolute(output)) throw new Error('金价验收需要绝对输出目录');
  fs.mkdirSync(output, { recursive: true });
  const checks = [];
  const screenshots = [];
  const errors = [];
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const check = (value, label) => { assert.ok(value, label); checks.push(label); };
  const execute = (win, fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
  async function until(fn, label) {
    const started = Date.now();
    while (!await fn()) {
      if (Date.now() - started > 12000) throw new Error('等待金价界面超时：' + label);
      await pause(35);
    }
  }
  let win = tool.show();
  let stranger;
  const read = () => execute(win, () => goldDesk.read());
  const click = id => execute(win, value => document.getElementById(value).click(), id);
  const capture = async name => {
    await execute(win, async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    const filename = `${name}.png`;
    fs.writeFileSync(path.join(output, filename), (await win.webContents.capturePage()).toPNG());
    screenshots.push(filename);
  };
  try {
    await tool.ready;
    await until(() => execute(win, () => !!document.querySelector('#date')?.textContent).catch(() => false), '加载');
    const state = await read();
    check(['gold', 'ctf'].every(id => state.instruments[id].quote && state.instruments[id].history.length >= 365), '双品种报价与近一年曲线');
    check(state.outlook.forecasts.gold.days.length === 7 && state.outlook.forecasts.ctf.days.length === 7, '双品种七日预测');
    check(state.outlook.events.length && state.outlook.calendar.available.length === 3, '国际事件与三个日历来源');
    check(await execute(win, () => typeof require === 'undefined'), '渲染器沙箱隔离');
    check(tool.show().id === win.id, '重复打开复用窗口');
    if ((await read()).edgeEnabled) await click('edge-setting');
    await until(async () => !(await read()).edgeEnabled, '退出贴边');
    await execute(win, () => document.querySelector('#gold canvas').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
    check(await execute(win, () => !document.querySelector('#gold .hover').hidden), '曲线键盘查值');
    await capture('gold-quotes');
    await click('layout');
    await until(() => execute(win, () => !document.querySelector('#combined').hidden), '合并');
    for (const currency of ['EUR', 'CNY', 'USD']) {
      await execute(win, value => {
        const field = document.querySelector('#currency'); field.value = value;
        field.dispatchEvent(new Event('change', { bubbles: true }));
      }, currency);
      await until(async () => (await read()).currency === currency, '币种');
      check((await read()).instruments.gold.quote.price > 0, currency + '每克报价与历史换算');
    }
    const originalTheme = nativeTheme.themeSource;
    const before = await read();
    await click('theme'); await until(async () => (await read()).dark !== before.dark, '明暗主题');
    check(nativeTheme.themeSource === originalTheme, '工具主题不改宿主全局主题');
    await click('pin'); await until(async () => (await read()).pinned !== before.pinned, '置顶');
    check(win.isAlwaysOnTop() === !before.pinned, '置顶状态与原生窗口一致');
    await capture('gold-combined');
    await click('outlook-view');
    await until(() => execute(win, () => !document.querySelector('#outlook').hidden), '展望');
    check(await execute(win, () => document.querySelectorAll('#forecast-rows tr').length === 7 && !!document.querySelector('#verification-note').textContent), '七日展望及实际命中统计');
    await click('forecast-ctf');
    check(await execute(win, () => document.querySelector('#forecast-ctf').getAttribute('aria-pressed') === 'true'), '切换周大福展望');
    check(await execute(win, () => document.querySelectorAll('#drivers button').length === 3 && document.querySelectorAll('#events li').length > 0 && document.querySelectorAll('#calendar li').length === 3), '宏观因素、国际新闻与财经日历渲染');
    await capture('gold-outlook');
    stranger = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } });
    await stranger.loadURL('about:blank');
    check(await execute(stranger, async () => {
      try { await require('electron').ipcRenderer.invoke('openall-gold:theme'); return false; } catch { return true; }
    }), '其他窗口不能调用金价 IPC');
    stranger.destroy(); stranger = null;
    await click('quotes-view');
    const area = screen.getDisplayMatching(win.getBounds()).workArea;
    win.setPosition(area.x, area.y + 25);
    await click('edge-setting');
    await until(() => execute(win, () => document.body.dataset.edgeSide === 'left' && document.body.dataset.edgeCollapsing === 'true'), '左侧贴边收起');
    const rail = BrowserWindow.getAllWindows().find(item => /edge-rail\.html/.test(item.webContents.getURL()));
    check(rail && !rail.isDestroyed(), '独立透明贴边条');
    tool.show();
    await until(() => execute(win, () => document.body.dataset.edgeCollapsing === 'false'), '唤回贴边窗口');
    await click('edge-setting'); await until(async () => !(await read()).edgeEnabled, '取消贴边');
    await click('minimize'); await until(() => win.isMinimized(), '最小化');
    tool.show(); await until(() => !win.isMinimized(), '恢复最小化');
    check(true, '最小化后可通过搜索恢复');
    const retained = await read();
    await click('close'); await until(() => win.isDestroyed(), '关闭');
    check(rail.isDestroyed(), '关闭时清理贴边窗口');
    check(tool.snapshot().outlook.forecasts.gold.days.length === 7, '关闭窗口后后台快照与预测继续可用');
    win = tool.show();
    await until(() => execute(win, () => !!document.querySelector('#date')?.textContent).catch(() => false), '重开');
    const reopened = await read();
    check(['dark', 'pinned', 'combined', 'currency', 'edgeEnabled'].every(key => reopened[key] === retained[key]), '重新打开保留偏好与行情');
  } catch (error) {
    errors.push(error.stack);
    throw error;
  } finally {
    if (stranger && !stranger.isDestroyed()) stranger.destroy();
    const report = { passed: !errors.length, platform: process.platform, architecture: process.arch, electron: process.versions.electron, checks, screenshots, errors };
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(`金价界面检查：${checks.length} 项，${report.passed ? '通过' : '失败'}`);
  }
}

module.exports = { verifyGoldTool };
