const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Theme = require('../src/theme');

const dark = { theme: 'custom', backgroundHex: '#204060', accentHex: '#d8c19e' };
const light = { theme: 'custom', backgroundHex: '#e0e0e0', accentHex: '#d8c19e' };
const first = Theme.palette(dark);
assert.equal(first.light, false);
assert.equal(first.vars['--sidebar'], '#264564');
assert.equal(first.vars['--surface'], '#2c4a68');
assert.equal(first.vars['--raised'], '#35526f');
assert.equal(first.vars['--editor'], '#1b3651');
const pale = Theme.palette(light);
assert.equal(pale.light, true);
assert.equal(pale.vars['--surface'], '#d4d4d4');
assert.equal(pale.vars['--editor'], '#eeeeee');
assert.equal(pale.vars['--accent-text'], '#756855');
assert.equal(Theme.palette({ backgroundHex: '#8d8d8d' }).light, true, '深浅分界沿用 Mac 的 0.55');
assert.equal(Theme.palette({ backgroundHex: '#8c8c8c' }).light, false);
assert.equal(Theme.palette({ theme: 'system', backgroundHex: '#ffffff' }, false).vars['--canvas'], '#242626');
assert.equal(Theme.palette({ theme: 'system', backgroundHex: '#000000' }, true).vars['--canvas'], '#f2f2ef');
assert.equal(Theme.palette({ theme: 'dark', backgroundHex: '#1b1c1d' }).vars['--canvas'], '#242626');
assert.equal(Theme.palette({ theme: 'custom', backgroundHex: '#1b1c1d' }).vars['--canvas'], '#1b1c1d');
assert.deepEqual(Theme.palette({ backgroundHex: 'invalid', accentHex: 'red' }), Theme.palette({}));
assert.equal(Theme.palette({ accentHex: '#123456' }).vars['--on-accent'], '#ffffff');
assert.equal(first.vars['--on-accent'], '#1a1a1a');

function makeDocument() {
  const values = {}, classes = new Set();
  return { values, classes, documentElement: { style: { setProperty: (key, value) => values[key] = value }, dataset: {} }, body: { classList: { toggle: (name, state) => state ? classes.add(name) : classes.delete(name) } } };
}
const document = makeDocument();
const samples = [dark, light, { theme: 'custom', backgroundHex: '#30251f' }, { theme: 'system' }, light, dark];
for (let round = 0; round < 20; round++) {
  for (const settings of samples) {
    const value = Theme.palette(settings, round % 2 === 0);
    Theme.apply(document, value);
    assert.deepEqual(document.values, value.vars, '往返切换必须覆盖全部颜色，不能保留前一主题');
    assert.equal(document.documentElement.dataset.theme, value.light ? 'light' : 'dark');
    assert.equal(document.documentElement.style.colorScheme, value.light ? 'light' : 'dark');
    assert.equal(document.classes.has('light'), value.light);
    assert.notEqual(value.vars['--ink'], value.vars['--surface'], '输入文字与搜索底色不能相同');
    assert.notEqual(value.vars['--muted'], value.vars['--surface'], '占位文字与搜索底色不能相同');
  }
}
assert.deepEqual(document.values, first.vars, '恢复同一主题时全套表面色完全一致');

// 执行真实页面 bridge，验证首次 ready 与主题广播都映射到编辑表面，不改变正文。
async function verifyBridge() {
  const events = new Map(), messages = [], observers = [];
  const window = { OpenAllTheme: Theme, OpenAllPages: {}, addEventListener: (type, fn) => events.set(type, fn), removeEventListener: (type, fn) => { if (events.get(type) === fn) events.delete(type); } };
  const frame = { contentWindow: { postMessage: message => messages.push(message) }, remove() { this.removed = true; } };
  const host = { append() {} };
  const context = vm.createContext({ window, document: { ...document, baseURI: 'file:///openall/src/index.html' }, URL, setTimeout, clearTimeout, performance,
    getComputedStyle: () => ({ getPropertyValue: key => document.values[key] || '' }),
    MutationObserver: class { constructor(fn) { this.fn = fn; observers.push(this); } observe() {} disconnect() { this.stopped = true; } }
  });
  vm.runInContext(fs.readFileSync(require.resolve('../src/editor-pages'), 'utf8'), context);
  const loading = window.OpenAllPages.comparison(host, { h: () => frame, initialValue: { left: '左文', right: '右文' } });
  events.get('message')({ source: {}, data: { openallComparison: true, action: 'ready' } });
  assert.equal(messages.length, 0, '其他窗口不能冒充编辑器 ready');
  events.get('message')({ source: frame.contentWindow, data: { openallComparison: true, action: 'ready' } });
  const controller = await loading;
  assert.equal(messages[0].action, 'setTexts');
  assert.equal(messages[0].left, '左文');
  assert.equal(messages[0].right, '右文');
  for (const settings of samples) {
    const value = Theme.palette(settings, true);
    Theme.apply(document, value);
    events.get('openall-theme')({ detail: { ...value.vars, light: value.light } });
    const theme = messages.at(-1).theme;
    assert.deepEqual(theme, Theme.comparison(value.vars, value.light));
    assert.equal(theme.surface, value.vars['--editor']);
    assert.equal(theme.accent, value.vars['--accent-text']);
    assert.equal(theme.secondary, value.vars['--secondary']);
    assert.equal(theme.rule, value.vars['--comparison-rule']);
    // 属性观察回调与主题事件必须得到相同结果，不能依赖过期的 body class。
    document.classes.add('light');
    observers[0].fn();
    assert.deepEqual(messages.at(-1).theme, theme);
  }
  assert.equal(messages.filter(item => item.action === 'setTexts').length, 1, '换主题不能重新载入或覆盖编辑器正文');
  controller.dispose();
  assert.equal(events.has('openall-theme'), false);
  assert.equal(events.has('message'), false);
  assert.equal(observers[0].stopped, true);
  console.log('主题回归通过：Mac 表面派生、120 次深浅往返、系统主题、非法颜色回退、真实对比 bridge 与正文保留');
}
verifyBridge().catch(error => { console.error(error); process.exitCode = 1; });
