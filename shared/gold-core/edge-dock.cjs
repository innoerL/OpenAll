const RAIL_WIDTH = 16;
const RAIL_HEIGHT = 68;
const SNAP_DISTANCE = 18;
const HOVER_DELAY = 80;
const HIDE_DELAY = 340;
const RAIL_INSET = 2;

function edgeSide(bounds, area, distance = SNAP_DISTANCE) {
  const left = Math.abs(bounds.x - area.x);
  const right = Math.abs(bounds.x + bounds.width - area.x - area.width);
  if (Math.min(left, right) > distance) return null;
  return left <= right ? 'left' : 'right';
}

function edgeBounds(bounds, area, side) {
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  const x = side === 'left' ? area.x : area.x + area.width - width;
  const y = Math.min(Math.max(bounds.y, area.y), area.y + area.height - height);
  return { x, y, width, height };
}

function railBounds(panel, area, side) {
  const x = side === 'left' ? area.x : area.x + area.width - RAIL_WIDTH;
  const height = Math.min(RAIL_HEIGHT, area.height);
  const y = Math.round(panel.y + (panel.height - height) / 2);
  return { x, y: Math.min(Math.max(y, area.y), area.y + area.height - height), width: RAIL_WIDTH, height };
}

function contains(point, bounds, horizontal = 0, vertical = horizontal) {
  return point.x >= bounds.x - horizontal && point.y >= bounds.y - vertical &&
    point.x < bounds.x + bounds.width + horizontal && point.y < bounds.y + bounds.height + vertical;
}

function smoothStep(progress) {
  return progress * progress * (3 - 2 * progress);
}

class EdgeDock {
  constructor({ window, rail, screen, enabled, preferences, persistPosition, motion, reducedMotion, clock = () => performance.now() }) {
    Object.assign(this, { window, rail, screen, enabled, preferences, persistPosition, motion, reducedMotion, clock });
    this.side = null;
    this.goal = 1;
    this.progress = 1;
    this.hoverSince = null;
    this.leftSince = null;
    this.moving = false;

    window.on('will-move', () => {
      if (this.collapsed) return;
      this.moving = true;
      this.leftSince = null;
      clearTimeout(this.snapTimer);
      this.snapTimer = setTimeout(() => {
        this.moving = false;
        this.checkPlacement();
      }, 415);
    });
    window.on('minimize', () => {
      this.goal = 1;
      this.finishTransition();
    });
    window.on('restore', () => this.poll());
    window.on('closed', () => this.stop());
    this.timer = setInterval(() => this.poll(), 50);
  }

  get collapsed() {
    return this.goal === 0;
  }

  area(bounds) {
    return this.screen.getDisplayMatching(bounds).workArea;
  }

  checkPlacement() {
    if (!this.enabled || this.collapsed || this.window.isMinimized()) return;
    const bounds = this.window.getBounds();
    this.side = edgeSide(bounds, this.area(bounds), this.side ? 34 : SNAP_DISTANCE);
    this.leftSince = null;
    if (this.side) {
      this.collapse(true);
    } else {
      this.syncOnTop();
      this.motion?.(null, false);
    }
  }

  setEnabled(value) {
    this.enabled = value;
    if (!value) {
      if (this.collapsed) this.expand();
      this.side = null;
      this.leftSince = null;
      this.syncOnTop();
      this.motion?.(null, false);
    } else this.checkPlacement();
  }

  syncOnTop() {
    this.window.setAlwaysOnTop(Boolean(this.side) || this.preferences().pinned, 'floating');
  }

  reflow(newBounds) {
    if (this.collapsed) return;
    this.window.setBounds(this.side ? edgeBounds(newBounds, this.area(newBounds), this.side) : newBounds);
  }

  collapse(first = false) {
    if (!this.side || this.collapsed || this.window.isMinimized()) return;
    const current = this.window.getBounds();
    const area = this.area(current);
    const full = edgeBounds(current, area, this.side);
    const hotspot = railBounds(full, area, this.side);
    if (full.x !== current.x || full.y !== current.y) this.window.setBounds(full);
    this.rail.setBounds(hotspot);
    this.persistPosition(full);
    this.hoverSince = null;
    this.leftSince = null;
    this.requireExit = first && contains(this.screen.getCursorScreenPoint(), hotspot);
    this.transition(0);
  }

  expand() {
    if (!this.collapsed) return;
    this.leftSince = null;
    this.hoverSince = null;
    this.transition(1);
  }

  transition(goal) {
    clearTimeout(this.frameTimer);
    this.goal = goal;
    this.motion?.(this.side, goal === 0);
    if (goal) {
      this.window.setIgnoreMouseEvents(false);
      this.syncOnTop();
      this.window.showInactive();
      if (this.side) this.window.moveTop();
    } else {
      this.window.setIgnoreMouseEvents(true);
      this.rail.showInactive();
    }
    const from = this.progress;
    const distance = Math.abs(goal - from);
    const duration = this.reducedMotion?.() ? 0 : (goal ? 240 : 215) * distance;
    if (!duration) {
      this.finishTransition();
      return;
    }

    const start = this.clock();
    const frame = () => {
      const elapsed = Math.min(1, (this.clock() - start) / duration);
      this.applyOpacity(from + (goal - from) * smoothStep(elapsed));
      if (elapsed === 1) this.finishTransition();
      else this.frameTimer = setTimeout(frame, 16);
    };
    frame();
  }

  applyOpacity(value) {
    this.progress = value;
    this.window.setOpacity(value);
    this.rail.setOpacity(1 - value);
  }

  finishTransition() {
    clearTimeout(this.frameTimer);
    this.applyOpacity(this.goal);
    if (this.goal) {
      this.rail.hide();
      this.window.setIgnoreMouseEvents(false);
      this.syncOnTop();
      this.motion?.(this.side, false);
    } else {
      this.window.hide();
    }
  }

  poll() {
    if (!this.side || this.moving || this.window.isDestroyed() || this.window.isMinimized()) return;
    const cursor = this.screen.getCursorScreenPoint();
    const now = this.clock();
    if (this.collapsed) {
      const inside = contains(cursor, this.rail.getBounds(), RAIL_INSET, 0);
      if (!inside) this.requireExit = false;
      this.hoverSince = inside && !this.requireExit ? this.hoverSince ?? now : null;
      if (this.hoverSince !== null && now - this.hoverSince >= HOVER_DELAY) this.expand();
    } else {
      const inside = contains(cursor, this.window.getBounds(), 5);
      this.leftSince = inside ? null : this.leftSince ?? now;
      if (this.leftSince !== null && now - this.leftSince >= HIDE_DELAY) this.collapse();
    }
  }

  stop() {
    clearTimeout(this.snapTimer);
    clearTimeout(this.frameTimer);
    clearInterval(this.timer);
  }
}

module.exports = { EdgeDock, edgeSide, edgeBounds, railBounds, smoothStep, RAIL_WIDTH, RAIL_HEIGHT };
