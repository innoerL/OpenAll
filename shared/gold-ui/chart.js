(() => {
'use strict';
const $ = (selector, root = document) => root.querySelector(selector);
const amount = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const whole = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const percent = new Intl.NumberFormat('zh-CN', {
  style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: 'exceptZero',
});
const displayTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const dateTick = new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', year: 'numeric', month: '2-digit' });
const UNITS = { USD: '美元', EUR: '欧元', CNY: '人民币元' };
const DAY = 86_400_000;
const SERIES = { gold: '现货', ctf: '周大福' };
const FORECAST_LABELS = { up: '预计涨', down: '预计跌', flat: '预计维持' };
function chartBounds(values) {
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = high - low || Math.abs(high) * .04 || 1;
  const step = 10 ** Math.floor(Math.log10(span / 2));
  const interval = Math.ceil(span / 2 / step) * step;
  const minimum = Math.floor(low / interval) * interval;
  const maximum = Math.ceil(high / interval) * interval;
  return [minimum, Math.max(maximum, minimum + interval)];
}

class Chart {
  constructor(card) {
    this.canvas = $('canvas', card);
    this.label = $('.hover', card);
    this.empty = $('.chart-empty', card);
    this.context = this.canvas.getContext('2d');
    new ResizeObserver(() => this.paint()).observe(this.canvas);
    this.canvas.addEventListener('pointermove', (event) => this.pick(event.offsetX));
    this.canvas.addEventListener('pointerleave', () => this.select(null));
    this.canvas.addEventListener('blur', () => this.select(null));
    this.canvas.addEventListener('keydown', (event) => this.onKey(event));
  }

  update(series, since, today, dualAxis, state) {
    const signature = JSON.stringify([series, since, today, dualAxis]);
    if (this.signature !== signature) {
      this.signature = signature;
      this.dualAxis = dualAxis;
      this.first = Date.parse(since);
      this.last = Math.max(Date.parse(today), this.first + DAY);
      this.selected = null;
      this.series = series.map(({ id, rows, unit }) => ({
        id, name: SERIES[id], unit, byTime: new Map(rows.filter(({ date, price }) => Number.isFinite(Date.parse(date)) && Number.isFinite(price)).map(({ date, price }) => [Date.parse(date), price]).sort((a, b) => a[0] - b[0])),
      }));
      this.times = [...new Set(this.series.flatMap(({ byTime }) => [...byTime.keys()]))].sort((a, b) => a - b);
      this.paint();
    }
    this.paint();
    this.empty.hidden = this.times.length > 0;
    this.empty.textContent = state === 'loading' ? '读取历史数据…' : '暂无历史数据';
  }

  horizontal(time) {
    return this.left + (time - this.first) / (this.last - this.first) * this.plotWidth;
  }

  vertical(price, [minimum, maximum]) {
    return 6 + (maximum - price) / (maximum - minimum) * (this.height - 12);
  }

  paint() {
    const { width, height } = this.canvas.getBoundingClientRect();
    if (!width || !height) return;
    this.height = height;
    const density = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(width * density);
    this.canvas.height = Math.round(height * density);
    const draw = this.context;
    draw.scale(density, density);
    if (!this.times?.length) {
      this.label.hidden = true;
      return;
    }

    const prices = this.series.flatMap(({ byTime }) => [...byTime.values()]);
    const theme = getComputedStyle(document.documentElement);
    for (const line of this.series) {
      line.accent = theme.getPropertyValue(`--${line.id}-line`).trim();
      line.fill = line.accent;
    }
    const shared = this.dualAxis ? null : chartBounds(prices);
    const axes = this.series.map(({ byTime }) => shared || (byTime.size ? chartBounds([...byTime.values()]) : null));
    draw.font = '9px system-ui, sans-serif';
    const axisWidth = (axis) => axis ? Math.max(30, draw.measureText(whole.format(axis[1])).width + 7) : 7;
    this.left = axisWidth(axes[0]);
    const right = width - (this.dualAxis ? axisWidth(axes[1]) : 5);
    this.plotWidth = right - this.left;

    for (const tick of [0, .5, 1]) {
      const y = 6 + tick * (height - 12);
      for (const [index, axis] of axes.entries()) {
        if (!axis || (!this.dualAxis && index > 0)) continue;
        const [min, max] = axis;
        draw.textAlign = index ? 'right' : 'left';
        draw.fillStyle = this.dualAxis ? this.series[index].accent : theme.getPropertyValue('--secondary').trim();
        draw.fillText(whole.format(max - tick * (max - min)), index ? width - 1 : 0, y + 3);
      }
      draw.strokeStyle = theme.getPropertyValue('--chart-grid').trim();
      draw.lineWidth = 1;
      draw.beginPath();
      draw.moveTo(this.left, y);
      draw.lineTo(right, y);
      draw.stroke();
    }

    this.series.forEach((serie, index) => {
      if (axes[index]) this.paintSeries(serie, axes[index]);
    });
    this.paintSelection(width);
  }

  paintSeries(serie, axis) {
    const draw = this.context;
    const runs = [];
    for (const [time, price] of serie.byTime) {
      const run = runs.at(-1);
      const point = { time, x: this.horizontal(time), y: this.vertical(price, axis) };
      if (!run || time - run.at(-1).time > 4 * DAY) runs.push([point]);
      else run.push(point);
    }
    const wash = draw.createLinearGradient(0, 0, 0, this.height);
    wash.addColorStop(0, serie.fill + '30');
    wash.addColorStop(1, serie.fill + '00');
    for (const points of runs) {
      if (points.length === 1) {
        draw.beginPath();
        draw.arc(points[0].x, points[0].y, 2, 0, Math.PI * 2);
        draw.fillStyle = serie.accent;
        draw.fill();
        continue;
      }
      if (this.series.length === 1) {
        draw.beginPath();
        draw.moveTo(points[0].x, this.height - 5);
        for (const { x, y } of points) draw.lineTo(x, y);
        draw.lineTo(points.at(-1).x, this.height - 5);
        draw.closePath();
        draw.fillStyle = wash;
        draw.fill();
      }
      draw.beginPath();
      draw.moveTo(points[0].x, points[0].y);
      for (const { x, y } of points.slice(1)) draw.lineTo(x, y);
      draw.strokeStyle = serie.accent;
      draw.lineWidth = this.series.length === 1 ? 1.5 : 1.75;
      draw.lineJoin = 'round';
      // 合并曲线同时用线型区分，避免只依赖颜色。
      draw.setLineDash(serie.id === 'ctf' && this.series.length > 1 ? [5, 3] : []);
      draw.stroke();
      draw.setLineDash([]);
    }
  }

  paintSelection(width) {
    const time = this.times[this.selected];
    this.label.hidden = !Number.isFinite(time);
    if (this.label.hidden) return;
    const draw = this.context;
    const x = this.horizontal(time);
    draw.beginPath();
    draw.moveTo(x, 4);
    draw.lineTo(x, this.height - 4);
    draw.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--secondary').trim();
    draw.lineWidth = 1;
    draw.stroke();
    const date = new Date(time).toISOString().slice(0, 10);
    const prices = this.series.map(({ name, unit, byTime }) => {
      const price = byTime.get(time);
      return `${name} ${price === undefined ? '—' : amount.format(price) + ' ' + unit}`;
    });
    this.label.textContent = [date, ...prices].join('\n');
    this.label.style.left = `${Math.max(0, Math.min(width - this.label.offsetWidth, x + 8))}px`;
  }

  select(index) {
    if (index === this.selected) return;
    this.selected = index;
    this.paint();
  }

  onKey(event) {
    if (!this.times?.length || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const last = this.times.length - 1;
    const current = this.selected ?? last;
    if (event.key === 'Home') this.select(0);
    else if (event.key === 'End') this.select(last);
    else this.select(Math.max(0, Math.min(last, current + (event.key === 'ArrowLeft' ? -1 : 1))));
  }

  pick(x) {
    if (!this.times?.length) return;
    const target = this.first + (x - this.left) / this.plotWidth * (this.last - this.first);
    const nearest = this.times.reduce((best, time, index) =>
      Math.abs(target - time) < Math.abs(target - this.times[best]) ? index : best, 0);
    this.select(nearest);
  }
}

window.OpenAllGoldChart = Chart;
})();
