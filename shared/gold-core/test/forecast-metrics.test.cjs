const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeChecks } = require('../forecast-verification.cjs');
const { Store } = require('../store.cjs');
const { MODEL_VERSION, modelVersionFor, classifyReturn, dateAfter } = require('../outlook.cjs');
const { scheduledAt } = require('../time.cjs');

const probabilities = { up: .6, down: .2, flat: .2 };
const estimate = extra => ({ direction: 'up', probabilities, confidence: 60, ...extra });
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} ≠ ${expected}`);
const quote = (date, price) => ({ date, price, quoteTime: null, source: '离线验证', note: '' });

function archive(store, options = {}) {
  const { instrument = 'ctf', version = modelVersionFor(instrument), origin = '2026-10-01', horizon = 1,
    originPrice = 100, targetPrice = 100, mid = 110, low = 95, high = 105,
    fetchedDelay = 0, issuedDelay = 0, targetDelay = 0 } = options;
  const target = dateAfter(origin, horizon);
  store.db.prepare(`INSERT INTO forecast_checks
    (model_version, instrument, origin, target, issued_at, origin_fetched_at, origin_price, estimate,
     target_fetched_at, target_price, actual) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(version, instrument, origin, target, scheduledAt(origin) + issuedDelay, scheduledAt(origin) + fetchedDelay,
      originPrice, JSON.stringify(estimate({ date: target, mid, low, high })), scheduledAt(target) + targetDelay,
      targetPrice, classifyReturn(Math.log(targetPrice / originPrice)));
}

test('价格误差、MAPE、不变价基线与区间覆盖使用各自的到期实际价格', () => {
  const result = summarizeChecks([
    estimate({ actual: 'up', mid: 100, originPrice: 95, targetPrice: 110, low: 90, high: 110 }),
    estimate({ actual: 'flat', mid: 120, originPrice: 100, targetPrice: 100, low: 105, high: 130 }),
  ]);
  assert.equal(result.total, 2);
  assert.equal(result.hit, 1);
  assert.equal(result.priceCount, 2);
  assert.equal(result.mae, 15);
  close(result.mape, (10 / 110 + 20 / 100) / 2);
  assert.equal(result.baselineMAE, 7.5);
  assert.equal(result.intervalCount, 2);
  assert.equal(result.intervalCoverage, .5);
  assert.equal(result.buckets[0].total, 2);
});

test('旧记录缺少点价或区间时独立计数，空样本不伪装为零误差', () => {
  const empty = summarizeChecks([]);
  assert.equal(empty.total, 0);
  assert.equal(empty.priceCount, 0);
  assert.equal(empty.intervalCount, 0);
  for (const key of ['mae', 'mape', 'baselineMAE', 'intervalCoverage']) assert.equal(empty[key], null);
  const result = summarizeChecks([
    estimate({ actual: 'up' }),
    estimate({ actual: 'up', mid: 100, targetPrice: 0, low: 90, high: 110 }),
    estimate({ actual: 'up', mid: 100, targetPrice: 100, low: 110, high: 90 }),
    estimate({ actual: 'up', mid: null, targetPrice: 100, low: 90, high: 110 }),
  ]);
  assert.equal(result.total, 4);
  assert.equal(result.priceCount, 1);
  assert.equal(result.mae, 0);
  assert.equal(result.mape, 0);
  assert.equal(result.baselineMAE, null);
  assert.equal(result.intervalCount, 1);
  assert.equal(result.intervalCoverage, 1);
});

test('当前版本按期限隔离准时与迟到统计，最近明日价对照使用百分比', context => {
  const store = new Store(':memory:');
  context.after(() => store.close());
  archive(store);
  archive(store, { origin: '2026-09-30', horizon: 3, mid: 90 });
  archive(store, { origin: '2026-10-02', mid: 140, fetchedDelay: 16 * 60_000 });
  archive(store, { origin: '2026-10-03', mid: 140, issuedDelay: 16 * 60_000 });
  archive(store, { origin: '2026-10-04', mid: 140, targetDelay: 16 * 60_000 });
  archive(store, { version: 'previous-test-version', origin: '2026-10-05', mid: 9000 });
  const before = store.db.prepare('SELECT * FROM forecast_checks ORDER BY origin, model_version').all();
  const result = store.forecastStats('ctf');
  assert.equal(result.version, MODEL_VERSION);
  assert.equal(result.units, 'CNY/g');
  assert.equal(result.byHorizon[1].priceCount, 1);
  assert.equal(result.byHorizon[1].mae, 10);
  assert.equal(result.byHorizon[3].priceCount, 1);
  assert.equal(result.byHorizon[7].mae, null);
  assert.equal(result.late, 3);
  assert.equal(result.lateByHorizon[1].priceCount, 3);
  assert.equal(result.lateByHorizon[1].mae, 40);
  close(result.lateByHorizon[1].mape, .4);
  assert.equal(result.recent.horizon, 1);
  assert.equal(result.recent.target, '2026-10-05');
  assert.equal(result.recent.onSchedule, false);
  close(result.recent.predictedReturn, .4);
  assert.equal(result.recent.actualReturn, 0);
  close(result.recent.errorRate, .4);
  assert.deepEqual(store.db.prepare('SELECT * FROM forecast_checks ORDER BY origin, model_version').all(), before, '评价读取不改写任何新旧预测');
});

test('首次预测与首次结算保持不变，同日新计算及后续报价修正不重写评价', context => {
  const store = new Store(':memory:');
  context.after(() => store.close());
  const origin = '2026-10-01', target = dateAfter(origin, 1), started = scheduledAt(origin);
  store.saveQuote('ctf', origin, quote(origin, 100), started);
  const forecast = { anchor: { date: origin, price: 100, fromQuote: true }, days: [estimate({ date: target, mid: 103, low: 99, high: 108 })] };
  store.issueForecast('ctf', origin, store.latestQuote('ctf'), forecast, started + 1000);
  const read = () => store.db.prepare('SELECT * FROM forecast_checks WHERE model_version = ?').get(MODEL_VERSION);
  const frozen = read();
  const changed = { ...forecast, days: [estimate({ date: target, mid: 999, low: 1, high: 9999 })] };
  assert.deepEqual(store.issueForecast('ctf', origin, store.latestQuote('ctf'), changed, started + 2000).days, forecast.days);
  assert.deepEqual(read(), frozen);
  store.saveQuote('ctf', target, quote(target, 110), scheduledAt(target));
  const settled = read();
  store.saveQuote('ctf', target, quote(target, 95), scheduledAt(target) + 1000);
  assert.deepEqual(read(), settled);
  const result = store.forecastStats('ctf');
  assert.equal(result.byHorizon[1].mae, 7);
  close(result.byHorizon[1].mape, 7 / 110);
  close(result.recent.predictedReturn, .03);
  close(result.recent.actualReturn, .1);
});

test('升级当天分别保存两个周大福模型的发行时间和原价，重复刷新读取本版存档', context => {
  const store = new Store(':memory:');
  context.after(() => store.close());
  const origin = '2026-10-01', started = scheduledAt(origin), target = dateAfter(origin, 1);
  const oldDay = estimate({ date: target, mid: 100, low: 97, high: 106, pointMethod: 'persistence' });
  store.db.prepare(`INSERT INTO forecast_checks
    (model_version, instrument, origin, target, issued_at, origin_fetched_at, origin_price, estimate)
    VALUES ('3.0.0', 'ctf', ?, ?, ?, ?, 100, ?)`).run(origin, target, started, started, JSON.stringify(oldDay));
  store.saveQuote('ctf', origin, quote(origin, 100), started);
  const currentQuote = store.latestQuote('ctf');
  const next = { version: MODEL_VERSION, anchor: { date: origin, price: 100, fromQuote: true },
    days: [estimate({ date: target, mid: 103, low: 98, high: 108, pointMethod: 'joint-history' })] };
  const issue = (value, canIssue) => store.issueForecast('ctf', origin, currentQuote, value, started + 60_000, canIssue);
  assert.deepEqual(issue(null, false).days, [oldDay]);
  assert.equal(issue(next, false).provisional, true);
  const issued = issue(next, true);
  assert.equal(issued.provisional, false);
  assert.equal(issued.version, MODEL_VERSION);
  assert.deepEqual(issued.days, next.days);
  assert.deepEqual(issue(null, false).days, next.days);
  assert.deepEqual(issue({ ...next, days: [oldDay] }, true).days, next.days);
  const rows = store.db.prepare('SELECT estimate, issued_at AS time FROM forecast_checks ORDER BY issued_at').all();
  assert.deepEqual(rows.map(row => [JSON.parse(row.estimate).mid, row.time]), [[100, started], [103, started + 60_000]]);
  store.saveQuote('ctf', target, quote(target, 104), scheduledAt(target));
  assert.equal(store.forecastStats('ctf', '3.0.0').byHorizon[1].mae, 4);
  assert.equal(store.forecastStats('ctf').byHorizon[1].mae, 1);
});

test('历史更新期间只展示暂估，首次就绪才存档，已发行内容不退回暂估', context => {
  const store = new Store(':memory:');
  context.after(() => store.close());
  const origin = '2026-10-01', started = scheduledAt(origin);
  store.saveQuote('ctf', origin, quote(origin, 100), started);
  const forecast = { version: MODEL_VERSION, anchor: { date: origin, price: 100, fromQuote: true },
    days: [estimate({ date: dateAfter(origin, 1), mid: 103, low: 99, high: 108 })] };
  const provisional = store.issueForecast('ctf', origin, store.latestQuote('ctf'), forecast, started, false);
  assert.equal(provisional.provisional, true);
  assert.equal(forecast.provisional, undefined, '暂估标记不修改调用方对象');
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM forecast_checks').get().count, 0);
  const issued = store.issueForecast('ctf', origin, store.latestQuote('ctf'), forecast, started + 1000);
  assert.equal(issued.provisional, false);
  const restored = store.issueForecast('ctf', origin, null, provisional, started + 2000, false);
  assert.equal(restored.provisional, false);
  assert.deepEqual(restored.days, issued.days);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM forecast_checks').get().count, 1);
});

for (const instrument of ['gold', 'ctf']) {
  test(`${instrument} 旧七日存档只返回前三日，七日到期仍可按原版结算`, context => {
    const store = new Store(':memory:');
    context.after(() => store.close());
    const origin = '2026-10-01', started = scheduledAt(origin);
    const version = instrument === 'gold' ? '3.0.0' : '4.0.0';
    const save = store.db.prepare(`INSERT INTO forecast_checks
      (model_version, instrument, origin, target, issued_at, origin_fetched_at, origin_price, estimate)
      VALUES (?, ?, ?, ?, ?, ?, 100, ?)`);
    const days = Array.from({ length: 7 }, (_, index) => estimate({ date: dateAfter(origin, index + 1), mid: 105 }));
    for (const day of days) save.run(version, instrument, origin, day.date, started, started, JSON.stringify(day));
    const restored = store.issueForecast(instrument, origin, null, null, started, false);
    assert.equal(restored.version, version);
    assert.deepEqual(restored.days, days.slice(0, 3));
    store.saveQuote(instrument, origin, quote(origin, 100), started);
    const current = { anchor: { date: origin, price: 100, fromQuote: true }, days: days.map(day => ({ ...day, mid: 103 })) };
    const issued = store.issueForecast(instrument, origin, store.latestQuote(instrument), current, started + 1000);
    assert.equal(issued.version, modelVersionFor(instrument));
    assert.deepEqual(issued.days, (instrument === 'gold' ? current.days : days).slice(0, 3));
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM forecast_checks').get().n, instrument === 'gold' ? 10 : 7);
    for (const horizon of [2, 7]) {
      const date = dateAfter(origin, horizon);
      store.saveQuote(instrument, date, quote(date, 110), scheduledAt(date));
      assert.equal(store.forecastStats(instrument, version).byHorizon[horizon].mae, 5);
    }
    if (instrument === 'gold') assert.equal(store.forecastStats('gold').byHorizon[2].mae, 7);
  });
}

test('显式版本统计与当前默认版本各自独立，版本查询不改写存档', context => {
  const store = new Store(':memory:');
  context.after(() => store.close());
  archive(store, { version: 'previous-test-version', mid: 150 });
  archive(store, { mid: 105 });
  const before = store.db.prepare('SELECT * FROM forecast_checks ORDER BY model_version').all();
  const previous = store.forecastStats('ctf', 'previous-test-version');
  assert.equal(previous.version, 'previous-test-version');
  assert.equal(previous.byHorizon[1].priceCount, 1);
  assert.equal(previous.byHorizon[1].mae, 50);
  close(previous.recent.predictedReturn, .5);
  assert.equal(store.forecastStats('ctf').byHorizon[1].mae, 5);
  assert.equal(store.forecastStats('ctf', 'not-issued').byHorizon[1].priceCount, 0);
  assert.deepEqual(store.db.prepare('SELECT * FROM forecast_checks ORDER BY model_version').all(), before);
});

test('黄金原始MAE注明美元每金衡盎司，比例误差与覆盖不受每克换算影响', context => {
  const store = new Store(':memory:');
  context.after(() => store.close());
  archive(store, { instrument: 'gold', mid: 3530, originPrice: 3500, targetPrice: 3510, low: 3450, high: 3550 });
  const result = store.forecastStats('gold');
  assert.equal(result.units, 'USD/troy-oz');
  assert.equal(result.byHorizon[1].mae, 20);
  const converted = summarizeChecks([estimate({ actual: 'up', mid: 3530 / 31.1034768, originPrice: 3500 / 31.1034768,
    targetPrice: 3510 / 31.1034768, low: 3450 / 31.1034768, high: 3550 / 31.1034768 })]);
  close(result.byHorizon[1].mape, converted.mape);
  assert.equal(result.byHorizon[1].intervalCoverage, converted.intervalCoverage);
  close(result.recent.errorRate, 20 / 3510);
});
