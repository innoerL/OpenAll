const { scheduledAt } = require('./time.cjs');
const { DIRECTIONS } = require('./outlook.cjs');

const CAPTURE_WINDOW = 15 * 60_000;

function onSchedule(date, fetchedAt) {
  const delay = fetchedAt - scheduledAt(date);
  return delay >= 0 && delay <= CAPTURE_WINDOW;
}

function summarizeChecks(rows) {
  const total = rows.length;
  if (!total) return { total: 0, buckets: [] };
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
  return { total, hit, hitRate: hit / total, meanConfidence, brier, buckets };
}

module.exports = { onSchedule, summarizeChecks };
