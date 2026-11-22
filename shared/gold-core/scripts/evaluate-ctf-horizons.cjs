#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { forecast, dateAfter, MODEL_VERSION } = require('../outlook.cjs');
const { dateBeforeYear, isDate } = require('../time.cjs');
const { marketIsClosed } = require('../sources.cjs');

const [filename, firstOrigin, lastTarget] = process.argv.slice(2);
if (process.argv.length !== 5 || !isDate(firstOrigin) || !isDate(lastTarget) || firstOrigin >= lastTarget) {
  console.error('用法：node shared/gold-core/scripts/evaluate-ctf-horizons.cjs <只读行情副本.sqlite> <首个基准日> <最后目标日>');
  process.exit(2);
}
const digest = data => createHash('sha256').update(data).digest('hex');
const database = new DatabaseSync(filename, { readOnly: true });
let history;
try {
  database.exec('PRAGMA query_only = ON; BEGIN');
  const query = database.prepare('SELECT date, price FROM history WHERE instrument = ? AND date <= ? ORDER BY date');
  history = Object.fromEntries(['ctf', 'gold'].map(instrument => [instrument, query.all(instrument, lastTarget)]));
} finally {
  database.close();
}
for (const rows of Object.values(history)) {
  assert(rows.length && rows.every(row => isDate(row.date) && Number.isFinite(row.price) && row.price > 0), '行情缺失或含无效日期、价格');
}

const horizons = [1, 2, 3, 4, 5, 6, 7];
const observed = new Map(history.ctf.map(row => [row.date, row.price]));
const scores = horizons.map(horizon => ({ horizon, missing: 0, unavailable: 0, errors: [], baselineErrors: [] }));
let origins = 0;
let firstEligible, lastEligible;
for (const anchor of history.ctf) {
  if (anchor.date < firstOrigin || anchor.date >= lastTarget) continue;
  // 使用已知当天牌价和此前最多一年的历史，排除北京时间取价时尚未知的当天国际收盘价。
  const since = dateBeforeYear(anchor.date);
  const prior = rows => rows.filter(row => row.date >= since && row.date < anchor.date);
  const priceHistory = prior(history.ctf);
  if (priceHistory.length < 120) continue;
  const result = forecast({ instrument: 'ctf', priceHistory, goldHistory: prior(history.gold), quote: anchor,
    today: anchor.date, marketIsClosed, offsets: horizons });
  if (result) {
    assert.equal(result.anchor.date, anchor.date, '基准日期发生偏移');
    assert.equal(result.anchor.price, anchor.price, '估算偏离当天已知牌价');
  }
  const days = new Map(result?.days.map(day => [day.date, day]) ?? []);
  origins++;
  firstEligible ??= anchor.date;
  lastEligible = anchor.date;
  for (const score of scores) {
    const target = dateAfter(anchor.date, score.horizon);
    if (target > lastTarget) continue;
    const actual = observed.get(target);
    if (actual === undefined) { score.missing++; continue; }
    const day = days.get(target);
    if (!Number.isFinite(day?.mid)) { score.unavailable++; continue; }
    score.errors.push(Math.abs(day.mid - actual));
    score.baselineErrors.push(Math.abs(anchor.price - actual));
  }
}

const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const number = value => value.toFixed(2);
const lines = [
  '# 周大福七日参考价历史回测', '',
  `模型 ${MODEL_VERSION}。基准日为 ${firstEligible} 至 ${lastEligible}，共 ${origins} 个。目标日截至 ${lastTarget}。`, '',
  '| 距基准日 | 配对数 | 缺目标牌价 | 缺参考价 | 逐日模型 MAE | 沿用当天牌价 MAE |',
  '| --- | ---: | ---: | ---: | ---: | ---: |',
];
for (const { horizon, missing, unavailable, errors, baselineErrors } of scores) {
  assert(errors.length, `第 ${horizon} 天没有可比较的样本`);
  lines.push(`| 第 ${horizon} 天 | ${errors.length} | ${missing} | ${unavailable} | ${number(mean(errors))} | ${number(mean(baselineErrors))} |`);
}
lines.push('', 'MAE 是预测与实际牌价的平均绝对差，单位为元/克，数值越小越好。两列在相同基准日、相同目标日比较。', '',
  '## 数据与复验', '',
  `历史数据含周大福 ${history.ctf.length} 个日价、国际现货 ${history.gold.length} 个日价。每个基准日至少有 120 个更早的周大福报价。计算时只传入基准日前的国际日线及周大福历史，以该日周大福牌价为已知输入。统计按目标自然日取实际牌价，缺报单列。各期限的有效日期可以不同。`, '',
  '日线历史缺少首次发布时间与历史修订快照，这次回测以历史日价代理北京时间 10 点时的已知牌价。脚本仅读取 history 表，未补入后来在本机采集的牌价。运行中的应用还会使用此前实际采集的有效日牌价。同一历史区间已用于评估旧模型，相邻预测也共享行情。误差描述本段历史表现，未来表现需继续用发布后的真实报价核验。', '',
  '在包含同一版模型的源码中运行以下命令可复验汇总。SQLite 连接为只读。', '',
  '\x60\x60\x60sh', `node shared/gold-core/scripts/evaluate-ctf-horizons.cjs /path/to/quotes.sqlite ${firstOrigin} ${lastTarget}`, '\x60\x60\x60', '',
  `日期和价格序列 SHA-256 为 \x60${digest(JSON.stringify(history))}\x60。模型文件 SHA-256 为 \x60${digest(readFileSync(require.resolve('../outlook.cjs')))}\x60。`);
console.log(lines.join('\n'));
