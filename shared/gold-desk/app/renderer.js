const desk = window.goldDesk;
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
let lastSnapshot;
let forecastInstrument = 'gold';
let preferredPin = true;
let dockSide = null;

function chartBounds(values) {
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = high - low || high * .04;
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
      this.last = Date.parse(today);
      this.selected = null;
      this.series = series.map(({ id, rows, unit }) => ({
        id, name: SERIES[id], unit, byTime: new Map(rows.map(({ date, price }) => [Date.parse(date), price])),
      }));
      this.times = [...new Set(this.series.flatMap(({ byTime }) => [...byTime.keys()]))].sort((a, b) => a - b);
      this.paint();
    }
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
      line.fill = theme.getPropertyValue(`--${line.id}-fill`).trim();
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
        draw.fillStyle = this.dualAxis ? this.series[index].accent : theme.getPropertyValue('--axis').trim();
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
    wash.addColorStop(0, serie.fill + 'd0');
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
      draw.stroke();
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
    draw.strokeStyle = '#65736b8a';
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

function updatePin(pinned) {
  preferredPin = pinned;
  const button = $('#pin');
  button.setAttribute('aria-pressed', Boolean(dockSide) || pinned);
  button.setAttribute('aria-disabled', Boolean(dockSide));
  button.title = dockSide ? '贴边展开时自动置顶' : pinned ? '取消置顶' : '窗口置顶';
}

function updateTheme(dark) {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const button = $('#theme');
  button.setAttribute('aria-pressed', dark);
  button.textContent = dark ? '☀' : '☾';
  const label = dark ? '切换浅色模式' : '切换黑色模式';
  button.title = label;
  button.setAttribute('aria-label', label);
  for (const chart of Object.values(charts)) chart.paint();
}

function updateEdgeMotion(side, collapsed) {
  dockSide = side;
  document.body.dataset.edgeSide = side ?? '';
  document.body.dataset.edgeCollapsing = collapsed;
  updatePin(preferredPin);
}

function updateView(view) {
  for (const id of ['quotes', 'outlook']) {
    $(`#${id}`).hidden = view !== id;
    $(`#${id}-view`).setAttribute('aria-pressed', view === id);
  }
}

function updateLayout(combined) {
  const button = $('#layout');
  button.setAttribute('aria-pressed', combined);
  button.textContent = combined ? '分开' : '合并';
  button.title = combined ? '分开显示报价卡和曲线' : '合并报价卡和曲线';
  $('#combined').hidden = !combined;
  $('#gold').hidden = combined;
  $('#ctf').hidden = combined;
}

function updateQuote(id, card, item, snapshot) {
  const { quote, status, retryAt, detail, waitingForFx } = item;
  const { today, online, currency } = snapshot;
  const done = status === 'done';
  const state = $('.state', card);
  const outOfDate = quote && quote.date !== today;
  const label = !online ? '等待联网' :
    status === 'loading' ? '正在取价' :
    status === 'retry' ? '等待重试' :
    waitingForFx ? '等待汇率' :
    done ? (quote?.note ? '休市时段' : outOfDate ? '上次报价' : '已更新') : '等待 10 点';
  state.dataset.tone = !online ? 'offline' : done && !outOfDate && !waitingForFx ? 'ok' : 'pending';
  $('span', state).textContent = label;
  $('.quote-price', card).textContent = quote ? (id === 'gold' ? amount : whole).format(quote.price) : '—';
  $('.unit', card).textContent = id === 'gold' ? `${UNITS[currency]} / 克` : '元 / 克';
  updateChanges(card, item.changes);
  updateSummary(id, card, snapshot.outlook.forecasts[id]);
  const dateLabel = quote?.quoteTime ? displayTime.format(new Date(quote.quoteTime)) : quote?.date;
  const priceTime = quote ? `${quote.note ? '最近报价' : id === 'gold' ? '行情时间' : quote.quoteTime ? '牌价时间' : '牌价日期'} ${dateLabel}` :
    waitingForFx ? '等待参考汇率' : '暂无有效报价';
  const retryLabel = retryAt && online ? ` · ${displayTime.format(new Date(retryAt))} 重试` : '';
  const fxLabel = quote?.fxDate ? ` · 汇率 ${quote.fxDate.slice(5).replace('-', '/')}` : '';
  const time = $('.quote-time', card);
  time.textContent = priceTime + fxLabel + retryLabel;
  time.title = detail ?? (quote ? `实际取价 ${displayTime.format(new Date(quote.fetchedAt))}` : '');
  const source = $('.quote-source', card);
  source.textContent = `报价 ${quote?.source ?? (id === 'gold' ? 'Gold API' : '周大福官方商城')}`;
  if (id === 'ctf') source.dataset.source = quote?.source === '金价网 · 金子银子' ? 'ctfFallback' : 'ctf';
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function updateSummary(id, card, outlook) {
  let summary = $('.week-summary', card);
  if (!summary) {
    summary = element('button', undefined, 'week-summary');
    summary.type = 'button';
    summary.append(
      element('span', '7 日展望', 'week-label'),
      element('b', '待生成', 'week-direction'),
      element('span', '', 'week-confidence'),
      element('span', '›', 'week-open'),
    );
    $('.quote-time', card).before(summary);
    summary.addEventListener('click', () => openOutlook(id));
  }
  const days = outlook?.days.filter(({ mid }) => Number.isFinite(mid)) ?? [];
  const last = days.at(-1);
  $('.week-direction', summary).textContent = last ? FORECAST_LABELS[last.direction] : '待生成';
  $('.week-confidence', summary).textContent = last ? `可信度 ${last.confidence}%` : '';
  $('.week-confidence', summary).hidden = !last;
  summary.dataset.direction = last?.direction ?? '';
  summary.title = last ?
    `截至 ${last.date} · ${FORECAST_LABELS[last.direction]} · 可信度估计 ${last.confidence}% · 尚待实时报价校准` :
    '打开七日展望';
}

function updateChanges(card, { daily, weekly }) {
  let strip = $('.changes', card);
  if (!strip) {
    strip = element('span', undefined, 'changes');
    $('.price-line', card).append(strip);
  }
  strip.replaceChildren();
  for (const [label, data] of [['较昨日', daily], ['较一周前', weekly]]) {
    const period = data && !data.exact ? `较 ${data.date.slice(5).replace('-', '/')}` : label;
    const value = element('b', data ? percent.format(data.percent / 100) : '—');
    if (data) {
      value.dataset.direction = data.percent > .0049 ? 'up' : data.percent < -.0049 ? 'down' : 'flat';
    }
    const chip = element('span', undefined, 'change-chip');
    chip.title = data ? `${label}的比较基准：${data.date} ${data.basis}` : `${label}暂无有效历史点`;
    chip.append(element('span', period), value);
    strip.append(chip);
  }
}

const cards = { gold: $('#gold'), ctf: $('#ctf'), combined: $('#combined') };
const charts = Object.fromEntries(Object.entries(cards).map(([id, card]) => [id, new Chart(card)]));

function updateChart(id, series, snapshot, caption, dualAxis = false) {
  const card = cards[id];
  $('.chart-dates span:first-child', card).textContent = dateTick.format(new Date(snapshot.since));
  $('.chart-dates span:last-child', card).textContent = dateTick.format(new Date(snapshot.today));
  const statuses = series.map(({ id }) => snapshot.instruments[id].historyStatus);
  const state = statuses.includes('loading') ? 'loading' : statuses.includes('retry') ? 'retry' : 'done';
  $('.history-caption', card).textContent = state === 'retry' ? '历史待更新' : caption;
  charts[id].update(series, snapshot.since, snapshot.today, dualAxis, state);
}

function render(snapshot) {
  lastSnapshot = snapshot;
  const { currency, instruments } = snapshot;
  $('#date').textContent = snapshot.today;
  $('#currency').value = currency;
  $('#gold-title span').textContent = `XAU/${currency}`;
  $('#fx-source').hidden = currency === 'USD';
  const network = $('#network');
  network.dataset.offline = !snapshot.online;
  $('b', network).textContent = snapshot.online ? '网络可用' : '等待网络恢复';
  const retryAt = Math.min(...Object.values(instruments).map((item) => item.retryAt ?? Infinity));
  $('#next').textContent = !snapshot.online ? '恢复联网后自动补拉' :
    Number.isFinite(retryAt) ? `下次重试 ${displayTime.format(new Date(retryAt))}` : '每日 10:00 取价';

  const leftUnit = currency === 'CNY' ? '元/克' : `${UNITS[currency]}/克`;
  const gold = { id: 'gold', rows: instruments.gold.history, unit: leftUnit };
  const ctf = { id: 'ctf', rows: instruments.ctf.history, unit: '元/克' };
  for (const { id } of [gold, ctf]) {
    updateQuote(id, cards[id], instruments[id], snapshot);
    updateQuote(id, $(`#summary-${id}`), instruments[id], snapshot);
  }
  const separateAxes = currency !== 'CNY';
  $('#legend-gold').textContent = `国际现货 · ${separateAxes ? '左轴 ' : ''}${leftUnit}`;
  $('#legend-ctf').textContent = `周大福 · ${separateAxes ? '右轴 ' : ''}元/克`;
  updateChart('gold', [gold], snapshot, '现货日收盘');
  updateChart('ctf', [ctf], snapshot, '每日挂牌价');
  updateChart('combined', [gold, ctf], snapshot, separateAxes ? '左右轴各用独立刻度' : '两条曲线共用刻度', separateAxes);
  renderOutlook();
}

const weekday = new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', weekday: 'short' });

function renderOutlook() {
  if (!lastSnapshot) return;
  const { outlook, currency } = lastSnapshot;
  const data = outlook.forecasts[forecastInstrument];
  const unit = forecastInstrument === 'gold' ? `${UNITS[currency]}/克` : '元/克';
  const number = forecastInstrument === 'gold' ? amount : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
  const target = $('#forecast-rows');
  target.replaceChildren();
  $('#forecast-meta').textContent = data ?
    `基准 ${data.anchor.date}  ${number.format(data.anchor.price)} ${unit} · 可信度待校准` :
    '等待足够的最新历史报价或参考汇率';
  $('#forecast-table').hidden = !data;
  for (const item of data?.days ?? []) {
    const row = element('tr');
    const day = `${item.date.slice(5).replace('-', '/')} ${weekday.format(new Date(item.date))}`;
    const trend = element('td');
    if (item.model) {
      trend.dataset.direction = item.direction;
      const label = element('span', undefined, 'daily-direction');
      const confidence = element('span', `${item.confidence}%`, 'daily-confidence');
      confidence.setAttribute('aria-label', `可信度估计 ${item.confidence}%`);
      label.append(element('b', FORECAST_LABELS[item.direction]), confidence);
      trend.append(label);
      trend.title = `${item.sample} 个历史情景 · ${item.model} · 可信度待校准`;
    } else {
      trend.textContent = item.closed ? '例行休市' : '样本不足';
    }
    row.append(
      element('td', day), trend, element('td', item.mid ? number.format(item.mid) : '—'),
      element('td', item.low ? `${number.format(item.low)} – ${number.format(item.high)}` : '—'),
    );
    target.append(row);
  }

  const verification = outlook.verification[forecastInstrument];
  const counts = Object.entries(verification.byHorizon).map(([horizon, score]) => score.total ?
    `${horizon} 日方向命中 ${score.hit}/${score.total}` : `${horizon} 日无到期样本`);
  $('#verification-status').textContent = '北京时间 10:00–10:15';
  const seven = verification.byHorizon[7];
  $('#verification-note').textContent = counts.join(' · ') + (seven.total ?
    `。7 日平均估计 ${Math.round(seven.meanConfidence * 100)}%，实际命中 ${Math.round(seven.hitRate * 100)}%。` : '') +
    (verification.late ? ` 另有 ${verification.late} 条迟到样本。` : '');

  const drivers = $('#drivers');
  drivers.replaceChildren();
  $('#market-status').textContent = outlook.status === 'loading' ? '读取数据中' :
    data?.factors.length ? '近 5 个观测变化' : '宏观数据暂无';
  for (const factor of data?.factors ?? []) {
    const change = factor.unit === '%' ? percent.format(factor.change / 100) :
      `${factor.change > 0 ? '+' : ''}${Math.round(factor.change)} 基点`;
    const button = element('button', undefined, 'driver');
    button.append(element('span', factor.name), element('small', factor.date), element('b', change));
    button.addEventListener('click', () => desk.openSource(factor.id));
    drivers.append(button);
  }

  const archived = outlook.newsFetched && new Date(outlook.newsFetched).getTime() < Date.now() - 2 * DAY;
  const events = $('#events');
  events.replaceChildren();
  $('#event-note').textContent = outlook.events.length ?
    '冲突、能源和外交动态供解读行情。' :
    outlook.newsFetched && !archived ? '近期订阅没有匹配事件。' : '事件订阅待更新。';
  for (const event of outlook.events.slice(0, 2)) {
    const line = element('li');
    const button = element('button', event.title);
    button.title = event.title;
    button.addEventListener('click', () => desk.openEvent(event.url));
    line.append(element('span', `${displayTime.format(new Date(event.timestamp)).split(' ')[0]} · ${event.tag}`), button);
    events.append(line);
  }

  const calendar = $('#calendar');
  calendar.replaceChildren();
  const available = outlook.calendar.available.length;
  $('#calendar-status').textContent = available ? `${available}/3 个来源已更新` : '日历待更新';
  if (available && !outlook.calendar.events.length) calendar.append(element('li', '已更新来源暂无七日内发布项'));
  for (const event of outlook.calendar.events.slice(0, 4)) {
    const line = element('li');
    const button = element('button', event.title);
    button.addEventListener('click', () => desk.openSource(event.source));
    line.append(element('span', displayTime.format(event.timestamp)), button);
    calendar.append(line);
  }
  $('#model-note').textContent = data ?
    '涨跌相对基准价，±0.2% 以内为维持。可信度取同期限历史频率。市场因素和日历用于解读行情。' +
      (forecastInstrument === 'gold' && currency !== 'USD' ? ' 展望按当前汇率折算，方向基于美元金价。' : '') : '';
}

function selectForecast(id) {
  forecastInstrument = id;
  $('#forecast-gold').setAttribute('aria-pressed', id === 'gold');
  $('#forecast-ctf').setAttribute('aria-pressed', id === 'ctf');
  renderOutlook();
}

async function openOutlook(id) {
  selectForecast(id);
  updateView(await desk.setView('outlook'));
}

$('#pin').addEventListener('click', async () => {
  if (!dockSide) updatePin(await desk.pin());
});
$('#theme').addEventListener('click', async () => updateTheme(await desk.theme()));
$('#edge-setting').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.setAttribute('aria-pressed', await desk.toggleEdge());
});
for (const view of ['quotes', 'outlook']) {
  $(`#${view}-view`).addEventListener('click', async () => updateView(await desk.setView(view)));
}
for (const id of ['gold', 'ctf']) {
  $(`#forecast-${id}`).addEventListener('click', () => selectForecast(id));
}
$('#layout').addEventListener('click', async () => updateLayout(await desk.setLayout($('#layout').getAttribute('aria-pressed') !== 'true')));
$('#currency').addEventListener('change', async (event) => render(await desk.setCurrency(event.target.value)));
$('#minimize').addEventListener('click', () => desk.minimize());
$('#close').addEventListener('click', () => desk.quit());
document.querySelectorAll('[data-source]').forEach((link) => {
  link.addEventListener('click', () => desk.openSource(link.dataset.source));
});
desk.watch(render);
desk.watchEdge(updateEdgeMotion);
desk.read().then((snapshot) => {
  render(snapshot);
  dockSide = snapshot.dockSide;
  updatePin(snapshot.pinned);
  updateLayout(snapshot.combined);
  updateTheme(snapshot.dark);
  $('#edge-setting').setAttribute('aria-pressed', snapshot.edgeEnabled);
});
