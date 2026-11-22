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

  function relativeLuminance(color) {
    return rgb(color).reduce((sum, channel, index) => {
      const value = channel / 255;
      const linear = value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
      return sum + linear * [.2126, .7152, .0722][index];
    }, 0);
  }

  function contrast(a, b) { return (Math.max(a, b) + .05) / (Math.min(a, b) + .05); }
  function readableText(preferred, backgrounds) {
    const levels = backgrounds.map(relativeLuminance);
    const score = color => Math.min(...levels.map(level => contrast(relativeLuminance(color), level)));
    if (score(preferred) >= 4.5) return preferred;
    const toward = score('#000000') >= score('#ffffff') ? '#000000' : '#ffffff';
    for (let step = 1; step < 10; step++) {
      const candidate = mix(preferred, toward, step / 10);
      if (score(candidate) >= 4.5) return candidate;
    }
    return toward;
  }

  function palette(settings = {}, systemLight = false) {
    let canvas = settings.theme === 'system' ? (systemLight ? '#f2f2ef' : '#242626') : hex(settings.backgroundHex, '#242626');
    // 旧默认值沿用已有迁移规则；用户显式选择的相同颜色不改写。
    if (settings.theme === 'dark' && canvas === '#1b1c1d') canvas = '#242626';
    const light = luminance(canvas) > .55, opposite = light ? '#000000' : '#ffffff';
    const accent = hex(settings.accentHex, '#d8c19e');
    // AppKit calibrated 色转为 sRGB 后的常量，与 Mac 原生文字保持一致。
    const ink = light ? '#1e1e1e' : '#f3f1eb', muted = light ? '#747474' : '#acb0ac';
    const editor = mix(canvas, light ? '#ffffff' : '#000000', light ? .45 : .16);
    const raised = mix(canvas, opposite, .095);
    const preferred = light && luminance(accent) > .42 ? mix(accent, '#000000', .46) : accent;
    const accentLevel = relativeLuminance(accent);
    const buttonText = contrast(accentLevel, 1) >= contrast(accentLevel, relativeLuminance('#1a1a1a')) ? '#ffffff' : '#1a1a1a';
    const vars = {
      '--canvas': canvas, '--sidebar': mix(canvas, opposite, .025), '--surface': mix(canvas, opposite, .052),
      '--raised': raised, '--editor': editor, '--ink': ink, '--muted': muted,
      '--secondary': mix(ink, editor, .26), '--accent': accent,
      '--accent-text': readableText(preferred, [canvas, raised, editor]),
      '--on-accent': readableText(buttonText, [accent]),
      '--rule': light ? 'rgba(0,0,0,.12)' : 'rgba(255,255,255,.085)',
      '--comparison-rule': light ? 'rgba(0,0,0,.09)' : 'rgba(255,255,255,.065)',
      '--selection': accent + '1c', '--editor-selection': accent + '59'
    };
    return { light, vars };
  }

  function comparison(vars, light) {
    const theme = { light };
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
    document.body.classList.toggle('light', value.light);
  }
  return { palette, comparison, apply };
});
