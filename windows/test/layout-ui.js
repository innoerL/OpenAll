const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
process.env.OPENALL_TEST_MODE = '1';
require('../src/main');
const output = path.resolve(process.env.OPENALL_LAYOUT_OUTPUT || '../work/windows-alignment/layout');
fs.mkdirSync(output, { recursive: true });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = (win, fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
async function page(id) {
  for (let n = 0; n < 400; n++) {
    const w = BrowserWindow.getAllWindows().find(w => new URL(w.webContents.getURL() || 'about:blank').searchParams.get('page') === id);
    if (w && await run(w, () => !!window.OpenAllApp?.ready).catch(() => false)) return w;
    await wait(25);
  }
  throw Error('页面加载超时：' + id);
}
app.whenReady().then(async () => {
  const search = await page('search');
  await run(search, () => openall.openTool('settings'));
  const settings = await page('settings');
  for (const theme of ['dark', 'light']) {
    await run(settings, theme => openall.saveSettings({ theme, backgroundHex: theme === 'dark' ? '#242626' : '#f2f2ef' }), theme);
    for (const tab of ['general', 'search', 'clipboard', 'linkAliases', 'commandAliases', 'snippets', 'permissions', 'diagnostics', 'appearance']) {
      await run(settings, id => OpenAllApp.controller.selectTab(id), tab); await wait(100);
      fs.writeFileSync(path.join(output, theme + '-' + tab + '.png'), (await settings.webContents.capturePage()).toPNG());
    }
  }
  console.log('设置深浅主题截图完成'); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
