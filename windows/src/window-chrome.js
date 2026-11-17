(() => {
  'use strict';
  const api = window.openall, chrome = document.getElementById('chrome');
  const controls = chrome.querySelector('.window-controls');
  const maximize = controls.querySelector('.window-maximize');
  function sync(state = {}) {
    const expanded = !!state.maximized;
    chrome.classList.toggle('maximized', expanded);
    maximize.disabled = state.resizable === false;
    maximize.title = expanded ? '还原' : '最大化';
    maximize.setAttribute('aria-label', maximize.title);
  }
  controls.querySelector('.window-minimize').onclick = () => api.windowAction('minimize');
  maximize.onclick = () => api.windowAction('maximize');
  controls.querySelector('.window-close').onclick = () => api.windowAction('close');
  // 双击窗口按钮不应触发标题栏的最大化切换。
  chrome.addEventListener('dblclick', event => {
    if (!event.target.closest('.window-controls') && !maximize.disabled) api.windowAction('maximize');
  });
  api.onWindowState(sync);
  api.windowAction('windowState').then(sync);
})();
