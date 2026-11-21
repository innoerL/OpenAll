(() => {
  'use strict';

  function install({ panels, dark, buttons = 'button:not(:disabled)' }) {
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    const highContrast = matchMedia('(forced-colors: active), (prefers-contrast: more)');
    const finePointer = matchMedia('(any-hover: hover) and (any-pointer: fine)');
    let active = null, frame = 0, clientX = 0, clientY = 0;

    function overlay(host, className) {
      if (getComputedStyle(host).position === 'static') host.classList.add('oa-effect-anchor');
      const layer = document.createElement('span');
      layer.className = 'oa-effect-clip ' + className;
      layer.setAttribute('aria-hidden', 'true');
      host.append(layer);
      return layer;
    }

    function fade() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      if (!active) return;
      const { layer } = active;
      active = null;
      layer.classList.remove('oa-visible');
      // 窗口隐藏或系统禁用动效时，也能清理即将离开的图层。
      setTimeout(() => layer.remove(), 160);
    }

    function draw() {
      frame = 0;
      if (!active) return;
      const bounds = active.layer.getBoundingClientRect();
      active.spot.style.transform = 'translate(' + (clientX - bounds.left) + 'px,' + (clientY - bounds.top) + 'px)';
      active.layer.classList.add('oa-visible');
    }

    function move(event) {
      if (event.pointerType !== 'mouse' || !finePointer.matches || reducedMotion.matches || highContrast.matches || !dark()) {
        fade();
        return;
      }
      const host = event.target.closest?.(panels);
      if (!host) { fade(); return; }
      if (active?.host !== host || !active.layer.isConnected) {
        fade();
        // 快速移出再移入时只保留当前光晕，避免几圈径向光叠加。
        host.querySelector(':scope > .oa-halo')?.remove();
        const layer = overlay(host, 'oa-halo');
        const spot = document.createElement('span');
        spot.className = 'oa-halo-spot';
        layer.append(spot);
        active = { host, layer, spot };
      }
      clientX = event.clientX;
      clientY = event.clientY;
      if (!frame) frame = requestAnimationFrame(draw);
    }

    function press(event) {
      if (event.button !== 0 || !event.isPrimary || reducedMotion.matches || highContrast.matches) return;
      const button = event.target.closest?.(buttons);
      if (!button || button.matches(':disabled,[aria-disabled="true"]')) return;
      button.querySelector(':scope > .oa-ripple')?.remove();
      const layer = overlay(button, 'oa-ripple');
      const bounds = layer.getBoundingClientRect();
      const x = event.clientX - bounds.left, y = event.clientY - bounds.top;
      const radius = Math.hypot(Math.max(x, bounds.width - x), Math.max(y, bounds.height - y));
      const circle = document.createElement('span');
      const diameter = Math.max(1, radius / 2);
      Object.assign(circle.style, {
        width: diameter + 'px', height: diameter + 'px',
        left: (x - diameter / 2) + 'px', top: (y - diameter / 2) + 'px',
      });
      circle.className = 'oa-ripple-circle';
      layer.append(circle);
      circle.addEventListener('animationend', () => layer.remove(), { once: true });
      setTimeout(() => layer.remove(), 660);
    }

    document.addEventListener('pointermove', move, { passive: true });
    document.addEventListener('pointerout', event => {
      if (active && !active.host.contains(event.relatedTarget)) fade();
    }, { passive: true });
    document.addEventListener('pointerdown', press, { capture: true, passive: true });
    window.addEventListener('blur', fade);
    document.addEventListener('visibilitychange', fade);
    document.addEventListener('scroll', fade, { capture: true, passive: true });
    for (const query of [reducedMotion, highContrast, finePointer]) query.addEventListener('change', fade);
    return { refresh() { if (!dark()) fade(); } };
  }

  window.OpenAllSurfaceEffects = { install };
})();
