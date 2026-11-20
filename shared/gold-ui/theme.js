(() => {
  const parse = color => {
    const hex = /^#([\da-f]{6})$/i.exec(color ?? '');
    if (hex) return [0, 2, 4].map(index => parseInt(hex[1].slice(index, index + 2), 16));
    const rgb = /^rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)/.exec(color ?? '');
    return rgb ? rgb.slice(1).map(Number) : [128, 128, 128];
  };
  const hex = values => '#' + values.map(value => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')).join('');
  const blend = (a, b, fraction) => hex(parse(a).map((value, index) => value * (1 - fraction) + parse(b)[index] * fraction));
  const luminance = value => parse(value).map(c => { c /= 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; }).reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
  const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
  function readable(color, surface, minimum = 4.5) {
    if (contrast(color, surface) >= minimum) return color;
    const target = contrast('#ffffff', surface) > contrast('#000000', surface) ? '#ffffff' : '#000000';
    for (let ratio = .05; ratio <= 1; ratio += .05) {
      const candidate = blend(color, target, ratio);
      if (contrast(candidate, surface) >= minimum) return candidate;
    }
    return target;
  }
  function apply(theme = {}) {
    const background = theme.background || '#242626';
    const surface = theme.surface || '#1e2020';
    const dark = theme.dark ?? luminance(background) < .3;
    const foreground = theme.foreground || (dark ? '#f3f1eb' : '#202222');
    const accent = theme.accent || '#d8c19e';
    // 系列、涨跌与持平使用独立语义色，始终与宿主表面保持可辨识的对比。
    const gold = readable(dark ? '#d8b879' : '#28755f', surface, 3.5);
    const ctf = readable(dark ? '#9eb9da' : '#9a572e', surface, 3.5);
    const colors = {
      background, surface, foreground, accent,
      secondary: readable(theme.secondary || '#999d98', surface),
      border: theme.border || blend(surface, foreground, .13),
      'accent-ink': readable(accent, surface), 'accent-soft': blend(surface, accent, .13),
      raised: blend(surface, foreground, .07), 'chart-grid': blend(surface, foreground, .13),
      'gold-line': gold, 'ctf-line': ctf,
      rise: readable(dark ? '#ef9f90' : '#ac303e', surface),
      fall: readable(dark ? '#8fcbb0' : '#1d7350', surface),
      flat: readable(dark ? '#c4c9cd' : '#52606a', surface),
    };
    for (const [key, value] of Object.entries(colors)) document.documentElement.style.setProperty('--' + key, value);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    return colors;
  }
  window.OpenAllGoldTheme = { apply, contrast, blend };
})();
