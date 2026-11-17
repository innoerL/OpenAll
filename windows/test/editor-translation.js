const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createTranslationView, isTranslationURL } = require('../src/translation-window');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'OpenAll-translation-'));
app.setPath('userData', directory);
const output = path.resolve(process.env.OPENALL_EDITOR_TEST_OUTPUT || path.join(__dirname, '../artifacts/editor-translation'));
fs.mkdirSync(output, { recursive: true });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [];
const check = (value, message) => { assert.ok(value, message); checks.push(message); };
const watchdog = setTimeout(() => app.exit(1), 30000);
app.whenReady().then(async () => {
  let window, controller;
  try {
    check(isTranslationURL('https://fanyi.youdao.com/index.html') && !isTranslationURL('https://youdao.com.evil.test') && !isTranslationURL('file:///tmp/example'), '仅允许有道 HTTPS 顶层地址');
    window = new BrowserWindow({ width: 580, height: 320, show: false });
    await window.loadURL('data:text/html,<html><body>OpenAll</body></html>');
    controller = createTranslationView(window, { testMode: true });
    check(controller.show('本地测试，不发送到网络').phase === 'failed' && !controller.webContents(), '测试模式不会连接网络或创建外部页面');
    controller.dispose();
    const fixture = path.join(directory, 'translation-fixture.html');
    fs.writeFileSync(fixture, '<!doctype html><meta charset="utf-8"><textarea id="js_fanyi_input" style="width:400px;height:150px"></textarea><div id="result"></div><script>document.querySelector("textarea").oninput=e=>document.querySelector("#result").textContent=e.target.value;</script>');
    controller = createTranslationView(window, { testMode: true, fixtureURL: pathToFileURL(fixture).href, partition: 'test-translation-' + Date.now() });
    const text = '待翻译的中文\n<unsafe>"\\\n😀'; controller.show(text);
    const start = Date.now(); while (controller.state().phase !== 'ready' || controller.state().pending) { if (Date.now() - start > 10000) throw Error('翻译就绪超时'); await pause(20); }
    const remote = controller.webContents();
    check(await remote.executeJavaScript(`document.querySelector('textarea').value===${JSON.stringify(text)}&&document.querySelector('#result').textContent===${JSON.stringify(text)}`), '自动填入原文并触发输入事件，特殊字符不执行');
    check(await remote.executeJavaScript('typeof require === "undefined" && typeof window.openall === "undefined"'), '远端页没有 Node 或 OpenAll 预加载桥接');
    await remote.executeJavaScript('document.querySelector("textarea").focus();document.querySelector("textarea").setSelectionRange(0,3);');
    check(await controller.getSelection() === text.slice(0, 3), '读取内嵌翻译当前选区');
    check(await controller.paste('替换') && await remote.executeJavaScript('document.querySelector("textarea").value.startsWith("替换的中文")'), '剪贴板粘贴替换翻译页当前选区');
    controller.layout({ y: 46 }); window.setSize(800, 500); await pause(30);
    check(window.contentView.children.some(child => child.getBounds().y === 46 && child.getBounds().height === window.getContentSize()[1] - 46), '内嵌区域随窗口缩放且保留本地标题栏');
    controller.dispose(); const closedAt = Date.now(); while (!remote.isDestroyed() && Date.now() - closedAt < 2000) await pause(20); check(remote.isDestroyed(), '关闭翻译时销毁远端内容');
    const report = JSON.stringify({ passed: true, checks }, null, 2); console.log(report); fs.writeFileSync(path.join(output, 'translation-report.json'), report); clearTimeout(watchdog); window.destroy(); app.exit(0);
  } catch (error) { console.error(error.stack); fs.writeFileSync(path.join(output, 'translation-report.json'), JSON.stringify({ passed: false, checks, error: error.stack }, null, 2)); clearTimeout(watchdog); controller?.dispose(); window?.destroy(); app.exit(1); }
});
