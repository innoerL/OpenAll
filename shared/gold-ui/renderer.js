(() => {
'use strict';
const host = window.openallGold;
const $ = (selector, root = document) => root.querySelector(selector);
const amount = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const whole = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const percent = new Intl.NumberFormat('zh-CN', {
  style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: 'exceptZero',
});
const metricPercent = new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 2 });
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
let outlookSignature;

function showError(error) {
  const panel = $('#error');
  panel.textContent = `读取金价失败：${error?.message || String(error)}`;
  panel.hidden = false;
}

async function action(name, payload) {
  try {
    const result = await host.action(name, payload);
    if (result?.instruments) render(result);
    return result;
  } catch (error) {
    showError(error);
    return null;
  }
}

function updatePin(pinned) {
  preferredPin = pinned;
  const button = $('#pin');
  button.setAttribute('aria-pressed', Boolean(dockSide) || pinned);
  button.setAttribute('aria-disabled', Boolean(dockSide));
  button.title = dockSide ? '贴边展开时自动置顶' : pinned ? '取消置顶' : '窗口置顶';
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
    done ? (quote?.note?.includes('休市') ? '休市时段' : outOfDate ? '上次报价' : '已更新') : '等待 10 点';
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
  $('.week-confidence', summary).textContent = last ? `方向概率 ${last.confidence}%` : '';
  $('.week-confidence', summary).hidden = !last;
  summary.dataset.direction = last?.direction ?? '';
  summary.title = last ?
    `截至 ${last.date} · ${FORECAST_LABELS[last.direction]} · 方向概率 ${last.confidence}%（未校准），不是价格命中率` :
    '打开七日展望';
}

function updateChanges(card, { daily, weekly } = {}) {
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
const charts = Object.fromEntries(Object.entries(cards).map(([id, card]) => [id, new window.OpenAllGoldChart(card)]));

function updateChart(id, series, snapshot, caption, dualAxis = false) {
  const card = cards[id];
  $('.chart-dates span:first-child', card).textContent = dateTick.format(new Date(snapshot.since));
  $('.chart-dates span:last-child', card).textContent = dateTick.format(new Date(snapshot.today));
  const statuses = series.map(({ id }) => snapshot.instruments[id].historyStatus);
  const state = statuses.includes('loading') ? 'loading' : statuses.includes('retry') ? 'retry' : 'done';
  $('.history-caption', card).textContent = state === 'retry' ? '历史待更新' : caption;
  charts[id].update(series, snapshot.since, snapshot.today, dualAxis, state);
}

window.OpenAllSurfaceEffects.install();

function render(snapshot) {
  if (!snapshot?.instruments) return;
  lastSnapshot = snapshot;
  window.OpenAllGoldTheme.apply(snapshot.theme);
  dockSide = snapshot.dockSide ?? null;
  updatePin(snapshot.pinned ?? true);
  updateView(snapshot.view || 'quotes');
  updateLayout(Boolean(snapshot.combined));
  $('#edge-setting').setAttribute('aria-pressed', snapshot.edgeEnabled !== false);
  $('#error').hidden = true;
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
  window.OpenAllGoldUI = { ready: true };
}

const weekday = new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', weekday: 'short' });

function renderOutlook() {
  if (!lastSnapshot) return;
  const { outlook, currency } = lastSnapshot;
  const verification = outlook.verification[forecastInstrument];
  const signature = JSON.stringify([outlook, currency, forecastInstrument]);
  if (signature === outlookSignature) return;
  outlookSignature = signature;
  const data = outlook.forecasts[forecastInstrument];
  const unit = forecastInstrument === 'gold' ? `${UNITS[currency]}/克` : '元/克';
  const number = forecastInstrument === 'gold' ? amount : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
  const target = $('#forecast-rows');
  target.replaceChildren();
  const meta = $('#forecast-meta');
  if (data) {
    const baseline = element('span', undefined, 'forecast-baseline');
    baseline.append('基准 ', element('strong', `${number.format(data.anchor.price)} ${unit}`), ' · ', data.anchor.date);
    const model = element('span', `模型 ${data.version || verification.version || '—'} · 方向概率未校准${data.provisional ? ' · 数据尚未就绪，暂估' : ''}`);
    meta.replaceChildren(baseline, model);
  } else {
    meta.textContent = '等待足够的最新历史报价或参考汇率';
  }
  $('#forecast-table').hidden = !data;
  for (const item of data?.days ?? []) {
    const row = element('tr');
    const dateCell = element('td');
    const date = element('time', item.date.slice(5).replace('-', '/'));
    date.dateTime = item.date;
    dateCell.append(date, ' ', element('span', weekday.format(new Date(item.date)), 'weekday'));
    const trend = element('td');
    if (item.model) {
      trend.dataset.direction = item.direction;
      const label = element('span', undefined, 'daily-direction');
      const confidence = element('span', `${item.confidence}%`, 'daily-confidence');
      confidence.setAttribute('aria-label', `方向概率 ${item.confidence}%，未校准，不是价格命中率`);
      label.append(element('b', FORECAST_LABELS[item.direction]), confidence);
      trend.append(label);
      trend.title = `${item.sample} 个历史情景 · ${item.model} · 方向概率未校准，不是价格命中率`;
    } else {
      trend.textContent = item.closed ? '例行休市' : '样本不足';
    }
    const price = element('td', item.mid ? number.format(item.mid) : '—');
    price.title = item.mid ? (item.pointMethod === 'persistence' ?
      '参考估计沿用基准价，方向概率与区间另行估计；不代表保证价格不变' : '参考估计来自历史情景；方向概率不是价格命中率') : '';
    row.append(dateCell, trend, price, element('td', item.low ? `${number.format(item.low)} – ${number.format(item.high)}` : '—'));
    target.append(row);
  }

  const counts = Object.entries(verification.byHorizon).map(([horizon, score]) => score.total ?
    `${horizon} 日方向命中 ${score.hit}/${score.total}` : `${horizon} 日无到期样本`);
  $('#verification-status').textContent = '北京时间 10:00–10:15';
  const one = verification.byHorizon[1] || {};
  const priceSummary = one.priceCount && Number.isFinite(one.mape) ?
    `明日价平均误差 ${metricPercent.format(one.mape)}（${one.priceCount} 次${one.priceCount < 30 ? '，样本较少' : ''}）` : '明日价暂无到期的准时价格误差样本';
  const intervalSummary = one.intervalCount && Number.isFinite(one.intervalCoverage) ?
    `区间覆盖 ${metricPercent.format(one.intervalCoverage)}（${one.intervalCount} 次）` : '区间暂无可验证样本';
  $('#verification-note').textContent = `${priceSummary} · ${intervalSummary}`;
  $('#verification-note').title = '当前模型的实际到期记录。平均误差为绝对价格误差除以实际价格（MAPE），越小越好；区间覆盖是实际价格落入已存档区间的比例。方向概率不是价格命中率。';
  const late = verification.lateByHorizon?.[1];
  const lateSummary = verification.late ? `另有 ${verification.late} 条迟到样本，不计入上方统计` +
    (late?.priceCount && Number.isFinite(late.mape) ? `；迟到明日价误差 ${metricPercent.format(late.mape)}（${late.priceCount} 次）` : '') +
    (late?.intervalCount && Number.isFinite(late.intervalCoverage) ? `，区间覆盖 ${metricPercent.format(late.intervalCoverage)}（${late.intervalCount} 次）` : '') : '';
  $('#verification-details').textContent = counts.join(' · ') + (lateSummary ? `。${lateSummary}。` : '');
  const recent = verification.recent;
  const comparison = $('#verification-recent');
  comparison.hidden = !recent;
  comparison.textContent = recent ? `${recent.target} 到期 ${recent.horizon} 日预测：参考估计较基准 ${percent.format(recent.predictedReturn)}，实际 ${percent.format(recent.actualReturn)}，价格误差 ${metricPercent.format(recent.errorRate)}（${recent.onSchedule ? '准时' : '迟到'}）。` : '';

  const drivers = $('#drivers');
  drivers.replaceChildren();
  $('#market-status').textContent = outlook.status === 'loading' ? '读取数据中' :
    data?.factors.length ? '近 5 个观测变化' : '宏观数据暂无';
  for (const factor of data?.factors ?? []) {
    const change = factor.unit === '%' ? percent.format(factor.change / 100) :
      `${factor.change > 0 ? '+' : ''}${Math.round(factor.change)} 基点`;
    const button = element('button', undefined, 'driver');
    button.append(element('span', factor.name), element('small', factor.date), element('b', change));
    button.dataset.direction = factor.change > 0 ? 'up' : factor.change < 0 ? 'down' : 'flat';
    button.addEventListener('click', () => action('source', factor.id));
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
    button.addEventListener('click', () => action('event', event.url));
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
    button.addEventListener('click', () => action('source', event.source));
    line.append(element('span', displayTime.format(event.timestamp)), button);
    calendar.append(line);
  }
  $('#model-note').textContent = data ?
    '涨跌相对基准价，±0.2% 以内为维持。方向概率未校准，不是价格命中率。' +
      (data.days.some(day => day.pointMethod === 'persistence') ?
        '周大福参考估计采用不变价保守基准，方向与区间另行估计；不代表保证价格不变。' : '参考估计来自历史情景。') +
      '区间为历史情景范围，覆盖率以到期记录验证。市场因素和日历用于解读行情。' +
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
  await action('view', 'outlook');
}


$('#pin').addEventListener('click', () => { if (!dockSide) action('pin'); });
$('#theme').addEventListener('click', () => action('appearance'));
$('#edge-setting').addEventListener('click', () => action('edge'));
for (const view of ['quotes', 'outlook']) {
  $(`#${view}-view`).addEventListener('click', () => action('view', view));
}
for (const id of ['gold', 'ctf']) {
  $(`#forecast-${id}`).addEventListener('click', () => selectForecast(id));
}
$('#layout').addEventListener('click', () => action('layout', $('#layout').getAttribute('aria-pressed') !== 'true'));
$('#currency').addEventListener('change', event => action('currency', event.target.value));
$('#minimize').addEventListener('click', () => action('minimize'));
$('#close').addEventListener('click', () => action('close'));
document.addEventListener('click', event => {
  const source = event.target.closest('[data-source]');
  if (source) action('source', source.dataset.source);
});
$('.window-bar').addEventListener('mousedown', event => {
  if (event.button === 0 && !event.target.closest('button,select,input,a')) action('drag');
});
if (!host) showError(new Error('请从 OpenAll 打开金价工具'));
else {
  const unsubscribe = host.watch(render);
  const unsubscribeEdge = host.watchEdge(updateEdgeMotion);
  host.read().then(render).catch(showError);
  window.addEventListener('pagehide', () => { unsubscribe?.(); unsubscribeEdge?.(); }, { once: true });
}
})();
