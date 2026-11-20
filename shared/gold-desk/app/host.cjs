const { BrowserWindow, ipcMain, net, powerMonitor, screen, shell, systemPreferences } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('./store.cjs');
const { Scheduler } = require('./scheduler.cjs');
const { createSources } = require('./sources.cjs');
const { CURRENCIES } = require('./currency.cjs');
const { EdgeDock, RAIL_WIDTH, RAIL_HEIGHT } = require('./edge-dock.cjs');
const { readOfficialCtf } = require('./ctf-official.cjs');
const { LINKS } = require('./links.cjs');
const { migrateLegacyData } = require('./migrate.cjs');
const PREFIX = 'openall-gold:';
const DARK_BACKGROUND = '#0d0c0a';

// 两个平台共用同一取价、预测与浮窗实现；这里只管理本工具的资源。
async function createGoldTool({ dataDirectory, legacyDirectory, icon, onWindow = () => {}, fixture = false }) {
  fs.mkdirSync(dataDirectory, { recursive: true });
  const filename = path.join(dataDirectory, 'quotes.sqlite');
  const imported = fixture ? false : await migrateLegacyData(filename, legacyDirectory);
  const store = new Store(filename);
  const sample = fixture ? require('./fixture.cjs').createFixture() : null;
  const clock = sample?.clock ?? Date.now;
  const lifetime = new AbortController();
  const handlers = [];
  const listeners = [];
  let window = null;
  let edgeDock = null;
  let timer;
  let disposed = false;
  let view = 'quotes';
  let osOffline = fixture ? false : !net.isOnline();
  let internetOffline = false;
  let checkingInternet = false;
  let lastPublished;

  const online = () => !osOffline && !internetOffline;
  const snapshot = () => ({
    ...scheduler.snapshot(),
    pinned: store.getSetting('pinned') ?? true,
    dark: store.getSetting('dark') ?? false,
    edgeEnabled: store.getSetting('edgeEnabled') ?? true,
    combined: Boolean(store.getSetting('combined')),
    dockSide: edgeDock?.side ?? null,
    imported,
  });
  const publish = () => {
    if (disposed) return;
    // 即使窗口关闭，也生成快照，从而保存当天正式展望与验证记录。
    const state = snapshot();
    const next = JSON.stringify(state);
    if (next === lastPublished) return;
    lastPublished = next;
    if (window && !window.isDestroyed()) window.webContents.send(PREFIX + 'snapshot', state);
  };
  const fetcher = (url, options = {}) => net.fetch(url, {
    ...options,
    signal: options.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal,
  });
  const scheduler = new Scheduler({
    store, clock, online, publish,
    sources: sample?.sources ?? createSources(fetcher, clock, () => readOfficialCtf({ signal: lifetime.signal })),
    onConnectionError: () => { checkNetwork(); void probeInternet(); },
  });
  const tick = reason => scheduler.tick(reason).catch(error => {
    if (!disposed) console.error('金价更新任务失败', error);
  });

  async function probeInternet() {
    if (fixture || checkingInternet || osOffline || disposed) return;
    checkingInternet = true;
    try {
      await Promise.any(['https://gold-api.com/', 'https://precious.smm.cn/'].map(url =>
        fetcher(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) })));
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
      checkNetwork();
      void tick('timer');
      scheduleTick();
    }, 3000 - Date.now() % 3000);
    timer.unref?.();
  }

  function windowPlacement(combined = Boolean(store.getSetting('combined')), current) {
    const previous = store.getSetting('position');
    const display = previous ? screen.getDisplayMatching({ ...previous, width: 450, height: 100 }) : screen.getPrimaryDisplay();
    const area = display.workArea;
    const width = Math.min(current?.width ?? 462, area.width);
    const height = Math.min(view === 'outlook' ? 735 : combined ? 612 : 826, area.height);
    const x = Math.min(Math.max(previous?.x ?? area.x + area.width - width - 28, area.x), area.x + area.width - width);
    const y = Math.min(Math.max(previous?.y ?? area.y + 32, area.y), area.y + area.height - height);
    return { x, y, width, height };
  }

  function createWindow() {
    view = 'quotes';
    const dark = store.getSetting('dark') ?? false;
    const current = new BrowserWindow({
      ...windowPlacement(), minWidth: 345, minHeight: 396, frame: false, show: false,
      alwaysOnTop: store.getSetting('pinned') ?? true,
      title: 'OpenAll · 金价', backgroundColor: dark ? DARK_BACKGROUND : '#f5f3ec',
      autoHideMenuBar: true, icon: icon ?? path.join(__dirname, 'icon.png'),
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    window = current;
    lastPublished = undefined;
    const rail = new BrowserWindow({
      width: RAIL_WIDTH, height: RAIL_HEIGHT, title: 'OpenAll 金价贴边条', frame: false,
      transparent: true, hasShadow: false, resizable: false, movable: false, focusable: false,
      skipTaskbar: true, alwaysOnTop: true, show: false,
      webPreferences: { preload: path.join(__dirname, 'edge-rail.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    rail.setOpacity(0);
    for (const item of [current, rail]) {
      item.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      item.webContents.on('will-navigate', event => event.preventDefault());
    }
    const railLoaded = rail.loadFile(path.join(__dirname, 'edge-rail.html')).then(() => true, error => {
      console.error('加载金价贴边条失败', error); return false;
    });
    const savePosition = ({ x, y }) => { if (!disposed) store.setSetting('position', { x, y }); };
    const dock = new EdgeDock({
      window: current, rail, screen, enabled: false,
      preferences: () => ({ pinned: store.getSetting('pinned') ?? true }),
      persistPosition: savePosition,
      motion: (side, collapsed) => {
        if (!current.isDestroyed()) current.webContents.send(PREFIX + 'edge-motion', side, collapsed);
      },
      reducedMotion: () => systemPreferences.getAnimationSettings().prefersReducedMotion,
    });
    edgeDock = dock;
    current.once('ready-to-show', async () => {
      if (disposed || current.isDestroyed()) return;
      current.show();
      if (await railLoaded && !disposed && !current.isDestroyed()) dock.setEnabled(store.getSetting('edgeEnabled') ?? true);
    });
    current.on('move', () => { if (!dock.collapsed) savePosition(current.getBounds()); });
    current.once('closed', () => {
      dock.stop();
      if (!rail.isDestroyed()) rail.destroy();
      if (window === current) { window = null; edgeDock = null; }
    });
    onWindow(current);
    void current.loadFile(path.join(__dirname, 'index.html')).catch(error => {
      if (!disposed) console.error('加载金价界面失败', error);
    });
    return current;
  }

  const trusted = event => !disposed && window && !window.isDestroyed() &&
    event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
  function handle(name, action) {
    const channel = PREFIX + name;
    ipcMain.handle(channel, (event, ...args) => {
      if (!trusted(event)) throw new Error('金价操作仅允许金价窗口调用');
      return action(...args);
    });
    handlers.push(channel);
  }
  function listen(name, action, allow = trusted) {
    const channel = PREFIX + name;
    const listener = (event, ...args) => { if (allow(event)) action(...args); };
    ipcMain.on(channel, listener);
    listeners.push([channel, listener]);
  }
  handle('read-snapshot', snapshot);
  handle('pin', () => {
    const pinned = !(store.getSetting('pinned') ?? true);
    store.setSetting('pinned', pinned); edgeDock.syncOnTop(); return pinned;
  });
  handle('layout', combined => {
    if (typeof combined !== 'boolean') return Boolean(store.getSetting('combined'));
    store.setSetting('combined', combined);
    edgeDock.reflow(windowPlacement(combined, window.getBounds())); return combined;
  });
  handle('theme', () => {
    const dark = !(store.getSetting('dark') ?? false);
    store.setSetting('dark', dark);
    window.setBackgroundColor(dark ? DARK_BACKGROUND : '#f5f3ec'); return dark;
  });
  handle('view', target => {
    view = target === 'outlook' ? 'outlook' : 'quotes';
    edgeDock.reflow(windowPlacement(undefined, window.getBounds())); return view;
  });
  handle('edge-setting', () => {
    const enabled = !(store.getSetting('edgeEnabled') ?? true);
    store.setSetting('edgeEnabled', enabled); edgeDock.setEnabled(enabled); return enabled;
  });
  handle('currency', currency => {
    if (CURRENCIES.includes(currency)) store.setSetting('currency', currency);
    publish(); return snapshot();
  });
  listen('rail-expand', () => edgeDock?.expand(), event => !disposed && edgeDock &&
    !edgeDock.rail.isDestroyed() && event.sender === edgeDock.rail.webContents &&
    event.senderFrame === edgeDock.rail.webContents.mainFrame);
  listen('minimize', () => window?.minimize());
  listen('quit-window', close);
  listen('recheck-network', () => checkNetwork());
  listen('source-link', key => { if (Object.hasOwn(LINKS, key)) void shell.openExternal(LINKS[key]); });
  listen('event-link', url => {
    if (typeof url === 'string' && url.startsWith('https://') &&
      (scheduler.forecastCache?.events ?? []).some(item => item.url === url)) void shell.openExternal(url);
  });
  const resume = () => checkNetwork(true);
  powerMonitor.on('resume', resume);
  scheduleTick();
  const ready = tick('startup');

  function show() {
    if (disposed) throw new Error('金价工具已关闭');
    if (!window || window.isDestroyed()) return createWindow();
    if (window.isMinimized()) window.restore();
    edgeDock?.expand();
    window.show(); window.focus();
    return window;
  }
  function close() { if (window && !window.isDestroyed()) window.close(); }
  function dispose() {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    powerMonitor.removeListener('resume', resume);
    scheduler.stop();
    lifetime.abort();
    edgeDock?.stop();
    if (window && !window.isDestroyed()) window.destroy();
    for (const channel of handlers) ipcMain.removeHandler(channel);
    for (const [channel, listener] of listeners) ipcMain.removeListener(channel, listener);
    store.close();
  }
  return { show, close, dispose, snapshot, ready, get window() { return window; } };
}

module.exports = { createGoldTool };
