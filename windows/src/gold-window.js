const { BrowserWindow, screen, systemPreferences } = require('electron');
const path = require('node:path');
const { resourceDirectory } = require('./gold-service');

function placement(service, current) {
  const previous = service.getSetting('position');
  const display = previous ? screen.getDisplayMatching({ ...previous, width: 450, height: 100 }) : screen.getPrimaryDisplay();
  const area = display.workArea, state = service.snapshot();
  const width = Math.min(current?.width ?? 462, area.width);
  const height = Math.min(state.view === 'outlook' ? 735 : state.combined ? 612 : 826, area.height);
  const x = Math.min(Math.max(current?.x ?? previous?.x ?? area.x + area.width - width - 28, area.x), area.x + area.width - width);
  const y = Math.min(Math.max(current?.y ?? previous?.y ?? area.y + 32, area.y), area.y + area.height - height);
  return { x, y, width, height };
}

// 主窗口由 createWindow 注册；这里只附加金价的原生行为及宿主所有的贴边条。
function attachGoldWindow(window, service, onAuxiliary) {
  const { EdgeDock, RAIL_WIDTH, RAIL_HEIGHT } = require(path.join(resourceDirectory('gold-core'), 'edge-dock.cjs'));
  const rail = new BrowserWindow({ width: RAIL_WIDTH, height: RAIL_HEIGHT, title: 'OpenAll 金价贴边条', frame: false,
    transparent: true, hasShadow: false, resizable: false, movable: false, focusable: false,
    skipTaskbar: true, alwaysOnTop: true, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, additionalArguments: ['--openall-page=gold-rail'] },
  });
  onAuxiliary(rail);
  rail.setOpacity(0);
  rail.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  rail.webContents.on('will-navigate', event => event.preventDefault());
  let stopped = false, visible = false;
  const savePosition = ({ x, y }) => service.setPosition({ x, y });
  const dock = new EdgeDock({ window, rail, screen, enabled: false,
    preferences: () => ({ pinned: service.getSetting('pinned') ?? true }), persistPosition: savePosition,
    motion: (side, collapsed) => {
      service.setDockSide(side);
      if (!window.isDestroyed()) window.webContents.send('openall:gold-edge', side, collapsed);
    },
    reducedMotion: () => systemPreferences.getAnimationSettings().prefersReducedMotion,
  });
  const unsubscribe = service.subscribe(state => {
    if (!window.isDestroyed()) {
      window.setBackgroundColor(state.theme.background);
      window.webContents.send('openall:gold-snapshot', state);
    }
    if (!rail.isDestroyed()) rail.webContents.send('openall:gold-rail-theme', state.theme);
  });
  const ready = rail.loadFile(path.join(__dirname, 'gold-edge-rail.html')).then(() => true, error => { console.error('加载金价贴边条失败', error); return false; });
  window.on('move', () => { if (!dock.collapsed) savePosition(window.getBounds()); });
  window.once('closed', dispose);
  function dispose() {
    if (stopped) return;
    stopped = true; unsubscribe(); dock.stop();
    if (!rail.isDestroyed()) rail.destroy();
    service.setDockSide(null);
  }
  return {
    rail, ready, dispose,
    expand: () => dock.expand(),
    async show() {
      if (window.isMinimized()) window.restore();
      dock.expand(); window.show(); window.focus();
      if (!visible) { visible = true; if (await ready && !stopped) dock.setEnabled(service.getSetting('edgeEnabled') ?? true); }
    },
    update(action) {
      if (action === 'pin') dock.syncOnTop();
      else if (action === 'edge') dock.setEnabled(service.getSetting('edgeEnabled') ?? true);
      else if (action === 'layout' || action === 'view') dock.reflow(placement(service, window.getBounds()));
    },
  };
}

module.exports = { placement, attachGoldWindow };
