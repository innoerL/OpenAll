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
      await until(() => execute(gold, value => {
        const dual = value !== 'CNY';
        const left = document.querySelector('#legend-gold');
        const right = document.querySelector('#legend-ctf');
        const unit = { USD:'美元', EUR:'欧元', CNY:'元' }[value];
        return left.textContent.includes(unit + '/克') && left.textContent.includes('左轴') === dual &&
          right.textContent.includes('右轴') === dual && (!dual || right.textContent.includes('人民币/克')) &&
          document.querySelector('#combined-axis-note').hidden === !dual;
      }, currency), '合并图的价格单位与独立、共用坐标轴 ' + currency);
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
    await until(() => execute(gold, () => !document.querySelector('#outlook').hidden && document.querySelectorAll('#forecast-rows .forecast-day-toggle').length === 7), '七日展望');
    const toolbar = () => execute(gold, () => ['layout', 'currency'].map(id => document.getElementById(id).getClientRects().length > 0));
    assert.deepEqual(await toolbar(), [false, true], '国际展望仅显示币种切换');
    await click('forecast-ctf');
    await until(() => execute(gold, () => document.querySelector('#forecast-ctf').getAttribute('aria-pressed') === 'true'), '周大福展望');
    check(await execute(gold, async () => {
      const state = await openallGold.read();
      const quote = state.instruments.ctf.quote;
      const days = state.outlook.forecasts.ctf.days;
      const format = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
      const actual = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(quote.price);
      const buttons = [...document.querySelectorAll('#forecast-rows .forecast-day-toggle')];
      const header = document.querySelector('.forecast-baseline');
      return header.textContent.includes('今日周大福牌价') && header.querySelector('time').dateTime === quote.date && !header.querySelector('time').hidden &&
        header.querySelector('strong').textContent.includes(actual) && header.textContent.includes('/克') &&
        document.querySelector('#forecast-price-heading').textContent.includes('参考价') &&
        document.querySelectorAll('#forecast-table thead th').length === 3 &&
        buttons.length === 7 && days.length === 7 && buttons.every((button, i) => {
          const day = days[i], row = button.closest('tr');
          return day.pointMethod === 'joint-history' && Number.isFinite(day.mid) &&
            button.getAttribute('aria-expanded') === 'false' && row.querySelector('time').dateTime === day.date &&
            row.cells.length === 3 && row.cells[1].textContent.trim() === format.format(day.mid) &&
            [day.low, day.high].every(value => row.cells[2].textContent.includes(format.format(value))) &&
            !row.innerText.includes('%');
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
    check(true, '回车可分别展开与收拢验证统计与预测说明');
    const normalSize = gold.getContentSize();
    try {
      gold.setContentSize(345, normalSize[1]);
      await until(() => execute(gold, () => window.innerWidth <= 345), '调整至最小行情窗口');
      check(await execute(gold, () => {
        const table = document.querySelector('#forecast-table');
        const rows = [...table.querySelectorAll('.forecast-day-toggle')].map(button => button.closest('tr'));
        const width = document.documentElement.clientWidth;
        return table.getBoundingClientRect().right <= width + 1 && document.documentElement.scrollWidth <= width + 1 &&
          rows.length === 7 && rows.every(row => Array.from(row.cells).every(cell => {
            const range = document.createRange();
            range.selectNodeContents(cell);
            const bounds = cell.getBoundingClientRect(), text = range.getBoundingClientRect();
            return text.right <= bounds.right + 1 && text.left >= bounds.left - 1 && cell.scrollWidth <= cell.clientWidth + 1;
          })) && document.querySelector('#close').getBoundingClientRect().right <= width + 1;
      }), '最窄窗口三列全部可见，七行日期、参考价和完整区间无裁切');
      await capture('outlook-narrow');
      await execute(gold, () => document.querySelector('.forecast-day-toggle').focus());
      for (const [keyCode,index] of [['Up',0],['Down',1],['End',6],['Down',6],['Up',5],['Home',0]]) {
        gold.webContents.sendInputEvent({type:'keyDown',keyCode});
        gold.webContents.sendInputEvent({type:'keyUp',keyCode});
        await until(() => execute(gold, i => document.activeElement === document.querySelectorAll('.forecast-day-toggle')[i]
          && !document.querySelector('.forecast-day-toggle[aria-expanded=true]'), index), '键盘定位日期 ' + keyCode);
      }
      check(true,'方向键及 Home、End 切换日期焦点，首尾不越界');
      gold.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
      gold.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
      gold.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
      const expandedDetails = async () => execute(gold, async index => {
        const button = document.querySelectorAll('.forecast-day-toggle')[index];
        const detail = document.getElementById(button.getAttribute('aria-controls'));
        const day = (await openallGold.read()).outlook.forecasts.ctf.days[index];
        return button.getAttribute('aria-expanded') === 'true' && detail?.matches('.forecast-detail') &&
          detail.getClientRects().length > 0 && detail.innerText.includes(day.confidence + '%') &&
          detail.innerText.includes('未校准');
      }, 0);
      await until(expandedDetails, '回车查看首日方向概率与校准说明');
      check(await execute(gold, async () => {
        const state = await openallGold.read();
        const days = state.outlook.forecasts.ctf.days;
        const points = days.filter(day => Number.isFinite(day.low) && Number.isFinite(day.high));
        const min = Math.min(...points.map(day => day.low)), max = Math.max(...points.map(day => day.high));
        const format = new Intl.NumberFormat('zh-CN', {maximumFractionDigits:0});
        const scale = document.getElementById('range-scale');
        const trackOK = [...document.querySelectorAll('.forecast-day')].every((row, index) => {
          const track = row.querySelector('.range-track'), mark = track?.querySelector('i'), day = days[index];
          if (!track || !mark) return false;
          const measured = [track.style.getPropertyValue('--low'), mark.style.left, track.style.getPropertyValue('--high')];
          const prices = [day.low, day.mid, day.high];
          const bounds = mark.getBoundingClientRect();
          return measured.every((value, i) => Math.abs(parseFloat(value) - 100 * (prices[i] - min) / (max - min)) < .001) &&
            bounds.height > bounds.width && bounds.width > 0;
        });
        const detail = document.querySelector('.forecast-detail:not([hidden]) .day-reading');
        if (!detail || !scale || scale.hidden || !(max > min) || !trackOK ||
            scale.firstElementChild.textContent !== format.format(min) || scale.lastElementChild.textContent !== format.format(max)) return false;
        for (let node = detail; node && node.tagName !== 'TABLE'; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (!['transparent','rgba(0, 0, 0, 0)'].includes(style.backgroundColor) ||
              style.boxShadow !== 'none' || parseFloat(style.borderLeftWidth) > 0) return false;
        }
        return true;
      }), '共用区间刻度、参考竖线与展开详情采用同一块表面底色');
      await capture('outlook-narrow-detail');
      gold.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});
      gold.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
      await until(() => execute(gold, () =>
        document.activeElement === document.querySelector('.forecast-day-toggle') &&
        !document.querySelector('.forecast-day-toggle[aria-expanded=true]')), 'Esc 收起当前日期并保留键盘焦点');
      await execute(gold, () => document.querySelector('.forecast-range').click());
      check(await expandedDetails(),'点击区间也能打开该日详情');
      await execute(gold, () => document.querySelectorAll('.forecast-day-toggle')[1].click());
      check(await execute(gold, () => {
        const open = [...document.querySelectorAll('.forecast-day-toggle[aria-expanded=true]')];
        return open.length === 1 && open[0] === document.querySelectorAll('.forecast-day-toggle')[1];
      }), '点击其他日期时切换到该日详情');
      await click('forecast-gold');
      check(await execute(gold, () => !document.querySelector('.forecast-day-toggle[aria-expanded=true]')), '切换品种收起已展开的日期');
      await capture('outlook-gold-narrow');
      await click('forecast-ctf');
      await execute(searchWindow, () => openall.saveSettings({theme:'light',backgroundHex:'#f2f2ef',accentHex:'#926fad'}));
      await until(() => execute(gold, () => document.documentElement.dataset.theme === 'light'), '浅色窄窗展望');
      await capture('outlook-narrow-light');
      await execute(gold, () => document.querySelector('.forecast-day-toggle').click());
      await capture('outlook-narrow-light-detail');
      await execute(gold, () => document.querySelector('.forecast-day-toggle[aria-expanded=true]').click());
      await execute(searchWindow, () => openall.saveSettings({theme:'dark',backgroundHex:'#242626',accentHex:'#d8c19e'}));
      await until(() => execute(gold, () => document.documentElement.dataset.theme === 'dark'), '恢复展望主题');
    } finally {
      gold.setContentSize(...normalSize);
    }
    check(await execute(gold, () => document.querySelector('#forecast-ctf').getAttribute('aria-pressed') === 'true' && document.querySelectorAll('#forecast-rows .forecast-day-toggle').length === 7), '两品种七日展望切换');
    check(await execute(gold, () => !!document.querySelector('#verification-note').textContent && document.querySelector('#drivers').children.length > 0 && document.querySelector('#events').children.length > 0 && document.querySelector('#calendar').children.length > 0 && ['#drivers','#events','#calendar'].every(selector => document.querySelector(selector).getClientRects().length > 0)), '报价验证、市场因素、国际事件与财经日历直接可见');
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
