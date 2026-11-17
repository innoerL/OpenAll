const { app, BrowserWindow } = require('electron');
const path = require('node:path');
process.env.OPENALL_TEST_MODE = '1';
require('../src/main');
const watchdog = setTimeout(() => { console.error('外观回归超时'); app.exit(1); }, 90000);
app.whenReady().then(async () => {
  let win;
  for (let n = 0; n < 400; n++) {
    win = BrowserWindow.getAllWindows().find(w => new URL(w.webContents.getURL() || 'about:blank').searchParams.get('page') === 'search');
    if (win && await win.webContents.executeJavaScript('!!window.OpenAllApp?.ready').catch(() => false)) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const report = await require('../src/appearance-check')(win, path.resolve(process.env.OPENALL_APPEARANCE_OUTPUT || 'artifacts/appearance'));
  console.log('外观与标题栏回归通过：' + report.checks.length + ' 项');
  clearTimeout(watchdog); app.isQuitting = true; app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
