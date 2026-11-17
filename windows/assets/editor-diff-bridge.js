// 只接受所属父窗口消息；系统剪贴板通过顶层预加载桥接执行。
window.addEventListener('message', event => {
  if (event.source !== window.parent || !event.data?.openallComparison) return;
  const message = event.data;
  if (message.action === 'setTexts') window.setTexts(message.left || '', message.right || '');
  if (message.action === 'paste') window.compareV2.pasteText(String(message.text || ''));
  if (message.action === 'focus') window.compareV2.focus(message.side || 0);
  if (message.action === 'copied') window.compareV2.copied(message.side || 0);
  if (message.action === 'theme') window.setOpenAllV2Theme(message.theme || {});
});
window.parent.postMessage({ openallComparison: true, action: 'ready' }, '*');
