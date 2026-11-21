const { app, BrowserWindow, net, powerMonitor, nativeTheme, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { palette } = require('./theme');

const resourceDirectory = name => app.isPackaged ? path.join(process.resourcesPath, name) : path.join(__dirname, '../../shared', name);
const core = name => require(path.join(resourceDirectory('gold-core'), name + '.cjs'));
const CTF_PAGE = 'https://www.ctfmall.com/todaygold';

function hostTheme(settings) {
  const { light, vars } = palette(settings, !nativeTheme.shouldUseDarkColors);
  return { background: vars['--canvas'], surface: vars['--surface'], foreground: vars['--ink'], secondary: vars['--muted'], border: vars['--rule'], accent: vars['--accent'], dark: !light };
}

// 行情服务属于 OpenAll 生命周期；关闭工具窗口后保留数据和定时更新。
async function createGoldService({ dataDirectory, legacyDirectory, fixture = false, settings, sources: suppliedSources, clock: suppliedClock }) {
  const { Store } = core('store');
  const { Scheduler } = core('scheduler');
  const { createSources, parseOfficialCtf } = core('sources');
  const { CURRENCIES } = core('currency');
  const { LINKS } = core('links');
  const { migrateLegacyData } = core('migrate');
  // 样例忽略传入的目录与旧库，避免继承真实路径时触碰用户记录。
  if (!fixture) fs.mkdirSync(dataDirectory, { recursive: true });
  const filename = fixture ? ':memory:' : path.join(dataDirectory, 'quotes.sqlite');
  const imported = fixture ? false : await migrateLegacyData(filename, legacyDirectory);
  const store = new Store(filename);
  const sample = fixture ? core('fixture').createFixture() : null;
  const clock = sample?.clock ?? suppliedClock ?? Date.now;
  const lifetime = new AbortController();
  const observers = new Set();
  let disposed = false, timer, lastPublished, view = 'quotes', dockSide = null;
  let osOffline = fixture ? false : !net.isOnline(), internetOffline = false, checkingInternet = false;
  const fetcher = (url, options = {}) => net.fetch(url, { ...options, signal: options.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal });
  const snapshot = () => {
    const theme = hostTheme(settings());
    return { ...scheduler.snapshot(), pinned: store.getSetting('pinned') ?? true, edgeEnabled: store.getSetting('edgeEnabled') ?? true, combined: Boolean(store.getSetting('combined')), theme, dark: theme.dark, view, dockSide, imported };
  };
  const publish = () => {
    if (disposed) return;
    // 无窗口时也记录当天正式展望，下一次打开继续使用同一份验证结果。
    const value = snapshot(), serialized = JSON.stringify(value);
    if (serialized === lastPublished) return;
    lastPublished = serialized;
    for (const callback of observers) callback(value);
  };
  const scheduler = new Scheduler({ store, clock, online: () => !osOffline && !internetOffline, publish,
    sources: sample?.sources ?? suppliedSources ?? createSources(fetcher, clock, readOfficial),
    onConnectionError: () => { checkNetwork(); void probeInternet(); },
  });
  const tick = reason => scheduler.tick(reason).catch(error => { if (!disposed) console.error('金价更新任务失败', error); });

  // 公开官网在无宿主桥接的隔离窗口内运行，仅读取报价所需的可见文字。
  async function readOfficial() {
    const signal = lifetime.signal;
    signal.throwIfAborted();
    const page = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'openall-public-ctf', backgroundThrottling: false } });
    const contents = page.webContents;
    const cancel = () => { if (!page.isDestroyed()) page.destroy(); };
    signal.addEventListener('abort', cancel, { once: true });
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', event => event.preventDefault());
    let succeeded = true, deadlineTimer;
    const navigation = page.loadURL(CTF_PAGE).catch(() => { succeeded = false; });
    const deadline = Date.now() + 17000;
    try {
      await Promise.race([new Promise(resolve => contents.once('dom-ready', resolve)), navigation,
        new Promise(resolve => { deadlineTimer = setTimeout(resolve, 16000); })]);
      while (succeeded && Date.now() < deadline && !contents.isDestroyed() && contents.getURL() === CTF_PAGE) {
        signal.throwIfAborted();
        try { return parseOfficialCtf(await contents.executeJavaScript('(document.body?.innerText ?? "").slice(0, 12000)')); }
        catch { await new Promise(resolve => setTimeout(resolve, 275)); }
      }
      throw Error('周大福官网报价加载超时或不可用');
    } finally {
      clearTimeout(deadlineTimer);
      signal.removeEventListener('abort', cancel);
      cancel();
    }
  }

  async function probeInternet() {
    if (fixture || checkingInternet || osOffline || disposed) return;
    checkingInternet = true;
    try {
      await Promise.any(['https://gold-api.com/', 'https://precious.smm.cn/'].map(url => fetcher(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) })));
      const recovered = internetOffline;
      internetOffline = false;
      if (recovered && !osOffline && !disposed) void tick('reconnect');
    } catch { internetOffline = true; }
    finally { checkingInternet = false; publish(); }
  }
  function checkNetwork(resumed = false) {
    if (disposed) return;
    const wasOffline = osOffline;
    osOffline = fixture ? false : !net.isOnline();
    if (osOffline !== wasOffline) publish();
    if (osOffline) return;
    if (internetOffline) void probeInternet();
    else if (resumed || wasOffline) void tick(wasOffline ? 'reconnect' : 'resume');
  }
  function scheduleTick() {
    timer = setTimeout(() => {
      if (disposed) return;
      checkNetwork(); void tick('timer'); scheduleTick();
    }, 3000 - Date.now() % 3000);
    timer.unref?.();
  }
  function update(action, payload) {
    if (disposed) throw Error('金价服务已关闭');
    if (action === 'pin') store.setSetting('pinned', !(store.getSetting('pinned') ?? true));
    else if (action === 'layout') { if (typeof payload !== 'boolean') throw Error('金价布局参数无效'); store.setSetting('combined', payload); }
    else if (action === 'currency') { if (!CURRENCIES.includes(payload)) throw Error('金价币种参数无效'); store.setSetting('currency', payload); }
    else if (action === 'view') { if (!['quotes', 'outlook'].includes(payload)) throw Error('金价页面参数无效'); view = payload; }
    else if (action === 'edge') store.setSetting('edgeEnabled', !(store.getSetting('edgeEnabled') ?? true));
    else throw Error('未知金价设置');
    publish(); return snapshot();
  }
  async function openSource(key) {
    if (typeof key !== 'string' || !Object.hasOwn(LINKS, key)) throw Error('未知金价来源');
    if (!fixture) await shell.openExternal(LINKS[key]);
    return true;
  }
  async function openEvent(url) {
    if (typeof url !== 'string' || !url.startsWith('https://') || !(scheduler.forecastCache?.events ?? []).some(item => item.url === url)) throw Error('未知金价事件链接');
    if (!fixture) await shell.openExternal(url);
    return true;
  }
  const resume = () => checkNetwork(true);
  powerMonitor.on('resume', resume);
  nativeTheme.on('updated', publish);
  scheduleTick();
  const ready = tick('startup');
  return {
    snapshot, update, publish, openSource, openEvent, checkNetwork, ready,
    getSetting: key => store.getSetting(key),
    setPosition: position => { if (!disposed) store.setSetting('position', position); },
    setDockSide: side => { dockSide = side; publish(); },
    subscribe: callback => { observers.add(callback); return () => observers.delete(callback); },
    dispose() {
      if (disposed) return;
      disposed = true; clearTimeout(timer);
      powerMonitor.removeListener('resume', resume); nativeTheme.removeListener('updated', publish);
      scheduler.stop(); lifetime.abort(); observers.clear(); store.close();
    },
  };
}

module.exports = { createGoldService, resourceDirectory, hostTheme };
