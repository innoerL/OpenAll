window.OpenAllTheme.apply(document, window.OpenAllTheme.palette({ backgroundHex: "#242626" }));
window.testClipboard = '';
const h = (tag, attributes = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) { if (name.startsWith('on') && typeof value === 'function') node[name] = value; else if (value === true) node.setAttribute(name, ''); else if (value !== false && value != null) node.setAttribute(name, value); }
  for (const child of children.flat()) if (child != null) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
};
window.renderEditorTest = async (id, initialValue = '') => {
  window.controller?.dispose(); const root = document.getElementById('root'); root.replaceChildren();
  window.controller = await window.OpenAllPages[id](root, { h, button: (text, onclick, className = '') => h('button', { onclick, class: className }, text), api: { copyText: async text => window.testClipboard = text }, notify: text => window.testNotice = text, initialValue, settings: {} });
  return true;
};
