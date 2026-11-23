const {app, BrowserWindow} = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
process.env.OPENALL_TEST_MODE = '1';
require('../src/main');

setTimeout(() => { console.error('文件剪贴板集成回归超时'); app.exit(1); }, 45000).unref();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const execute = (win, fn, ...args) => win.webContents.executeJavaScript(`(${fn})(...${JSON.stringify(args)})`);
async function until(fn) {
  const start = Date.now();
  while (Date.now() - start < 10000) {
    const value = await fn();
    if (value) return value;
    await delay(25);
  }
  throw Error('等待剪贴板回归状态超时');
}

app.whenReady().then(async () => {
  const page = name => until(async () => {
    const win = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes('page=' + name));
    return win && await execute(win, () => !!window.OpenAllApp?.ready).catch(() => false) && win;
  });
  const search = await page('search');
  await execute(search, () => openall.windowAction('showClipboard'));
  const shelf = await page('clipboard');
  if (process.platform === 'darwin') app.focus({steal:true});
  shelf.focus();
  await until(() => BrowserWindow.getFocusedWindow() === shelf);
  const root = app.getPath('userData'), archive = path.join(root, '备份 #1.zip'), folder = path.join(root, '资料夹');
  const missing = path.join(root, '已删除.exe'), other = path.join(root, '第四项.txt');
  await fs.writeFile(archive, 'zip');
  await fs.mkdir(folder);
  const original = app.getFileIcon.bind(app);
  let releaseIcons;
  const gate = new Promise(resolve => { releaseIcons = resolve; });
  app.getFileIcon = async (...args) => { await gate; return original(...args); };
  const multiple = [folder, archive, missing, other];
  await execute(shelf, () => openall.clipboardAction('setLayout', {layout:'list'}));
  const history = await execute(shelf, async (one, many) => {
    await openall.windowAction('smokeFixture', {fileDrops:[one, many]});
    return openall.history();
  }, archive, multiple);
  assert.deepEqual(history.map(r => r.files), [multiple, [archive]]);
  releaseIcons();
  await until(() => execute(shelf, () => [...document.querySelectorAll('.clip-files')].length === 2
    && [...document.querySelectorAll('.clip-files')].every(row => !!row.querySelector('.clip-file-icon img'))));
  assert.ok(await execute(shelf, () => {
    const rows = [...document.querySelectorAll('.clip-files')], multi = rows.find(r => !r.classList.contains('single-file'));
    return multi.querySelector('.clip-file-name').textContent === '资料夹' && multi.querySelector('.clip-file-total').textContent === '共 4 项' &&
      multi.querySelectorAll('.clip-file-icon img').length === 1 && multi.querySelector('.clip-file-row:nth-child(2)').getBoundingClientRect().height === 0;
  }));
  await execute(shelf, () => openall.clipboardAction('setLayout', {layout:'cards'}));
  await until(() => execute(shelf, () => {
    const rows = [...document.querySelectorAll('.clip-files:not(.single-file) .clip-file-icon')];
    return rows[0]?.dataset.kind === 'folder' && !!rows[0].querySelector('img') && !!rows[1].querySelector('img') &&
      rows[2]?.dataset.kind === 'application' && !!rows[2].querySelector('svg') &&
      document.querySelector('.clip-file-rest')?.textContent === '另 1 项';
  }));
  await fs.unlink(archive);
  const restored = await execute(shelf, async id => {
    await openall.clipboardAction('copy', {ids:[id]});
    return openall.windowAction('smokeFixture', {readFiles:true});
  }, history[0].id);
  assert.deepEqual(restored, multiple);
  console.log('文件剪贴板通过连续快照、延迟图标、列表懒加载、卡片分类、缺失路径和文件列表回写回归');
  app.exit(0);
}).catch(error => { console.error(error.stack); app.exit(1); });
