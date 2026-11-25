const { quoteStartAt, scheduledAt } = require('./time.cjs');
const { DIRECTIONS } = require('./outlook.cjs');

const CAPTURE_WINDOW = 15 * 60_000;

function onSchedule(date, fetchedAt) {
  return fetchedAt >= quoteStartAt(date) && fetchedAt <= scheduledAt(date) + CAPTURE_WINDOW;
}

function summarizeChecks(rows) {
  const positive = value => Number.isFinite(value) && value > 0;
  const prices = rows.filter(row => positive(row.mid) && positive(row.targetPrice));
  const intervals = rows.filter(row => positive(row.low) && positive(row.high) && row.low <= row.high && positive(row.targetPrice));
  const average = (values, value) => values.length ? values.reduce((sum, row) => sum + value(row), 0) / values.length : null;
  // 价格误差与区间各自统计有效样本；旧存档缺字段时不把缺失值当作零误差。
  const metrics = {
    priceCount: prices.length,
    mae: average(prices, row => Math.abs(row.mid - row.targetPrice)),
    mape: average(prices, row => Math.abs(row.mid - row.targetPrice) / row.targetPrice),
    baselineMAE: prices.every(row => positive(row.originPrice)) ? average(prices, row => Math.abs(row.originPrice - row.targetPrice)) : null,
    intervalCount: intervals.length,
    intervalCoverage: average(intervals, row => Number(row.low <= row.targetPrice && row.targetPrice <= row.high)),
  };
  const total = rows.length;
  if (!total) return { total: 0, buckets: [], ...metrics };
  const hit = rows.filter((row) => row.direction === row.actual).length;
  const meanConfidence = rows.reduce((sum, row) => sum + row.probabilities[row.direction], 0) / total;
  const brier = rows.reduce((sum, row) => sum + DIRECTIONS.reduce((score, direction) =>
    score + (row.probabilities[direction] - Number(direction === row.actual)) ** 2, 0), 0) / total;
  const groups = new Map();
  for (const row of rows) {
    const confidence = row.probabilities[row.direction];
    const from = Math.floor(Math.round(confidence * 100) / 10) * 10;
    const bucket = groups.get(from) ?? { from, total: 0, hit: 0, confidenceSum: 0 };
    bucket.total++;
    bucket.hit += Number(row.direction === row.actual);
    bucket.confidenceSum += confidence;
    groups.set(from, bucket);
  }
  const buckets = [...groups.values()].sort((a, b) => a.from - b.from).map((bucket) => ({
    from: bucket.from, total: bucket.total, hit: bucket.hit, meanConfidence: bucket.confidenceSum / bucket.total,
  }));
  return { total, hit, hitRate: hit / total, meanConfidence, brier, buckets, ...metrics };
}

module.exports = { onSchedule, summarizeChecks };
