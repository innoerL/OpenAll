const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../store.cjs');
const { Scheduler } = require('../scheduler.cjs');
const { forecast } = require('../outlook.cjs');
const { marketIsClosed } = require('../sources.cjs');
const { createFixture } = require('../fixture.cjs');
const { dateAt, dateBeforeYear, scheduledAt } = require('../time.cjs');

for (const pending of ['ctf', 'gold']) {
  test(`等待 ${pending} 历史就绪后才正式发行周大福预测，重复读取不改价`, async context => {
    const store = new Store(':memory:');
    context.after(() => store.close());
    const fixture = createFixture();
    const today = dateAt(fixture.clock());
    const rows = await fixture.sources[pending].history();
    store.saveHistory(pending, '2026-11-19', rows.filter(row => row.date < today));
    let complete;
    fixture.sources[pending].history = () => new Promise(resolve => { complete = () => resolve(rows); });
    let current;
    const scheduler = new Scheduler({ store, sources: fixture.sources, clock: fixture.clock, online: () => true,
      publish: () => { current = scheduler.snapshot(); } });
    context.after(() => scheduler.stop());
    const running = scheduler.tick('startup');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(current.outlook.forecasts.ctf.provisional, true);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM forecast_checks WHERE instrument='ctf'").get().n, 0);
    complete(); await running;
    assert.equal(current.outlook.forecasts.ctf.provisional, false);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM forecast_checks WHERE instrument='ctf'").get().n, 7);
    const saved = current.outlook.forecasts.ctf.days;
    scheduler.forecastCache = null;
    assert.deepEqual(scheduler.snapshot().outlook.forecasts.ctf.days, saved);
  });
}

test('七日预测补入前日实采牌价，排除非当日采集和旧单一备用来源', async context => {
  const store = new Store(':memory:');
  context.after(() => store.close());
  const fixture = createFixture();
  const today = dateAt(fixture.clock());
  const history = await fixture.sources.ctf.history();
  const yesterday = history.at(-2);
  const observed = { ...yesterday, price: yesterday.price - 25, quoteTime: null, note: '' };
  store.saveQuote('ctf', yesterday.date, observed, scheduledAt(yesterday.date));
  const saveOther = (row, source, fetchedAt) => store.saveQuote('ctf', row.date,
    { ...row, price: 9999, quoteTime: null, note: '', source }, fetchedAt);
  saveOther(history.at(-3), '搜金价', scheduledAt(history.at(-3).date));
  saveOther(history.at(-4), '离线测试样例', fixture.clock());
  fixture.sources.ctf.history = async () => history.filter(row => row.date !== yesterday.date);
  const scheduler = new Scheduler({ store, sources: fixture.sources, clock: fixture.clock, online: () => true, publish() {} });
  context.after(() => scheduler.stop());
  await scheduler.tick('startup');
  const snapshot = scheduler.snapshot();
  const goldHistory = await fixture.sources.gold.history();
  const expected = forecast({ instrument: 'ctf', quote: snapshot.instruments.ctf.quote, today, marketIsClosed,
    priceHistory: history.filter(row => row.date >= dateBeforeYear(today)).map(row => row.date === yesterday.date ? observed : row),
    goldHistory: goldHistory.filter(row => row.date >= dateBeforeYear(today)) });
  assert.ok(expected.days.every(day => day.pointMethod === 'joint-history'));
  assert.deepEqual(snapshot.outlook.forecasts.ctf.days, expected.days);
});
