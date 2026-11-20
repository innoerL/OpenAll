const { BrowserWindow } = require('electron');
const { parseOfficialCtf } = require('./sources.cjs');

const CTF_PAGE = 'https://www.ctfmall.com/todaygold';
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function readOfficialCtf({ signal } = {}) {
  signal?.throwIfAborted();
  const page = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'golddesk-public-ctf',
      backgroundThrottling: false,
    },
  });
  const contents = page.webContents;
  const cancel = () => { if (!page.isDestroyed()) page.destroy(); };
  signal?.addEventListener('abort', cancel, { once: true });
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event) => event.preventDefault());

  // 官网报价由公开页面的脚本渲染；只从隔离浏览窗口读取可见文本。
  const loaded = page.loadURL(CTF_PAGE);
  let succeeded = true;
  const navigation = loaded.catch(() => { succeeded = false; });
  const deadline = Date.now() + 17_000;
  let deadlineTimer;
  try {
    await Promise.race([
      new Promise((resolve) => contents.once('dom-ready', resolve)),
      navigation,
      new Promise((resolve) => { deadlineTimer = setTimeout(resolve, 16_000); }),
    ]);
    while (succeeded && Date.now() < deadline && !contents.isDestroyed() && contents.getURL() === CTF_PAGE) {
      try {
        const visible = await contents.executeJavaScript('(document.body?.innerText ?? "").slice(0, 12000)');
        return parseOfficialCtf(visible);
      } catch {
        await delay(275);
      }
    }
    throw new Error('周大福官网报价加载超时或不可用');
  } finally {
    clearTimeout(deadlineTimer);
    signal?.removeEventListener('abort', cancel);
    if (!page.isDestroyed()) page.destroy();
  }
}

module.exports = { CTF_PAGE, readOfficialCtf };
