/* 按 macOS OpenAllTheme 的比例派生各表面；一次计算完整快照，避免切换外观后残留旧颜色。 */
(function (root, factory) {
  const theme = factory();
  if (typeof module === 'object' && module.exports) module.exports = theme;
  else root.OpenAllTheme = theme;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  const validHex = value => typeof value === 'string' && /^#[a-f\d]{6}$/i.test(value);
  const hex = (value, fallback) => validHex(value) ? value.toLowerCase() : fallback;
  const rgb = value => [1, 3, 5].map(at => parseInt(value.slice(at, at + 2), 16));
  const luminance = value => rgb(value).reduce((sum, component, index) => sum + component / 255 * [.2126, .7152, .0722][index], 0);
  const mix = (base, target, fraction) => '#' + rgb(base).map((component, index) => Math.round(component * (1 - fraction) + rgb(target)[index] * fraction).toString(16).padStart(2, '0')).join('');

  function palette(settings = {}, systemLight = false) {
    let canvas = settings.theme === 'system' ? (systemLight ? '#f2f2ef' : '#242626') : hex(settings.backgroundHex, '#242626');
    // 旧默认值沿用已有迁移规则；用户显式选择的相同颜色不改写。
    if (settings.theme === 'dark' && canvas === '#1b1c1d') canvas = '#242626';
    const light = luminance(canvas) > .55, opposite = light ? '#000000' : '#ffffff';
    const accent = hex(settings.accentHex, '#d8c19e');
    // AppKit calibrated 色转为 sRGB 后的常量，与 Mac 原生文字保持一致。
    const ink = light ? '#1e1e1e' : '#f3f1eb', muted = light ? '#747474' : '#acb0ac';
    const editor = mix(canvas, light ? '#ffffff' : '#000000', light ? .45 : .16);
    const vars = {
      '--canvas': canvas, '--sidebar': mix(canvas, opposite, .025), '--surface': mix(canvas, opposite, .052),
      '--raised': mix(canvas, opposite, .095), '--editor': editor, '--ink': ink, '--muted': muted,
      '--secondary': mix(ink, editor, .26), '--accent': accent,
      '--accent-text': light && luminance(accent) > .42 ? mix(accent, '#000000', .46) : accent,
      '--on-accent': luminance(accent) > .55 ? '#1a1a1a' : '#ffffff',
      '--rule': light ? 'rgba(0,0,0,.12)' : 'rgba(255,255,255,.085)',
      '--comparison-rule': light ? 'rgba(0,0,0,.09)' : 'rgba(255,255,255,.065)',
      '--selection': accent + '1c', '--editor-selection': accent + '59'
    };
    return { light, glass: settings.glass === true, vars };
  }

  function comparison(vars, light, glass = false) {
    const theme = { light, glass };
    for (const name of ['canvas', 'raised', 'ink', 'muted', 'secondary']) theme[name] = vars['--' + name];
    theme.surface = vars['--editor'];
    theme.accent = vars['--accent-text'];
    theme.rule = vars['--comparison-rule'];
    return theme;
  }

  function apply(document, value) {
    const root = document.documentElement, mode = value.light ? 'light' : 'dark';
    for (const [key, color] of Object.entries(value.vars)) root.style.setProperty(key, color);
    root.style.colorScheme = mode;
    root.dataset.theme = mode;
    root.dataset.material = value.glass ? 'glass' : 'solid';
    document.body.classList.toggle('light', value.light);
  }
  return { palette, comparison, apply };
});
