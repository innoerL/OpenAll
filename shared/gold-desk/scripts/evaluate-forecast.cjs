const { DatabaseSync } = require('node:sqlite');
const { readFileSync } = require('node:fs');
const { forecast, classifyReturn, dateAfter } = require('../app/outlook.cjs');
const { summarizeChecks } = require('../app/forecast-verification.cjs');
const { dateBeforeYear, scheduledAt } = require('../app/time.cjs');
const { marketIsClosed } = require('../app/sources.cjs');

const [filename, cutoff, period, hourlyFilename] = process.argv.slice(2);
if (!filename || !cutoff || !['development', 'holdout'].includes(period)) {
  process.stderr.write('用法：node scripts/evaluate-forecast.cjs <行情.sqlite> <分界日期> <development|holdout> [北京时间10点金价JSON]\n');
  process.exit(2);
}
const db = new DatabaseSync(filename, { readOnly: true });
const history = db.prepare('SELECT date, price FROM history WHERE instrument = ? ORDER BY date');
const context = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'marketContext'").get()?.value ?? '{}');
const goldHistory = hourlyFilename ? JSON.parse(readFileSync(hourlyFilename, 'utf8')) : history.all('gold');
const modes = ['history', 'price', 'macro'];
const offsets = [1, 3, 7];
const report = {
  cutoff, period,
  basis: { gold: hourlyFilename ? '北京时间10点历史点位' : '日线收盘代理', ctf: '日牌价代理', macro: 'FRED 最新存档，按固定滞后截断' },
};

for (const instrument of ['gold', 'ctf']) {
  const rows = instrument === 'gold' ? goldHistory : history.all(instrument);
  const points = new Map(rows.map(({ date, price }) => [date, price]));
  const checks = Object.fromEntries(offsets.map((offset) => [offset, Object.fromEntries(modes.map((mode) => [mode, []]))]));
  // 预留充足历史。两段之间删除跨分界的目标，所有方法使用相同的目标样本。
  for (const [index, quote] of rows.entries()) {
    if (index < 120 || (period === 'holdout' ? quote.date < cutoff : quote.date >= cutoff)) continue;
    if (instrument === 'gold' && marketIsClosed(scheduledAt(quote.date))) continue;
    const date = quote.date;
    const windowStart = dateBeforeYear(date);
    const forecasts = modes.map((modelMode) => forecast({
      instrument, priceHistory: rows.slice(0, index).filter((point) => point.date >= windowStart),
      goldHistory, quote, macro: context.macro, today: date, marketIsClosed, modelMode, offsets,
    }));
    for (const [position, offset] of offsets.entries()) {
      const target = dateAfter(date, offset);
      if (!points.has(target) || (period === 'development' && target >= cutoff)) continue;
      const estimates = forecasts.map((result) => result?.days[position]);
      if (!estimates.every((estimate) => estimate?.probabilities)) continue;
      const actual = classifyReturn(Math.log(points.get(target) / quote.price));
      for (const [index, mode] of modes.entries()) {
        const { direction, probabilities, model } = estimates[index];
        checks[offset][mode].push({ date, target, direction, probabilities, actual, model });
      }
    }
  }
  report[instrument] = Object.fromEntries(offsets.map((offset) => [
    offset,
    Object.fromEntries(modes.map((mode) => {
      const rows = checks[offset][mode];
      const selected = rows.reduce((counts, { model }) => {
        counts[model] = (counts[model] ?? 0) + 1;
        return counts;
      }, {});
      return [mode, {
        ...summarizeChecks(rows), firstOrigin: rows[0]?.date, lastOrigin: rows.at(-1)?.date, lastTarget: rows.at(-1)?.target, selected,
      }];
    })),
  ]));
}

console.log(JSON.stringify(report, null, 2));
db.close();
