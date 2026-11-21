const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('宿主外观保持原色，语义文字及两种曲线可辨识', () => {
  const values = new Map();
  const element = { dataset: {}, style: { setProperty: (key, value) => values.set(key, value) } };
  const context = vm.createContext({ window: {}, document: { documentElement: element } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../gold-ui/theme.js'), 'utf8'), context);
  const theme = context.window.OpenAllGoldTheme;
  for (const background of ['#242626', '#172838', '#30251f', '#f2f1ed', '#ffffff', '#000000', '#ed99aa', '#53a6aa']) {
    for (const accent of ['#d8c19e', '#5e9ccd', '#63b8a4', '#d9917b']) {
      theme.apply({ background, surface: background, accent });
      assert.equal(values.get('--background'), background);
      assert.equal(values.get('--accent'), accent);
      for (const key of ['rise', 'fall', 'flat', 'accent-ink']) {
        assert.ok(theme.contrast(values.get(`--${key}`), background) >= 4.5, `${key} / ${background}`);
      }
      for (const key of ['gold-line', 'ctf-line']) {
        assert.ok(theme.contrast(values.get(`--${key}`), background) >= 3.5, `${key} / ${background}`);
      }
      assert.notEqual(values.get('--gold-line'), values.get('--ctf-line'));
      assert.equal(new Set(['rise', 'fall', 'flat'].map(key => values.get(`--${key}`))).size, 3);
      theme.apply({ background, surface: background, accent, glass: true });
      assert.equal(element.dataset.glass, 'true');
      assert.equal(new Set(['rise', 'fall', 'flat'].map(key => values.get('--' + key))).size, 3);
      assert.notEqual(values.get('--gold-line'), values.get('--ctf-line'));
      const ground = values.get('--glass-ground');
      for (const [tint, alpha] of [['#65a9b0', .28], ['#bd8564', .26]]) {
        const artwork = theme.blend(ground, tint, alpha);
        const card = theme.blend(artwork, '#ffffff', .15);
        for (const key of ['glass-ink', 'secondary', 'rise', 'fall', 'flat']) {
          assert.ok(theme.contrast(values.get('--' + key), card) >= 4.5, `玻璃卡片 ${key} / ${background}`);
        }
      }
    }
  }
});
