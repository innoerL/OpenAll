// 使用独立用户目录和真实 Windows 桌面，覆盖正常启动路径和系统剪贴板。
const { app, BrowserWindow, clipboard } = require('electron');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { NativeBridge } = require('../src/native-services');

assert.equal(process.platform, 'win32');
assert.notEqual(process.env.OPENALL_TEST_MODE, '1');
assert.notEqual(process.env.OPENALL_CI_SMOKE, '1');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'openall-desktop-check-')));
require('../src/main');

const exec = promisify(execFile);
const driver = new NativeBridge();
const watchdog = setTimeout(() => app.exit(1), 100000);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(label, read, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await pause(40);
  }
  throw new Error(label + '超时');
}
const evaluate = (win, fn, ...args) => win.webContents.executeJavaScript(`(${fn})(...${JSON.stringify(args)})`);
const page = name => until('加载 ' + name, async () => {
  const window = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('?page=' + name));
  return window && await evaluate(window, () => !!window.OpenAllApp?.ready).catch(() => false) && window;
}, 25000);
async function desktopState(focus = false) {
  const script = path.join(__dirname, 'clipboard-desktop-windows.ps1');
  const flags = focus ? ['-Focus'] : [];
  const result = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...flags],
    {windowsHide:true, timeout:12000});
  return JSON.parse(result.stdout);
}

app.whenReady().then(async () => {
  let exitCode = 1;
  try {
    const search = await page('search');
    await until('加载应用原生助手', () => evaluate(search, () => openall.diagnostics().then(info => info.nativeReady)), 50000);
    driver.start();
    await driver.waitUntilReady();
    const marker = 'OpenAll Windows desktop clipboard check ' + process.pid;
    clipboard.writeText(marker);
    await until('捕获真实剪贴板文本', () => evaluate(search, text => openall.history().then(rows => rows[0]?.text === text), marker));
    const openClipboard = () => evaluate(search, () => openall.windowAction('showClipboard'));

    await openClipboard();
    const shelf = await page('clipboard');
    await until('剪贴板窗口获得焦点', () => shelf.isFocused());
    const outside = new BrowserWindow({show:false});
    await outside.loadURL('about:blank');
    outside.show();
    outside.focus();
    await until('原生焦点移到另一窗口后抽屉收起', () => outside.isFocused() && !shelf.isVisible());
    console.log('PASS Windows 窗口失焦后剪贴板自动收起');
    outside.destroy();

    for (const window of BrowserWindow.getAllWindows()) window.hide();
    const before = await desktopState(true);
    assert.notEqual(before.shell, '0', '运行器需要真实的资源管理器桌面');
    assert.notEqual(before.icons, '0', '需要桌面图标视图');
    assert.equal(before.iconsVisible, true, '回车前桌面图标视图可见');
    const desktopFocused = () => driver.request('foreground').then(info => info.handle !== '0' && info.shellSurface);
    await until('真实桌面成为 Windows 前台', desktopFocused);
    await openClipboard();
    await until('最左记录单选且有焦点', async () => shelf.isFocused() && await evaluate(shelf, () => {
      const first = document.querySelector('.clip-card');
      return first === document.activeElement && first.getAttribute('aria-selected') === 'true';
    }));
    // 从前台触发实际 Enter 路径，写回系统剪贴板并检查桌面图标窗口。
    const request = NativeBridge.prototype.request;
    const pasteRequests = [];
    NativeBridge.prototype.request = function (action, ...args) {
      if (action === 'paste') pasteRequests.push(args[0]);
      return request.call(this, action, ...args);
    };
    try {
      clipboard.clear();
      shelf.webContents.sendInputEvent({type:'keyDown', keyCode:'Enter'});
      shelf.webContents.sendInputEvent({type:'keyUp', keyCode:'Enter'});
      await until('桌面回车后抽屉收起', () => !shelf.isVisible());
      assert.equal(clipboard.readText(), marker);
      const after = await desktopState();
      assert.deepEqual(after, before, '桌面图标窗口仍是同一个可见窗口');
      assert.equal(pasteRequests.length, 0, '桌面回车没有发送系统粘贴请求');
    } finally {
      NativeBridge.prototype.request = request;
    }
    await openClipboard();
    await until('回车之后可以再次唤出抽屉', () => shelf.isVisible() && shelf.isFocused());
    console.log('PASS Windows 真实桌面回车仅复制、桌面图标视图保持可见、无需重启可再次唤出');
    exitCode = 0;
  } catch (error) {
    console.error(error.stack);
  } finally {
    clearTimeout(watchdog);
    driver.stop();
    app.exit(exitCode);
  }
});
