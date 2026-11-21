(() => {
  'use strict';

  function install() {
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    const highContrast = matchMedia('(forced-colors: active), (prefers-contrast: more)');

    function press(event) {
      if (event.button !== 0 || !event.isPrimary || reducedMotion.matches || highContrast.matches) return;
      const button = event.target.closest?.('button');
      if (!button || button.matches(':disabled,[aria-disabled="true"]')) return;
      button.querySelector(':scope > .oa-ripple')?.remove();
      if (getComputedStyle(button).position === 'static') button.classList.add('oa-effect-anchor');
      const layer = document.createElement('span');
      layer.className = 'oa-ripple';
      layer.setAttribute('aria-hidden', 'true');
      button.append(layer);
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

    document.addEventListener('pointerdown', press, { capture: true, passive: true });
  }

  window.OpenAllSurfaceEffects = { install };
})();
