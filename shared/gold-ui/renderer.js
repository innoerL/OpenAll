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
const DIRECTION_LABELS = { up: '涨', down: '跌', flat: '维持' };
const FORECAST_LABELS = { up: '预计涨', down: '预计跌', flat: '预计维持', uncertain: '方向不明' };
const DIRECTION_THRESHOLD = .60;
const scenarioPercent = new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 1 });
let lastSnapshot;
let forecastInstrument = 'gold';
let preferredPin = true;
let dockSide = null;
let outlookSignature;
let expandedDate = null;
let chartMode = null;

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
  const switched = $(`#${view}`)?.hidden;
  for (const id of ['quotes', 'outlook']) {
    $(`#${id}`).hidden = view !== id;
    $(`#${id}-view`).setAttribute('aria-pressed', view === id);
  }
  if (switched) window.scrollTo(0, 0);
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

function updateQuoteComparison(id, card, { quote, yesterday, previousForecast }, today) {
  let comparison = $('.quote-comparison', card);
  if (!comparison) {
    comparison = element('dl', undefined, 'quote-comparison');
    $('.quote-time', card).before(comparison);
  }
  const number = id === 'gold' ? amount : whole;
  const actual = quote?.date === today ? displayValue(number, quote.price) : null;
  comparison.replaceChildren();
  for (const [forecast, point] of [[false, yesterday], [true, previousForecast]]) {
    if (!forecast && actual === null && point && point.date === quote?.date && point.price === quote.price) continue;
    const label = forecast ? '昨日预测今价' :
      id === 'gold' && point?.basis === '历史日线' ? '昨日收盘' : '昨日实价';
    const row = element('div', undefined, 'quote-reference');
    row.dataset.reference = forecast ? 'forecast' : 'yesterday';
    const value = element('dd');
    const hasPrice = Number.isFinite(point?.price);
    row.append(element('dt', label), value);
    value.append(element('span', hasPrice ? number.format(point.price) : forecast ? '暂无存档' : '暂无报价', 'reference-price'));
    if (hasPrice) row.title = forecast ? `${point.date} 存档的今日预测价` : `${point.date} · ${point.basis}`;
    if (hasPrice && actual !== null) {
      const delta = actual - displayValue(number, point.price);
      const direction = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
      const difference = (delta > 0 ? '+' : delta < 0 ? '−' : '') + number.format(Math.abs(delta));
      const change = element('span', forecast ? '偏差 ' + difference : difference, 'reference-delta');
      if (!forecast) change.dataset.direction = direction;
      change.title = forecast ? '今日实价减预测价，按本卡币种与单位显示' : '今日实价减昨日价格，按本卡币种与单位显示';
      value.append(change);
    } else if (hasPrice && forecast) {
      value.append(element('span', '实价待更新', 'reference-delta'));
    }
    comparison.append(row);
  }
}

function staleQuoteLabel(quote, today) {
  if (!quote?.date || quote.date === today) return '';
  const yesterday = new Date(Date.parse(today) - DAY).toISOString().slice(0, 10);
  return quote.date === yesterday ? '昨日金价' : `${quote.date.slice(5).replace('-', '/')} 报价`;
}

function updateQuote(id, card, item, snapshot) {
  const { quote, status, retryAt, detail, waitingForFx } = item;
  const { today, online, currency } = snapshot;
  const done = status === 'done';
  const state = $('.state', card);
  const stale = staleQuoteLabel(quote, today);
  const label = !online ? '等待联网' :
    status === 'loading' ? '正在取价' :
    status === 'retry' ? '等待重试' :
    waitingForFx ? '等待汇率' :
    done ? (quote?.note?.includes('休市') ? '休市时段' : stale ? '上次报价' : '已更新') :
    snapshot.slot === today ? '等待取价' : '等待 9 点';
  state.dataset.tone = !online ? 'offline' : done && !stale && !waitingForFx ? 'ok' : 'pending';
  $('span', state).textContent = label;
  $('.quote-price', card).textContent = quote ? (id === 'gold' ? amount : whole).format(quote.price) : '—';
  $('.unit', card).textContent = id === 'gold' ? `${UNITS[currency]} / 克` : '元 / 克';
  let freshness = $('.quote-freshness', card);
  if (!freshness) {
    freshness = element('p', undefined, 'quote-freshness');
    $('.price-line', card).after(freshness);
  }
  freshness.hidden = !stale;
  freshness.textContent = stale ? stale + ' · 今日数据未更新' : '';
  updateChanges(card, item.changes, Boolean(stale));
  updateQuoteComparison(id, card, item, today);
  updateSummary(id, card, snapshot.outlook.forecasts[id]);
  const dateLabel = quote?.quoteTime ? displayTime.format(new Date(quote.quoteTime)) : quote?.date;
  const priceTime = quote ? `${quote.note ? '最近报价' : id === 'gold' ? '行情时间' : quote.quoteTime ? '牌价时间' : '牌价日期'} ${dateLabel}` :
    waitingForFx ? '等待参考汇率' : '暂无有效报价';
  const retryLabel = retryAt && online ? ` · ${displayTime.format(new Date(retryAt))} 重试` : '';
  const fxLabel = quote?.fxDate ? ` · 汇率 ${quote.fxDate.slice(5).replace('-', '/')}` : '';
  const time = $('.quote-time', card);
  time.textContent = priceTime + fxLabel + retryLabel;
  time.title = detail ?? (quote ? `实际取价 ${displayTime.format(new Date(quote.fetchedAt))}` : '');

}

function groupQuoteStatus() {
  const shared = $('#shared-quote-status');
  const states = [cards.gold, cards.ctf].map(card => $('.state', card));
  const times = [cards.gold, cards.ctf].map(card => $('.quote-time', card));
  const commonState = states[0].textContent === states[1].textContent &&
    states[0].dataset.tone === states[1].dataset.tone;
  const commonTime = times[0].textContent === times[1].textContent && times[0].title === times[1].title;
  shared.hidden = !commonTime && !commonState;
  shared.dataset.tone = commonState ? states[0].dataset.tone : '';
  shared.textContent = [commonState ? '两项报价' + states[0].textContent : '', commonTime ? times[0].textContent : ''].filter(Boolean).join(' · ');
  shared.title = commonTime ? times[0].title : '';
  for (const card of [cards.gold,cards.ctf,$('#summary-gold'),$('#summary-ctf')]) {
    $('.state',card).hidden = commonState;
    $('.quote-time',card).hidden = commonTime;
  }
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function displayDirection(day) {
  if (day?.closed || day?.sparse || !day?.model || !Object.hasOwn(DIRECTION_LABELS, day.direction)) return null;
  if (!Object.keys(DIRECTION_LABELS).every(key => Number.isFinite(day.probabilities?.[key]))) return null;
  return day.probabilities[day.direction] >= DIRECTION_THRESHOLD ? day.direction : 'uncertain';
}

function updateSummary(id, card, outlook) {
  let summary = $('.week-summary', card);
  if (!summary) {
    summary = element('button', undefined, 'week-summary');
    summary.type = 'button';
    summary.append(
      element('span', '3 日展望', 'week-label'),
      element('b', '待生成', 'week-direction'),
      element('span', '', 'week-confidence'),
      element('span', '›', 'week-open'),
    );
    $('.quote-time', card).before(summary);
    summary.addEventListener('click', () => openOutlook(id));
  }
  const days = outlook?.days.filter(({ mid }) => Number.isFinite(mid)) ?? [];
  const last = days.at(-1);
  const direction = displayDirection(last);
  const label = FORECAST_LABELS[direction] ?? (last ? '方向暂缺' : '待生成');
  const confidence = direction && direction !== 'uncertain' ? scenarioPercent.format(last.probabilities[direction]) : '';
  $('.week-label', summary).textContent = last ? last.date.slice(5).replace('-', '/') + ' 展望' : '3 日展望';
  $('.week-direction', summary).textContent = label;
  $('.week-confidence', summary).textContent = confidence ? '方向概率 ' + confidence : '';
  $('.week-confidence', summary).hidden = !confidence;
  summary.dataset.direction = direction ?? '';
  summary.setAttribute('aria-label', last ?
    `查看三日展望，${last.date} ${label}` : '查看三日展望');
  summary.title = last ?
    `${last.date} · ${label}${confidence ? ' · 方向概率 ' + confidence + '（未校准）' : ''}` :
    '打开三日展望';
}

function updateChanges(card, { daily, weekly } = {}, stale = false) {
  let strip = $('.changes', card);
  if (!strip) {
    strip = element('span', undefined, 'changes');
    $('.price-line', card).append(strip);
  }
  strip.hidden = stale;
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
const pageContent = $('main');
const quotes = $('#quotes');
let fitFrame = 0;

function fitQuoteCharts() {
  if (fitFrame) return;
  fitFrame = requestAnimationFrame(() => {
    fitFrame = 0;
    if (quotes.hidden) return;
    const plots = Object.values(cards).filter(card => !card.hidden).map(card => $('.plot', card));
    const plotted = plots.reduce((sum, plot) => sum + plot.getBoundingClientRect().height, 0);
    const rows = new Set(plots.map(plot => plot.parentElement.getBoundingClientRect().top)).size;
    // 图表优先让出高度，报价、对比和底部操作按实际换行后的高度保留。
    const contentBottom = pageContent.getBoundingClientRect().bottom + window.scrollY;
    const spare = document.documentElement.clientHeight - contentBottom;
    const height = `${Math.floor(plotted / plots.length + spare / rows)}px`;
    if (quotes.style.getPropertyValue('--plot-height') !== height) quotes.style.setProperty('--plot-height', height);
  });
}

const quoteLayout = new ResizeObserver(fitQuoteCharts);
quoteLayout.observe(pageContent);
window.addEventListener('resize', fitQuoteCharts);

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
  $('#fx-source').hidden = $('#fx-source-label').hidden = currency === 'USD';
  const network = $('#network');
  network.dataset.offline = !snapshot.online;
  $('b', network).textContent = snapshot.online ? '网络可用' : '等待网络恢复';
  const retryAt = Math.min(...Object.values(instruments).map((item) => item.retryAt ?? Infinity));
  $('#next').textContent = !snapshot.online ? '恢复联网后自动补拉' :
    Number.isFinite(retryAt) ? `下次重试 ${displayTime.format(new Date(retryAt))}` : '每日 09:00 开始取价';

  const leftUnit = currency === 'CNY' ? '元/克' : `${UNITS[currency]}/克`;
  const gold = { id: 'gold', rows: instruments.gold.history, unit: leftUnit };
  const ctf = { id: 'ctf', rows: instruments.ctf.history, unit: '元/克' };
  for (const { id } of [gold, ctf]) {
    const quote = instruments[id].quote;
    const source = $(`#source-${id}`);
    source.textContent = `报价 ${quote?.source ?? (id === 'gold' ? 'Gold API' : '周大福官方商城')}`;
    if (id === 'ctf') source.dataset.source = quote?.source === '金价网 · 金子银子' ? 'ctfFallback' : 'ctf';
    updateQuote(id, cards[id], instruments[id], snapshot);
    updateQuote(id, $(`#summary-${id}`), instruments[id], snapshot);
  }
  groupQuoteStatus();
  fitQuoteCharts();
  const valid = row => Number.isFinite(row.price) && row.price > 0 && row.date >= snapshot.since && row.date <= snapshot.today;
  const retailPrices = new Map(ctf.rows.filter(valid).map(row => [row.date, row.price]));
  const base = gold.rows.filter(row => valid(row) && retailPrices.has(row.date))
    .reduce((earliest, row) => !earliest || row.date < earliest.date ? row : earliest, null);
  const relative = Boolean(base && (chartMode === 'change' || (!chartMode && currency !== 'CNY')));
  const separateAxes = !relative && currency !== 'CNY';
  $('#chart-change').disabled = !base;
  $('#chart-change').title = base ? '以最早的共同报价日为基准' : '两种金价尚无同日报价';
  $('#chart-amount').setAttribute('aria-pressed', String(!relative));
  $('#chart-change').setAttribute('aria-pressed', String(relative));
  $('.chart-legend').classList.toggle('dual-axis', separateAxes);
  $('.chart-legend').hidden = relative;
  $('#legend-gold').textContent = relative ? '国际现货' : (separateAxes ? '左轴 ' : '') + '国际现货 · ' + leftUnit;
  $('#legend-ctf').textContent = relative ? '周大福' : (separateAxes ? '右轴 周大福 · 人民币/克' : '周大福 · 元/克');
  $('#combined-axis-note').hidden = !separateAxes;
  updateChart('gold', [gold], snapshot, '现货日收盘');
  updateChart('ctf', [ctf], snapshot, '每日挂牌价');
  if (relative) {
    const series = [gold, ctf].map(line => {
      const initial = line.id === 'gold' ? base.price : retailPrices.get(base.date);
      const rows = line.rows.filter(row => valid(row) && row.date >= base.date)
        .map(row => ({date:row.date, price:100 * (row.price / initial - 1)}));
      return {...line, rows, unit:'%'};
    });
    updateChart('combined', series, {...snapshot, since:base.date}, '较 ' + base.date + ' · 同日为 0%', false);
  } else {
    updateChart('combined', [gold, ctf], snapshot, separateAxes ? '左右轴各用独立刻度' : '两条曲线共用刻度', separateAxes);
  }
  renderOutlook();
  window.OpenAllGoldUI = { ready: true };
}

const weekday = new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', weekday: 'short' });

function unavailableReason(day) {
  if (day.closed) return '例行休市';
  return { 'gold-history': '国际行情不足', 'ctf-history': '牌价历史不足', 'paired-history': '同期样本不足' }[day.sparseReason] || '样本不足';
}

function displayValue(number, value) {
  return Number(number.format(value).replaceAll(',', ''));
}

function forecastDirectionIcon(direction) {
  const label = FORECAST_LABELS[direction];
  const icon = element('span', undefined, 'forecast-trend');
  icon.dataset.direction = direction;
  icon.setAttribute('role', 'img');
  icon.setAttribute('aria-label', label);
  icon.title = label + ' · 相对预测基准价';
  return icon;
}

function renderForecastDays(data, today, number, unit, todayQuote) {
  const body = $('#forecast-rows');
  const focusedDate = document.activeElement.closest?.('.forecast-day-toggle')?.dataset.date;
  const days = data?.days || [];
  if (!days.some(day => day.date === expandedDate)) expandedDate = null;
  const priced = days.filter(day => Number.isFinite(day.low) && Number.isFinite(day.high));
  // 参考点和区间端点按表内的显示精度定位，同一个读数在每行都落在同一位置。
  const shown = value => displayValue(number, value);
  const todayPrice = Number.isFinite(todayQuote) ? displayValue(whole, todayQuote) : null;
  const min = Math.min(...priced.map(day => shown(day.low))), max = Math.max(...priced.map(day => shown(day.high)));
  $('#forecast-table').toggleAttribute('data-long-amounts', days.some(day =>
    [day.mid, day.low, day.high].some(value => Number.isFinite(value) && number.format(value).length > 8)));
  const scale = $('#range-scale');
  scale.hidden = $('#range-key').hidden = !(max > min);
  const showToday = max > min && Number.isFinite(todayPrice) && todayPrice >= min && todayPrice <= max;
  $('#today-key').hidden = !showToday;
  const position = value => (100 * (value - min) / (max - min)) + '%';
  if (showToday) body.style.setProperty('--today', position(todayPrice));
  if (!scale.hidden) {
    scale.firstElementChild.textContent = number.format(min);
    scale.lastElementChild.textContent = number.format(max);
    scale.setAttribute('aria-label', '三天共用刻度：' + number.format(min) + ' 至 ' + number.format(max) + ' ' + unit);
  }
  const tomorrow = Date.parse(today + 'T00:00:00Z') + DAY;
  const fragment = document.createDocumentFragment();
  for (const day of days) {
    const date = day.date, stamp = new Date(date + 'T00:00:00Z'), next = stamp.getTime() === tomorrow;
    const row = element('tr', undefined, 'forecast-day');
    row.classList.toggle('next-day', next);
    const dateCell = element('td'), toggle = element('button', undefined, 'forecast-day-toggle');
    const time = element('time', date.slice(5).replace('-', '/'));
    time.dateTime = date;
    const name = weekday.format(stamp);
    toggle.type = 'button';
    toggle.dataset.date = date;
    toggle.setAttribute('aria-label', date + ' ' + name + '，预测详情');
    const detailID = 'forecast-day-' + date;
    toggle.setAttribute('aria-controls', detailID);
    toggle.setAttribute('aria-expanded', String(expandedDate === date));
    toggle.append(time, element('span', next ? '明日' : name, 'weekday'));
    dateCell.append(toggle);
    const hasPrice = Number.isFinite(day.mid);
    const price = element('td', undefined, 'forecast-price');
    const direction = displayDirection(day);
    const label = hasPrice ? number.format(day.mid) : (day.closed ? '休市' : '暂无');
    if (direction) {
      const reading = element('span', undefined, 'forecast-reading');
      reading.append(forecastDirectionIcon(direction), element('span', label));
      price.append(reading);
      toggle.setAttribute('aria-label', date + ' ' + name + '，' + FORECAST_LABELS[direction] + '，预测详情');
    } else {
      price.textContent = label;
    }
    if (!hasPrice) price.classList.add('no-price');
    if (day.pointMethod === 'persistence') price.title = '沿用发行时的基准牌价';
    const range = element('td', undefined, 'forecast-range');
    if (Number.isFinite(day.low) && Number.isFinite(day.high)) {
      const label = element('span', undefined, 'range-values');
      label.append(element('span', number.format(day.low), 'range-endpoint'),
        element('span', ' – ', 'range-separator'), element('span', number.format(day.high), 'range-endpoint'));
      range.append(label);
      if (max > min) {
        if (showToday) {
          const guide = element('span', undefined, 'range-guide');
          guide.setAttribute('aria-hidden', 'true');
          guide.append(element('span', undefined, 'range-today'));
          range.prepend(guide);
        }
        const track = element('span', undefined, 'range-track');
        track.setAttribute('aria-hidden', 'true');
        track.style.setProperty('--low', position(shown(day.low)));
        track.style.setProperty('--high', position(shown(day.high)));
        if (hasPrice) {
          const mark = element('i');
          mark.style.left = position(shown(day.mid));
          track.append(mark);
        }
        range.append(track);
        range.title = '三天共用价格刻度：' + number.format(min) + ' 至 ' + number.format(max) + ' ' + unit;
      }
    } else {
      range.textContent = '—';
    }
    row.append(dateCell, price, range);
    const detail = element('tr', undefined, 'forecast-detail');
    detail.id = detailID;
    detail.hidden = expandedDate !== date;
    const cell = element('td'), panel = element('div', undefined, 'day-reading');
    cell.colSpan = 3;
    if (direction) {
      const headline = element('div', undefined, 'day-direction');
      headline.dataset.direction = direction;
      headline.append(element('b', FORECAST_LABELS[direction]));
      if (Number.isFinite(day.sample)) headline.append(element('span', day.sample + ' 个历史情景', 'chance'));
      const probabilityText = Object.entries(DIRECTION_LABELS).map(([key, label]) =>
        label + ' ' + scenarioPercent.format(day.probabilities[key])).join(' · ');
      panel.append(headline, element('p', probabilityText + '（未校准）', 'direction-probabilities'));
      const evidence = element('p', day.model);
      panel.append(evidence);
      if (day.pointMethod === 'persistence') panel.append(element('p', '此档参考价沿用基准牌价。'));
    } else if (hasPrice || (Number.isFinite(day.low) && Number.isFinite(day.high))) {
      panel.append(element('strong', '方向概率暂缺'));
      if (day.model) panel.append(element('p', day.model));
    } else {
      panel.append(element('strong', unavailableReason(day)), element('p', day.closed ? '该日休市，不生成参考价和方向概率。' : '该期限可用样本不足，暂无价格或方向估计。'));
    }
    cell.append(panel); detail.append(cell);
    fragment.append(row, detail);
  }
  body.replaceChildren(fragment);
  if (focusedDate) [...body.querySelectorAll('.forecast-day-toggle')].find(b => b.dataset.date === focusedDate)?.focus({preventScroll:true});
}

function toggleForecastDay(button, open) {
  expandedDate = open ? button.dataset.date : null;
  for (const item of $('#forecast-rows').querySelectorAll('.forecast-day-toggle')) {
    const active = item.dataset.date === expandedDate;
    item.setAttribute('aria-expanded', String(active));
    document.getElementById(item.getAttribute('aria-controls')).hidden = !active;
  }
}

$('#forecast-rows').addEventListener('click', event => {
  const button = event.target.closest('.forecast-day')?.querySelector('.forecast-day-toggle');
  if (!button) return;
  const selection = window.getSelection();
  if (!event.target.closest('button') && selection && !selection.isCollapsed && selection.containsNode(button.closest('tr'), true)) return;
  button.focus({preventScroll:true});
  toggleForecastDay(button, button.getAttribute('aria-expanded') !== 'true');
});
$('#forecast-rows').addEventListener('keydown', event => {
  const button = event.target.closest('.forecast-day-toggle');
  if (button && event.key === 'Escape' && expandedDate) {
    event.preventDefault();
    event.stopPropagation();
    toggleForecastDay(button, false);
  } else if (button && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
    const buttons = Array.from($('#forecast-rows').querySelectorAll('.forecast-day-toggle'));
    const current = buttons.indexOf(button);
    const index = { Home: 0, End: buttons.length - 1, ArrowUp: Math.max(0, current - 1), ArrowDown: Math.min(buttons.length - 1, current + 1) };
    event.preventDefault();
    buttons[index[event.key]].focus();
  }
});

function renderOutlook() {
  if (!lastSnapshot) return;
  const { outlook, currency, today, instruments } = lastSnapshot;
  const isCTF = forecastInstrument === 'ctf';
  const quote = instruments[forecastInstrument].quote;
  const verification = outlook.verification[forecastInstrument];
  const signature = JSON.stringify([outlook, currency, forecastInstrument, today, quote?.date, quote?.price]);
  if (signature === outlookSignature) return;
  outlookSignature = signature;
  const data = outlook.forecasts[forecastInstrument];
  const unit = isCTF ? '人民币/克' : `${UNITS[currency]}/克`;
  const number = forecastInstrument === 'gold' ? amount : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
  $('#outlook').dataset.instrument = forecastInstrument;
  const meta = $('#forecast-meta');
  meta.replaceChildren();
  const hasQuote = quote?.date && Number.isFinite(quote.price);
  const title = $('#forecast-title');
  title.textContent = isCTF ? (hasQuote && quote.date !== today ? '最近周大福牌价' : '今日周大福牌价') : '国际现货基准价';
  const hasJoint = data?.days.some(day => day.pointMethod === 'joint-history' || day.sparseReason);
  const hasSessionMedian = data?.days.some(day => day.pointMethod === 'session-median');
  const hasFixed = data?.days.some(day => day.pointMethod === 'persistence');
  const heading = $('#forecast-price-heading');
  heading.textContent = isCTF ? (hasFixed ? '基准参考价' : '每日参考价') : '参考估计';
  heading.title = hasFixed ? '此档预测逐日沿用发行时的基准牌价' : '从同一预测基准分别估算各目标日期的价格';
  function addPrice(label, price, date, formatter) {
    const line = element('div', undefined, 'forecast-baseline');
    const stamp = element('time', date);
    stamp.dateTime = date;
    stamp.hidden = date === today;
    const value = element('strong', price == null ? '待更新' : formatter.format(price));
    if (price != null) value.append(' ', element('span', unit, 'forecast-unit'));
    if (label) line.append(element('span', label, 'forecast-label'));
    line.append(value, stamp);
    meta.append(line);
  }
  if (isCTF) {
    addPrice(null, hasQuote ? quote.price : null, hasQuote ? quote.date : today, whole);
  }
  if (data) {
    if (!isCTF || !hasQuote || data.anchor.date !== quote.date || data.anchor.price !== quote.price) {
      addPrice(isCTF ? '预测基准' : null, data.anchor.price, data.anchor.date, isCTF ? whole : number);
    }
    if (data.provisional || hasFixed) {
      meta.append(element('span', [hasFixed && '旧版沿用基准价', data.provisional && '暂估 · 尚未存档'].filter(Boolean).join(' · ')));
    }
  } else {
    meta.append(element('span', isCTF ? '等待足够的预测数据' : '等待足够的最新历史报价或参考汇率'));
  }
  const stale = staleQuoteLabel(quote, today);
  if (stale) {
    const notice = isCTF ? stale + ' · 今日数据未更新' : '今日数据未更新';
    meta.append(element('span', notice, 'forecast-freshness'));
  }
  $('#forecast-table').hidden = !data;
  $('#method-details').hidden = !data;
  renderForecastDays(data, today, number, unit, quote?.date === today ? quote.price : null);

  const counts = Object.entries(verification.byHorizon).filter(([days]) => Number(days) <= 3).map(([horizon, score]) => score.total ?
    `${horizon} 日模型方向命中 ${score.hit}/${score.total}` : `${horizon} 日无到期样本`);
  $('#verification-status').textContent = '北京时间 09:00–10:15';
  const one = verification.byHorizon[1] || {};
  const priceSummary = one.priceCount && Number.isFinite(one.mape) ?
    `明日价平均误差 ${metricPercent.format(one.mape)}（${one.priceCount} 次${one.priceCount < 30 ? '，样本较少' : ''}）` : '明日价暂无到期的准时价格误差样本';
  const intervalSummary = one.intervalCount && Number.isFinite(one.intervalCoverage) ?
    `区间覆盖 ${metricPercent.format(one.intervalCoverage)}（${one.intervalCount} 次）` : '区间暂无可验证样本';
  let verificationSummary = `${priceSummary} · ${intervalSummary}`;
  if (!one.priceCount && !one.intervalCount) {
    verificationSummary = Object.entries(verification.byHorizon).some(([days, score]) => Number(days) <= 3 && score.total) ?
      '次日参考价暂无可核验的准时记录' : '暂无到期的准时报价可验证';
  }
  $('#verification-note').textContent = verificationSummary;
  $('#verification-note').title = '当前模型的实际到期记录。平均误差为绝对价格误差除以实际价格（MAPE），越小越好；区间覆盖是实际价格落入已存档区间的比例。方向概率不是价格命中率。';
  const late = verification.lateByHorizon?.[1];
  const lateSummary = verification.late ? `另有 ${verification.late} 条迟到样本，不计入上方统计` +
    (late?.priceCount && Number.isFinite(late.mape) ? `；迟到明日价误差 ${metricPercent.format(late.mape)}（${late.priceCount} 次）` : '') +
    (late?.intervalCount && Number.isFinite(late.intervalCoverage) ? `，区间覆盖 ${metricPercent.format(late.intervalCoverage)}（${late.intervalCount} 次）` : '') : '';
  $('#verification-details').textContent = counts.join(' · ') + (lateSummary ? `。${lateSummary}。` : '');
  const recent = verification.recent;
  const comparison = $('#verification-recent');
  comparison.hidden = !recent;
  const predicted = recent && DIRECTION_LABELS[recent.predictedDirection];
  const actual = recent && DIRECTION_LABELS[recent.actualDirection];
  const directionCheck = predicted && actual ?
    `模型判${predicted}${Number.isFinite(recent.directionProbability) ? '（' + scenarioPercent.format(recent.directionProbability) + '）' : ''}，实际${actual} ${percent.format(recent.actualReturn)}，方向${predicted === actual ? '命中' : '未命中'}。` :
    recent ? `实际较基准 ${percent.format(recent.actualReturn)}。` : '';
  comparison.textContent = recent ? `${recent.origin} 预测 ${recent.target}（${recent.horizon} 日）。${directionCheck}参考估计较基准 ${percent.format(recent.predictedReturn)}，价格误差 ${metricPercent.format(recent.errorRate)}（${recent.onSchedule ? '准时' : '迟到'}）。` : '';

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
    '模型 ' + (data.version || verification.version || '—') + '。涨跌相对基准价，±0.2% 以内为维持。最高方向概率低于 ' +
      scenarioPercent.format(DIRECTION_THRESHOLD) + ' 时显示「方向不明」。方向概率未经实盘校准。' +
      (hasJoint ? '周大福每日参考价结合近期牌价涨跌与基准日前的国际现货收盘走势，按各日期分别估算。' :
        hasFixed ? '此档周大福参考价沿用发行时的基准牌价，方向与区间按期限估计。' : hasSessionMedian ? '标注同交易跨度的参考价按历史交易日估算，方向概率单独计算。' : '参考估计来自历史情景。') +
      '各行情景区间采用相同刻度。实线标示当日参考价，虚线标示刻度内的今日实价。区间覆盖率用到期记录验证。市场因素和日历用于解读行情。' +
      (forecastInstrument === 'gold' && currency !== 'USD' ? ' 展望按当前汇率折算，方向基于美元金价。' : '') : '';
}

function selectForecast(id) {
  if (forecastInstrument !== id) expandedDate = null;
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
for (const [id, mode] of [['chart-amount','amount'], ['chart-change','change']]) {
  $('#' + id).addEventListener('click', () => { chartMode = mode; if (lastSnapshot) render(lastSnapshot); });
}
$('#range-chart-toggle').addEventListener('click', event => {
  const show = $('#outlook').classList.toggle('show-range-chart');
  event.currentTarget.setAttribute('aria-pressed', String(show));
});
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
