const { app, dialog } = require('electron');
const path = require('node:path');
const { createGoldTool } = require('./host.cjs');
const { helperDataDirectory } = require('./data-location.cjs');

// macOS 原生宿主使用内置辅助进程；Windows 直接调用 host.cjs。
app.setName('OpenAll 金价');
const fixture = process.env.OPENALL_GOLD_FIXTURE === '1';
const dataDirectory = helperDataDirectory(app.getPath('appData'), app.commandLine.getSwitchValue('user-data-dir'), fixture);
app.setPath('userData', dataDirectory);
let tool;
let parentTimer;
let ready;
const parent = Number(app.commandLine.getSwitchValue('openall-parent-pid'));

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { void ready?.then(() => tool?.show()); });
  app.on('activate', () => tool?.show());
  app.on('window-all-closed', () => {});
  app.on('before-quit', () => { clearInterval(parentTimer); tool?.dispose(); });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => app.quit());
  ready = app.whenReady().then(async () => {
    tool = await createGoldTool({
      dataDirectory,
      legacyDirectory: path.join(app.getPath('appData'), 'GoldDesk'),
      fixture,
    });
    tool.show();
    if (Number.isInteger(parent) && parent > 1) {
      parentTimer = setInterval(() => {
        try { process.kill(parent, 0); }
        catch (error) { if (error.code === 'ESRCH') app.quit(); }
      }, 2000);
      parentTimer.unref();
    }
    if (app.commandLine.hasSwitch('openall-gold-check')) {
      if (!fixture) throw new Error('金价界面检查必须使用隔离样例');
      await require('./ui-check.cjs').verifyGoldTool(tool, process.env.OPENALL_GOLD_CHECK_OUTPUT);
      app.quit();
    }
  }).catch(error => {
    console.error('启动 OpenAll 金价失败', error);
    if (!fixture && !(Number.isInteger(parent) && parent > 1)) dialog.showErrorBox('无法打开金价工具', error.message);
    tool?.dispose();
    app.exit(1);
  });
}
