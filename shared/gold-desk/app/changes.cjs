const { earlier } = require('./currency.cjs');

function getChanges(current, history, snapshots) {
  if (!current) return { daily: null, weekly: null };
  const points = new Map(history.map((point) => [point.date, { ...point, basis: '历史日线' }]));
  for (const point of snapshots) points.set(point.date, { ...point, basis: '已保存报价' });
  const sorted = [...points.values()].sort((a, b) => a.date.localeCompare(b.date));

  function against(days) {
    const target = earlier(current.date, days);
    const minimum = earlier(target, 7);
    const point = sorted.findLast(({ date }) => date <= target && date >= minimum);
    if (!point || point.price <= 0) return null;
    return { date: point.date, exact: point.date === target, basis: point.basis, percent: (current.price / point.price - 1) * 100 };
  }

  return { daily: against(1), weekly: against(7) };
}

module.exports = { getChanges };
