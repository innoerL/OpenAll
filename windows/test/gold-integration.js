const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
process.env.OPENALL_TEST_MODE = '1';
const output = path.resolve(process.env.OPENALL_GOLD_TEST_OUTPUT || path.join(__dirname, '../artifacts/gold'));
fs.mkdirSync(output, { recursive: true });
require('../src/main');
const watchdog = setTimeout(() => { console.error('金价集成回归超时'); app.exit(1); }, 90000);
app.whenReady().then(async () => {
  const report = { passed: false, platform: process.platform, electron: process.versions.electron, checks: [], screenshots: [] };
  try {
    let search;
    const started = Date.now();
    while (!search) {
      for (const win of BrowserWindow.getAllWindows()) {
        if (await win.webContents.executeJavaScript('!!window.OpenAllApp?.ready && window.OpenAllApp.page === "search"').catch(() => false)) { search = win; break; }
      }
      if (Date.now() - started > 20000) throw Error('OpenAll 搜索初始化超时');
      if (!search) await new Promise(resolve => setTimeout(resolve, 35));
    }
    Object.assign(report, await require('../src/gold-check')(search, output), { passed: true });
  } catch (error) { Object.assign(report, error.goldReport); report.error = error.stack; console.error(error.stack); }
  finally {
    clearTimeout(watchdog); fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    app.once('will-quit', () => app.exit(report.passed ? 0 : 1));
    app.quit();
  }
});
