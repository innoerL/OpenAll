(() => {
  'use strict';
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const panels = [
    '.settings-viewport', '.search-panel', '.clipboard-shelf',
    '.editor-toolbar', '.editor-formatter-footer', '.aux-tool', '.translation-state',
    '.context-selection', '.paste-queue', '.preview-page', '.comparison-document .toolbar',
    '.comparison-document .heading'
  ].join(',');

  const effects = window.OpenAllSurfaceEffects.install({
    panels,
    dark: () => document.documentElement.dataset.theme === 'dark',
    buttons: 'button:not(:disabled)'
  });

  // 始终保留同一个指示器。快速切换时从屏幕上的两端继续，文字按钮无需重建。
  function sidebarIndicator(sidebar) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const capsule = document.createElementNS(svg.namespaceURI, 'path');
    svg.classList.add('settings-indicator');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.append(capsule);
    sidebar.append(svg);
    let frame = 0, active = null, top = 0, bottom = 0;
    function draw(start, end) {
      top = start;
      bottom = end;
      const mid = (start + end) / 2;
      // 指示器两端饱满，中段随拉伸变窄；收拢时重新合成一条完整胶囊。
      const inset = Math.min(2.4, Math.max(0, end - start - 20) / 15);
      capsule.setAttribute('d', [
        `M 1 ${start + 3} a 3 3 0 0 1 6 0`,
        `C 7 ${mid} ${7 - inset} ${mid - 4} ${7 - inset} ${mid}`,
        `S 7 ${mid} 7 ${end - 3} a 3 3 0 0 1 -6 0`,
        `C 1 ${mid} ${1 + inset} ${mid + 4} ${1 + inset} ${mid}`,
        `S 1 ${mid} 1 ${start + 3} Z`
      ].join(' '));
    }
    function move(link, animate) {
      if (!link) return;
      const target = link.offsetTop + (link.offsetHeight - 20) / 2;
      if (active === link && animate) return;
      cancelAnimationFrame(frame);
      if (!active || !animate || reduced.matches || matchMedia('(forced-colors: active)').matches) {
        active = link;
        draw(target, target + 20);
        return;
      }
      active = link;
      const fromTop = top, fromBottom = bottom;
      const downward = target + 10 >= (fromTop + fromBottom) / 2;
      const startTime = performance.now();
      const ease = n => 1 - (1 - Math.max(0, Math.min(1, n))) ** 3;
      function tick(now) {
        const t = (now - startTime) / 600;
        const lead = ease(t / .80), trail = ease((t - .14) / .86);
        draw(fromTop + (target - fromTop) * (downward ? trail : lead),
          fromBottom + (target + 20 - fromBottom) * (downward ? lead : trail));
        if (t < 1) frame = requestAnimationFrame(tick);
      }
      frame = requestAnimationFrame(tick);
    }
    const settle = () => move(active, false);
    const resize = new ResizeObserver(settle);
    resize.observe(sidebar);
    reduced.addEventListener('change', settle);
    return { move, dispose() {
      cancelAnimationFrame(frame);
      resize.disconnect();
      reduced.removeEventListener('change', settle);
    } };
  }
  window.addEventListener('openall-theme', effects.refresh);
  window.OpenAllMaterial = { sidebarIndicator, refresh: effects.refresh };
})();
