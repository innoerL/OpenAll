const { DAY, dateAt, scheduledAt } = require('./time.cjs');
const { earlier } = require('./currency.cjs');
const { FACTORS } = require('./market-context.cjs');

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const dot = (left, right) => left.reduce((total, value, index) => total + value * right[index], 0);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const RISE_THRESHOLD = Math.log1p(0.002);
const FALL_THRESHOLD = Math.log1p(-0.002);
const DIRECTIONS = ['up', 'down', 'flat'];
const MODEL_VERSION = '2.0.0';
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

function estimateDirection(centre, residuals, horizon) {
  const scenarios = residuals.map((residual) => centre + residual);
  const groups = { up: [], down: [], flat: [] };
  for (const change of scenarios) groups[classifyReturn(change)].push(change);
  const preferred = classifyReturn(quantile(scenarios, .5));
  const direction = DIRECTIONS.reduce((selected, candidate) => {
    const difference = groups[candidate].length - groups[selected].length;
    return difference > 0 || (difference === 0 && candidate === preferred) ? candidate : selected;
  });
  const mid = quantile(groups[direction], .5);
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

function forecast({
  instrument, priceHistory, goldHistory, quote, macro, today, marketIsClosed, modelMode = 'history', offsets = [1, 2, 3, 4, 5, 6, 7],
}) {
  const points = priceHistory.filter(({ date, price }) =>
    date < today && price > 0 && (instrument !== 'gold' || !marketIsClosed(scheduledAt(date))));
  if (points.length < 30 || points.at(-1).date < earlier(today, 10)) return null;
  const last = points.at(-1);
  const anchor = quote && quote.date >= last.date && quote.date <= today ? quote : last;
  const factors = Object.keys(FACTORS).flatMap((id) => {
    const latest = marketFactor(macro?.[id] ?? [], today, id);
    return latest ? [{ id, ...FACTORS[id], ...latest }] : [];
  });
  const features = (date) => [
    ...[1, 5, 15].map((window) => momentum(points, earlier(date, 1), window)),
    ...(modelMode === 'macro' ? factors.map(({ id }) => marketFactor(macro[id], date, id)?.value ?? 0) : []),
    ...(modelMode === 'macro' && instrument === 'ctf' ? [momentum(goldHistory, earlier(date, 1), 5)] : []),
  ];
  const current = modelMode === 'history' ? [] : features(today);
  const days = [];
  const ctfHasSundays = instrument === 'ctf' &&
    points.filter((point) => new Date(point.date).getUTCDay() === 0).length > 5;
  for (const offset of offsets) {
    const date = dateAfter(today, offset);
    if (instrument === 'gold' && marketIsClosed(scheduledAt(date))) {
      days.push({ date, closed: true });
      continue;
    }
    if (instrument === 'ctf' && !ctfHasSundays && new Date(date).getUTCDay() === 0) {
      days.push({ date, sparse: true });
      continue;
    }
    const returns = historicalReturns(points, offset);
    const recent = returns.slice(-84).map(({ target }) => target);
    if (recent.length < 30) {
      days.push({ date, sparse: true });
      continue;
    }
    const model = modelMode === 'history' ? null : chooseModel(returns, features, current.length);
    const mid = model ? clamp(model.predict(current), -.07, .07) : 0;
    const estimate = estimateDirection(mid, model?.residuals ?? recent, offset);
    days.push({
      date,
      mid: anchor.price * Math.exp(estimate.mid),
      low: anchor.price * Math.exp(estimate.low),
      high: anchor.price * Math.exp(estimate.high),
      direction: estimate.direction,
      confidence: estimate.confidence,
      probabilities: estimate.probabilities,
      model: model?.label ?? '同期限历史频率',
      sample: model?.residuals.length ?? recent.length,
    });
  }
  return { anchor: { date: anchor.date, price: anchor.price }, factors, days };
}

module.exports = { MODEL_VERSION, DIRECTIONS, forecast, classifyReturn, estimateDirection, dateAfter };
