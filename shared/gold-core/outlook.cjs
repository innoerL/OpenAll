const { DAY, dateAt, scheduledAt } = require('./time.cjs');
const { earlier } = require('./currency.cjs');
const { FACTORS } = require('./market-context.cjs');

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const dot = (left, right) => left.reduce((total, value, index) => total + value * right[index], 0);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const RISE_THRESHOLD = Math.log1p(0.002);
const FALL_THRESHOLD = Math.log1p(-0.002);
const DIRECTIONS = ['up', 'down', 'flat'];
const MODEL_VERSION = '4.0.0';
const modelVersionFor = (instrument) => instrument === 'ctf' ? MODEL_VERSION : '3.0.0';
const dateAfter = (date, days) => dateAt(scheduledAt(date) + days * DAY);

function quantile(values, rank) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * rank)];
}

function classifyReturn(logReturn) {
  if (logReturn > RISE_THRESHOLD) return 'up';
  if (logReturn < FALL_THRESHOLD) return 'down';
  return 'flat';
}

function estimateDirection(centre, residuals, horizon, pointMode = 'directional') {
  const scenarios = residuals.map((residual) => centre + residual);
  const groups = { up: [], down: [], flat: [] };
  for (const change of scenarios) groups[classifyReturn(change)].push(change);
  const preferred = classifyReturn(quantile(scenarios, .5));
  const direction = DIRECTIONS.reduce((selected, candidate) => {
    const difference = groups[candidate].length - groups[selected].length;
    return difference > 0 || (difference === 0 && candidate === preferred) ? candidate : selected;
  });
  const mid = pointMode === 'model' ? centre : quantile(pointMode === 'median' ? scenarios : groups[direction], .5);
  const floor = .004 * Math.sqrt(horizon);
  const probabilities = Object.fromEntries(DIRECTIONS.map((label) => [label, (groups[label].length + 1) / (scenarios.length + 3)]));
  return {
    direction,
    confidence: Math.round(100 * probabilities[direction]),
    probabilities,
    mid,
    low: Math.min(quantile(scenarios, .10), mid - floor),
    high: Math.max(quantile(scenarios, .90), mid + floor),
  };
}

function priorIndex(rows, date) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (rows[middle].date <= date) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

function marketFactor(rows, date, id) {
  const factor = FACTORS[id];
  const index = priorIndex(rows, earlier(date, factor.lag));
  const latest = rows[index];
  const earlierPoint = rows[index - 5];
  if (!earlierPoint || latest.date < earlier(date, 16)) return null;
  const value = id === 'DFII10' ? latest.price - earlierPoint.price : Math.log(latest.price / earlierPoint.price);
  return { date: latest.date, value, change: id === 'DFII10' ? value * 100 : Math.expm1(value) * 100 };
}

function momentum(rows, date, width) {
  const index = priorIndex(rows, date);
  if (index < width) return 0;
  return Math.log(rows[index].price / rows[index - width].price);
}

function historicalReturns(points, horizon) {
  const byDate = new Map(points.map(({ date, price }) => [date, price]));
  return points.flatMap(({ date, price }) => {
    const end = dateAfter(date, horizon);
    return byDate.has(end) ? [{ date, end, target: Math.log(byDate.get(end) / price) }] : [];
  });
}

function fit(examples, count) {
  const features = examples.map(({ values }) => values.slice(0, count));
  const targets = examples.map(({ target }) => target);
  const centre = mean(targets);
  const centres = features[0].map((_, index) => mean(features.map((values) => values[index])));
  const scales = centres.map((middle, index) => Math.sqrt(mean(features.map((values) => (values[index] - middle) ** 2))) || 1);
  const normalized = (values) => centres.map((middle, index) => clamp((values[index] - middle) / scales[index], -4, 4));
  const matrix = Array.from({ length: count }, (_, row) => Array.from({ length: count + 1 }, (_, col) =>
    col === row ? features.length * .22 : 0,
  ));

  for (const [index, values] of features.entries()) {
    const x = normalized(values);
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) matrix[row][col] += x[row] * x[col];
      matrix[row][count] += x[row] * (targets[index] - centre);
    }
  }
  for (let col = 0; col < count; col++) {
    const divisor = matrix[col][col];
    for (let cell = col; cell <= count; cell++) matrix[col][cell] /= divisor;
    for (let row = 0; row < count; row++) {
      if (row === col) continue;
      const multiplier = matrix[row][col];
      for (let cell = col; cell <= count; cell++) matrix[row][cell] -= multiplier * matrix[col][cell];
    }
  }
  const weights = matrix.map((row) => row[count]);
  return (values) => centre + dot(weights, normalized(values));
}

function chooseModel(returns, feature, featureCount) {
  // 按日期推进验证；每次训练只看该次预测时已经结束的目标区间。
  const examples = returns.slice(16).map((sample) => ({ ...sample, values: feature(sample.date) }));
  const start = Math.max(48, examples.length - 84);
  const validationCount = examples.length - start;
  const assessmentCount = Math.floor(validationCount * .55);
  if (validationCount - assessmentCount < 12) return null;

  const candidates = [
    { label: '价格不变', count: 0, residuals: [] },
    { label: '近期动量', count: Math.min(3, featureCount), residuals: [] },
  ];
  if (featureCount > 3) candidates.push({ label: '多因素模型', count: featureCount, residuals: [] });
  for (let index = start; index < examples.length; index++) {
    const current = examples[index];
    if ((index - start) % 8 === 0) {
      const train = examples.slice(0, index).filter(({ end }) => end <= current.date).slice(-180);
      for (const candidate of candidates) candidate.predict = candidate.count ? fit(train, candidate.count) : () => 0;
    }
    for (const candidate of candidates) candidate.residuals.push(current.target - candidate.predict(current.values));
  }

  // 先使用较早的验证段选模型，再用之后的留出段估计方向可信度。
  for (const candidate of candidates) candidate.error = mean(candidate.residuals.slice(0, assessmentCount).map(Math.abs));
  const baseline = candidates[0];
  const best = candidates.reduce((best, sample) => sample.error < best.error * .98 ? sample : best, baseline);
  const residuals = best.residuals.slice(assessmentCount);
  return {
    label: best.label,
    residuals,
    predict: best.count ? fit(examples.slice(-180), best.count) : () => 0,
  };
}

// 使用实际报价间隔，假日可以沿用上次收盘；过期数据与真实的零涨跌分开处理。
function recentMoves(rows, date) {
  const index = priorIndex(rows, date);
  if (index < 3 || rows[index].date < earlier(date, 4) || rows[index - 3].date < earlier(date, 12)) return null;
  const price = rows[index].price;
  return [Math.log(price / rows[index - 1].price), Math.log(price / rows[index - 3].price)];
}

function fitRetailReturn(samples) {
  const train = samples.slice(-180);
  const predict = fit(train, 4);
  const targets = train.map(({ target }) => target);
  const lower = quantile(targets, .05);
  const upper = quantile(targets, .95);
  // 在已有收益范围内向零收缩，避免把少数几天的动量原样外推一周。
  return (values) => .5 * clamp(predict(values), lower, upper);
}

function retailForecast(points, goldHistory, anchor, marketIsClosed) {
  const prior = points.filter(({ date }) => date < anchor.date);
  const retail = [...prior, anchor];
  const gold = (goldHistory ?? []).filter(({ date, price }) =>
    date < anchor.date && Number.isFinite(price) && price > 0 && !marketIsClosed(scheduledAt(date)));
  const features = new Map();
  for (const { date } of retail) {
    const local = recentMoves(retail, date);
    const spot = recentMoves(gold, earlier(date, 1));
    if (local && spot) features.set(date, [...local, ...spot]);
  }
  const current = features.get(anchor.date);
  return (date, horizon) => {
    if (!current) {
      const sparseReason = recentMoves(retail, anchor.date) ? 'gold-history' : 'ctf-history';
      return { date, sparse: true, sparseReason };
    }
    // 每个自然日跨度单独拟合；历史目标必须有实际牌价，绝不把休市日填成一条观测。
    const samples = historicalReturns(prior, horizon).filter((sample) => features.has(sample.date))
      .map((sample) => ({ ...sample, values: features.get(sample.date) }));
    if (samples.length < 30) return { date, sparse: true, sparseReason: 'paired-history' };
    const residuals = [];
    // 在历次原点只用当时已结束的训练目标。每八个原点重估一次，控制快照开销。
    const start = Math.max(20, samples.length - 60);
    for (let first = start; first < samples.length; first += 8) {
      const block = samples.slice(first, first + 8);
      const train = samples.slice(0, first).filter(({ end }) => end <= block[0].date);
      if (train.length < 12) continue;
      const predict = fitRetailReturn(train);
      for (const sample of block) residuals.push(sample.target - predict(sample.values));
    }
    if (residuals.length < 8) return { date, sparse: true, sparseReason: 'paired-history' };
    const centre = fitRetailReturn(samples)(current);
    const estimate = estimateDirection(centre, residuals, horizon, 'model');
    return priceDay(date, anchor.price, estimate, '周大福与国际现货近期涨跌', 'joint-history', residuals.length);
  };
}

function priceDay(date, price, estimate, model, pointMethod, sample) {
  return {
    date,
    mid: price * Math.exp(estimate.mid),
    low: price * Math.exp(estimate.low),
    high: price * Math.exp(estimate.high),
    direction: estimate.direction, confidence: estimate.confidence, probabilities: estimate.probabilities,
    model, pointMethod, sample,
  };
}

function forecast({
  instrument, priceHistory, goldHistory, quote, macro, today, marketIsClosed, modelMode = 'auto', offsets = [1, 2, 3, 4, 5, 6, 7],
}) {
  const points = priceHistory.filter(({ date, price }) =>
    date < today && Number.isFinite(price) && price > 0 && (instrument !== 'gold' || !marketIsClosed(scheduledAt(date))));
  if (points.length < 30 || points.at(-1).date < earlier(today, 10)) return null;
  const last = points.at(-1);
  const anchor = quote && Number.isFinite(quote.price) && quote.price > 0 && quote.date >= last.date && quote.date <= today ? quote : last;
  const retailDay = modelMode === 'auto' && instrument === 'ctf' ? retailForecast(points, goldHistory, anchor, marketIsClosed) : null;
  const effectiveMode = modelMode === 'auto' ? 'history' : modelMode;
  const featurePoints = instrument === 'ctf' && anchor.date > last.date ? [...points, anchor] : points;
  const factors = Object.keys(FACTORS).flatMap((id) => {
    const latest = marketFactor(macro?.[id] ?? [], today, id);
    return latest ? [{ id, ...FACTORS[id], ...latest }] : [];
  });
  const features = (date) => [
    ...[1, 5, 15].map((window) => momentum(featurePoints, instrument === 'ctf' ? date : earlier(date, 1), window)),
    ...(effectiveMode === 'macro' ? factors.map(({ id }) => marketFactor(macro[id], date, id)?.value ?? 0) : []),
    ...(effectiveMode === 'macro' && instrument === 'ctf' ? [momentum(goldHistory, earlier(date, 1), 5)] : []),
  ];
  const current = effectiveMode === 'history' ? [] : features(anchor.date);
  const days = [];
  const ctfHasSundays = instrument === 'ctf' &&
    points.filter((point) => new Date(point.date).getUTCDay() === 0).length > 5;
  for (const offset of offsets) {
    const date = dateAfter(today, offset);
    // 基准报价可能早于展示日；预测跨度必须从真实基准日算到目标日。
    const horizon = Math.round((scheduledAt(date) - scheduledAt(anchor.date)) / DAY);
    if (retailDay) {
      days.push(retailDay(date, horizon));
      continue;
    }
    if (instrument === 'gold' && marketIsClosed(scheduledAt(date))) {
      days.push({ date, closed: true });
      continue;
    }
    if (instrument === 'ctf' && !ctfHasSundays && new Date(date).getUTCDay() === 0) {
      days.push({ date, sparse: true });
      continue;
    }
    const returns = historicalReturns(points, horizon);
    const recent = returns.slice(-84).map(({ target }) => target);
    if (recent.length < 30) {
      days.push({ date, sparse: true });
      continue;
    }
    const model = effectiveMode === 'history' ? null : chooseModel(returns, features, current.length);
    const mid = model ? clamp(model.predict(current), -.07, .07) : 0;
    const estimate = estimateDirection(mid, model?.residuals ?? recent, horizon,
      effectiveMode === 'history' ? 'directional' : 'median');
    days.push(priceDay(date, anchor.price, estimate, model?.label ?? '同期限历史频率',
      effectiveMode === 'history' ? 'directional-median' : 'median', model?.residuals.length ?? recent.length));
  }
  return { version: modelVersionFor(instrument), anchor: { date: anchor.date, price: anchor.price }, factors, days };
}

module.exports = { MODEL_VERSION, modelVersionFor, DIRECTIONS, forecast, classifyReturn, estimateDirection, dateAfter };
