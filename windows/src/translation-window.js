'use strict';
const { WebContentsView, session, shell } = require('electron');
const URL = 'https://fanyi.youdao.com/index.html#/TextTranslate';
const views = new WeakMap();
function isTranslationURL(value) { try { const parsed = new global.URL(value); return parsed.protocol === 'https:' && (parsed.hostname === 'youdao.com' || parsed.hostname.endsWith('.youdao.com')); } catch { return false; } }

// 外部翻译页独立隔离，不继承 OpenAll 的预加载脚本、IPC 或文件访问权限。
function createTranslationView(window, options = {}) {
  let view, isolatedSession, downloadBlocker, pending = '', phase = 'idle', timer, readinessTimer, disposed = false, generation = 0, top = 46;
  const fixture = options.testMode && options.fixtureURL;
  const address = fixture || URL;
  const state = () => ({ phase, pending: !!pending, url: URL, title: phase === 'failed' ? '暂时无法连接有道翻译' : phase === 'slow' ? '网页加载缓慢，请稍候…' : '正在连接有道翻译', detail: phase === 'failed' ? '请检查网络连接，或在浏览器中继续。' : '连接完成后，即可输入或粘贴内容进行翻译。' });
  function change(next) { phase = next; if (view && !disposed) view.setVisible(next === 'ready'); }
  function clear() { clearTimeout(timer); clearTimeout(readinessTimer); }
  function layout(bounds) { if (bounds && Number.isFinite(bounds.y)) top = Math.max(0, Math.min(100, Math.round(bounds.y))); if (view && !disposed && !window.isDestroyed()) { const [width, height] = window.getContentSize(); view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) }); } }
  function failed() { if (disposed) return; clear(); change('failed'); }
  function permitted(value) { return fixture ? value === fixture || value === 'about:blank' : isTranslationURL(value); }
  function ensureView() {
    if (view || disposed || options.testMode && !fixture) return;
    const isolated = isolatedSession = session.fromPartition(options.partition || (options.testMode ? 'openall-translation-test' : 'persist:openall-translation'));
    isolated.setPermissionRequestHandler((contents, permission, callback) => callback(permission === 'clipboard-sanitized-write' && isTranslationURL(contents.getURL())));
    isolated.setPermissionCheckHandler((_contents, permission, origin) => permission === 'clipboard-sanitized-write' && isTranslationURL(origin));
    view = new WebContentsView({ webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webSecurity: true, allowRunningInsecureContent: false, safeDialogs: true, disableDialogs: true, backgroundThrottling: false, navigateOnDragDrop: false } });
    window.contentView.addChildView(view); view.setVisible(false); layout();
    const contents = view.webContents;
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event, target) => { if (!permitted(target || event.url)) event.preventDefault(); });
    contents.on('will-redirect', (event, target, _place, mainFrame) => { if (mainFrame && !permitted(target || event.url)) { event.preventDefault(); failed(); } });
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.on('will-prevent-unload', event => event.preventDefault());
    contents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => { if (mainFrame && code !== -3) failed(); });
    contents.on('render-process-gone', failed);
    contents.on('did-finish-load', () => waitForPage(generation, 35));
    contents.on('before-input-event', (event, input) => { if (input.type === 'keyDown' && input.key === 'Escape') { event.preventDefault(); window.close(); } });
    downloadBlocker = (event, _item, source) => { if (source === contents) event.preventDefault(); };
    isolated.on('will-download', downloadBlocker);
  }
  const fieldScript = `(() => { const direct = document.querySelector('#js_fanyi_input'); if (direct && !direct.disabled) return direct; return [...document.querySelectorAll('textarea,[contenteditable="true"],input[type="text"]')].filter(x => x.offsetWidth > 100 && x.offsetHeight > 20 && !x.disabled).sort((a,b) => a.getBoundingClientRect().left-b.getBoundingClientRect().left)[0]; })()`;
  async function fill(version, attempts = 35) {
    if (disposed || generation !== version || !pending || !view || view.webContents.isDestroyed()) return;
    const text = pending;
    const script = `(() => { ${fixture ? '' : "if(location.hash!=='#/TextTranslate'){location.hash='#/TextTranslate';return false;}"} const text=${JSON.stringify(text)},field=${fieldScript}; if(!field)return false;field.focus();if(field.isContentEditable)field.textContent=text;else{const setter=Object.getOwnPropertyDescriptor(field.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value')?.set;setter?.call(field,text);}field.dispatchEvent(new InputEvent('input',{bubbles:true,data:text,inputType:'insertText'}));field.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`;
    const filled = await view.webContents.executeJavaScript(script, true).catch(() => false);
    if (disposed || version !== generation) return;
    if (filled && text === pending) pending = '';
    else if (attempts > 0) timer = setTimeout(() => fill(version, attempts - 1), 700);
  }
  async function waitForPage(version, remaining) {
    if (disposed || version !== generation || phase === 'failed') return;
    const ready = await view.webContents.executeJavaScript(`!!(${fieldScript}) || (document.body?.innerText?.length || 0) > 80`).catch(() => false);
    if (disposed || version !== generation || phase === 'failed') return;
    if (ready) {
      clearTimeout(readinessTimer); change('ready');
      if (window.getSize()[0] < 960 && !options.testMode) { window.setSize(1080, 700); window.center(); }
      layout(); fill(version); return;
    }
    if (remaining > 0) timer = setTimeout(() => waitForPage(version, remaining - 1), 700);
    else { clearTimeout(readinessTimer); change('slow'); }
  }
  function load() {
    clear(); const version = ++generation; change('loading'); ensureView();
    if (options.testMode && !fixture) { change('failed'); return state(); }
    readinessTimer = setTimeout(() => { if (!disposed && version === generation && phase !== 'ready') change('slow'); }, 35000);
    view.webContents.loadURL(address).catch(error => { if (!disposed && generation === version && error.code !== 'ERR_ABORTED') failed(); }); return state();
  }
  async function paste(text) {
    text = String(text || ''); if (!text) return false;
    if (phase !== 'ready' || !view) { pending = text; if (phase === 'failed') load(); return true; }
    return view.webContents.executeJavaScript(`(() => { const text=${JSON.stringify(text)}; let field=document.activeElement; if(!field?.matches('textarea,input[type="text"],[contenteditable="true"]'))field=${fieldScript};if(!field)return false;field.focus();if(field.isContentEditable){if(!document.execCommand('insertText',false,text))return false;}else{field.setRangeText(text,field.selectionStart??field.value.length,field.selectionEnd??field.value.length,'end');field.dispatchEvent(new InputEvent('input',{bubbles:true,data:text,inputType:'insertFromPaste'}));}return true;})()`, true).catch(() => false);
  }
  function dispose() { if (disposed) return; disposed = true; clear(); window.removeListener('resize', resized); if (isolatedSession && downloadBlocker) isolatedSession.removeListener('will-download', downloadBlocker); if (view) { try { window.contentView.removeChildView(view); } catch {} if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false }); } }
  const resized = () => layout(); window.on('resize', resized); window.once('closed', dispose);
  return { state, layout, retry: load, paste,
    show(text) { pending = String(text || ''); if (phase === 'ready') fill(generation); else load(); return state(); },
    focus() { if (phase === 'ready' && view) view.webContents.focus(); },
    getSelection: async () => view && !view.webContents.isDestroyed() ? view.webContents.executeJavaScript(`(() => { const e=document.activeElement; return e&&typeof e.selectionStart==='number'?e.value.slice(e.selectionStart,e.selectionEnd):getSelection().toString(); })()`).catch(() => '') : '',
    browser: () => shell.openExternal(URL), dispose,
    webContents: () => view?.webContents
  };
}

// main 的 window-action 仅在本地 translate 页面路由到这里；不向外部网页暴露该入口。
async function translationAction(window, payload = {}, options = {}) {
  let controller = views.get(window);
  if (payload.command === 'attach') { if (!controller) { controller = createTranslationView(window, options); views.set(window, controller); } controller.layout(payload.bounds); return controller.show(payload.text); }
  if (!controller) return { phase: 'idle' };
  switch (payload.command) {
    case 'status': return controller.state();
    case 'retry': return controller.retry();
    case 'layout': controller.layout(payload.bounds); return true;
    case 'paste': return controller.paste(payload.text);
    case 'selection': return controller.getSelection();
    case 'focus': controller.focus(); return true;
    case 'browser': await controller.browser(); return true;
    case 'release': controller.dispose(); views.delete(window); return true;
    default: throw Error('未知翻译操作');
  }
}
module.exports = { URL, isTranslationURL, createTranslationView, translationAction };
