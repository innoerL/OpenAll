const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Scheduler } = require('../app/scheduler.cjs');
const { Store } = require('../app/store.cjs');
const { dateAt, scheduledAt, dateBeforeYear, HALF_HOUR, DAY } = require('../app/time.cjs');
const { createSources, parseCtfHistory, parseGold, parseGoldHistory, parseOfficialCtf } = require('../app/sources.cjs');
const { convertGold, cutoffDate, parseFx, GRAMS_PER_TROY_OUNCE } = require('../app/currency.cjs');

const when = (time) => Date.parse(`2026-11-20T${time}:00+08:00`);
const quote = (date, price = 3500) => ({ date, price, quoteTime: null, source: '测试源', note: '' });

function harness(context, { initial = '09:50', goldQuote, ctfQuote, connected = true, disk = false } = {}) {
  let now = when(initial);
  let online = connected;
  const calls = { gold: 0, ctf: 0 };
  const directory = disk ? fs.mkdtempSync(path.join(os.tmpdir(), 'gold-desk-test-')) : null;
  const filename = directory ? path.join(directory, 'db.sqlite') : ':memory:';
  let store = new Store(filename);
  const sources = {
    gold: { quote: async () => { calls.gold++; return goldQuote ? goldQuote() : quote(dateAt(now)); }, history: async () => [] },
    ctf: { quote: async () => { calls.ctf++; return ctfQuote ? ctfQuote() : quote(dateAt(now), 1132); }, history: async () => [] },
  };
  const create = () => new Scheduler({ store, sources, online: () => online, publish() {}, clock: () => now });
  let scheduler = create();
  context.after(() => {
    scheduler.stop();
    store.close();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    calls,
    get scheduler() { return scheduler; },
    go: (time) => { now = when(time); },
    online: (connected) => { online = connected; },
    restart: () => {
      scheduler.stop();
      store.close();
      store = new Store(filename);
      scheduler = create();
    },
  };
}

test('北京时间整点取价，首次 10 点前启动只加载历史', async (context) => {
  const h = harness(context);
  await h.scheduler.tick('startup');
  assert.deepEqual(h.calls, { gold: 0, ctf: 0 });
  h.go('10:00');
  await h.scheduler.tick();
  assert.deepEqual(h.calls, { gold: 1, ctf: 1 });
  await h.scheduler.tick('resume');
  assert.deepEqual(h.calls, { gold: 1, ctf: 1 });
  assert.equal(scheduledAt('2026-11-20'), Date.parse('2026-11-20T02:00:00Z'));
  assert.equal(dateBeforeYear('2024-02-29'), '2023-02-28');
});

test('10 点后首次启动立即补拉，成功后重启不重复', async (context) => {
  const h = harness(context, { initial: '10:48', disk: true });
  await h.scheduler.tick('startup');
  assert.deepEqual(h.calls, { gold: 1, ctf: 1 });
  h.restart();
  await h.scheduler.tick('startup');
  assert.deepEqual(h.calls, { gold: 1, ctf: 1 });
  assert.equal(h.scheduler.snapshot().instruments.gold.quote.date, '2026-11-20');
});

test('10 点断网时无请求，恢复联网立即触发两项补拉', async (context) => {
  const h = harness(context, { initial: '10:00', connected: false });
  await h.scheduler.tick('startup');
  assert.deepEqual(h.calls, { gold: 0, ctf: 0 });
  h.go('10:07');
  h.online(true);
  await h.scheduler.tick('reconnect');
  assert.deepEqual(h.calls, { gold: 1, ctf: 1 });
});

test('失败后每隔半小时重试，成功项目独立停止', async (context) => {
  let remaining = 2;
  const h = harness(context, {
    initial: '10:00',
    ctfQuote() {
      if (remaining-- > 0) throw new Error('暂无当日牌价');
      return quote('2026-11-20', 1132);
    },
  });
  await h.scheduler.tick();
  assert.equal(h.scheduler.snapshot().instruments.ctf.retryAt, when('10:00') + HALF_HOUR);
  h.go('10:29');
  await h.scheduler.tick();
  assert.deepEqual(h.calls, { gold: 1, ctf: 1 });
  h.go('10:30');
  await h.scheduler.tick();
  assert.equal(h.scheduler.snapshot().instruments.ctf.retryAt, when('11:00'));
  h.go('11:00');
  await h.scheduler.tick();
  h.go('11:30');
  await h.scheduler.tick();
  assert.deepEqual(h.calls, { gold: 1, ctf: 3 });
  assert.equal(h.scheduler.snapshot().instruments.ctf.status, 'done');
});

test('唤醒和重连同时触发时，同品种只发一次请求', async (context) => {
  let finish;
  const h = harness(context, { initial: '10:00', goldQuote: () => new Promise((resolve) => { finish = resolve; }) });
  const initial = h.scheduler.tick('resume');
  await h.scheduler.tick('reconnect');
  assert.deepEqual(h.calls, { gold: 1, ctf: 1 });
  finish(quote('2026-11-20'));
  await initial;
  assert.equal(h.scheduler.snapshot().instruments.gold.status, 'done');
});

test('官网只读取当日足金饰品字段，并拒绝前一天牌价', async () => {
  const original = '更新于2026年11月20日 09:44:17\n足金 （饰品、工艺品类） 1088 元/克\n工艺金章金条类 957 元/克';
  const actual = parseOfficialCtf(original);
  assert.equal(actual.price, 1088);
  assert.equal(actual.quoteTime, '2026-11-20T01:44:17.000Z');
  const mockFetch = async () => new Response('<body>暂无</body>');
  const stale = () => parseOfficialCtf(original.replace('20日', '19日'));
  await assert.rejects(createSources(mockFetch, () => when('10:00'), stale).ctf.quote(), /尚未核实/);
});

test('升级替换旧来源当天的缓存，不重复拉取已核实的新版报价', async (context) => {
  const store = new Store(':memory:');
  context.after(() => store.close());
  const time = when('11:00');
  const slot = dateAt(time);
  store.saveQuote('ctf', slot, { ...quote(slot, 1132), source: '上海有色网' }, time);
  store.recheckOldCtfQuote(slot);
  assert.equal(store.job('quote', 'ctf', slot).status, 'retry');
  store.saveQuote('ctf', slot, { ...quote(slot, 1088), source: '周大福官方商城' }, time + 1000);
  store.recheckOldCtfQuote(slot);
  assert.equal(store.latestQuote('ctf').price, 1088);
  assert.equal(store.job('quote', 'ctf', slot).status, 'done');
});

test('保存第一次同日报价展望，只有准确目标日的取价能回填，补拉单独统计', (context) => {
  const store = new Store(':memory:');
  context.after(() => store.close());
  const origin = '2026-11-20';
  const started = scheduledAt(origin);
  const initial = quote(origin, 100);
  const probabilities = { up: .6, flat: .2, down: .2 };
  const first = { date: '2026-11-21', direction: 'up', probabilities, confidence: 60 };
  const forecast = {
    anchor: { date: origin, price: 100, fromQuote: true },
    days: [first, { date: '2026-11-22', sparse: true }, { ...first, date: '2026-11-23' }, { ...first, date: '2026-11-27' }],
  };
  store.saveQuote('ctf', origin, initial, started);
  store.issueForecast('ctf', origin, store.latestQuote('ctf'), forecast, started + 5000);
  const rerun = { ...forecast, days: forecast.days.map((day) => ({ ...day, confidence: 100 })) };
  assert.deepEqual(store.issueForecast('ctf', origin, store.latestQuote('ctf'), rerun, started + 8000).days, forecast.days);
  const save = (day, offset, price, delay = 0, priceDate = day) =>
    store.saveQuote('ctf', day, quote(priceDate, price), started + offset * DAY + delay);
  save('2026-11-21', 1, 200, 0, origin);
  assert.equal(store.forecastStats('ctf').byHorizon[1].total, 0);
  save('2026-11-21', 1, 103);
  save('2026-11-21', 1, 80, 5000);
  save('2026-11-22', 2, 120);
  save('2026-11-23', 3, 99, HALF_HOUR);
  save('2026-11-27', 7, 100);
  const result = store.forecastStats('ctf');
  assert.equal(result.byHorizon[1].hit, 1);
  assert.equal(result.byHorizon[1].meanConfidence, .6);
  assert(Math.abs(result.byHorizon[1].brier - .24) < 1e-10);
  assert.equal(result.byHorizon[3].total, 0);
  assert.equal(result.byHorizon[7].hit, 0);
  assert.equal(result.late, 1);
  assert.equal(store.db.prepare('SELECT actual FROM forecast_checks WHERE target = ?').get('2026-11-22').actual, null);
});

test('周大福历史只读内地饰品列，保留日期缺口', () => {
  const trend = {
    seriesName: '内地行', unit: '元/克',
    series: [{ name: '金条价格', values: [900, 910, 920] }, { name: '饰品金价', values: [1113, null, 1132] }],
    xlabels: ['2026-11-17', '2026-11-18', '2026-11-19'],
  };
  const html = `<script>window.__TRENDS__ = {\ntrendChart: ${JSON.stringify(trend)}\n};</script>`;
  const rows = parseCtfHistory(html);
  assert.deepEqual(rows.map(({ date, price }) => [date, price]), [['2026-11-17', 1113], ['2026-11-19', 1132]]);
});

test('现货拒绝过期报价和期货口径，历史最近一天仅取已结束日期', () => {
  const data = { symbol: 'XAU', currency: 'USD', price: '3533.20', updatedAt: '2026-11-20T02:00:00Z' };
  assert.equal(parseGold(data, when('10:00')).price, 3533.2);
  assert.throws(() => parseGold({ ...data, symbol: 'GC=F' }, when('10:00')));
  assert.throws(() => parseGold(data, when('10:30')), /过旧/);
  const rows = parseGoldHistory({
    symbol: 'XAU-USD-SPOT', interval: '1d', series: [
      { date: '2025-11-19', close: 3240 }, { date: '2025-11-20', close: 3300 },
      { date: '2026-11-19', close: '3500' }, { date: '2026-11-20', close: '3550' },
    ],
  }, when('10:00'));
  assert.deepEqual(rows.map(({ date }) => date), ['2025-11-20', '2026-11-19']);
});

test('每金衡盎司换算为每克，现货用当时已发布汇率，历史按各日换算', () => {
  const price = 100 * GRAMS_PER_TROY_OUNCE;
  const captured = { ...quote('2026-11-20', price), fetchedAt: when('10:00') };
  const history = [quote('2026-11-18', price), quote('2026-11-19', price)];
  const rates = [{ date: '2026-11-18', price: .81 }, { date: '2026-11-19', price: .82 }, { date: '2026-11-20', price: .84 }];
  const eur = convertGold(captured, history, 'EUR', rates);
  const cny = convertGold(captured, history, 'CNY', [{ date: '2026-11-19', price: 7 }]);
  assert.equal(cutoffDate(when('10:00')), '2026-11-19');
  assert.equal(Math.round(eur.quote.price), 82);
  assert.deepEqual(eur.history.map(({ price }) => Math.round(price)), [81, 82]);
  assert.equal(eur.quote.fxDate, '2026-11-19');
  assert.equal(cny.quote.price, 700);
  assert.equal(cny.history.length, 1);
  assert.equal(convertGold(captured, history, 'USD', []).quote.price, 100);
  assert.equal(convertGold(captured, history, 'CNY', []).waitingForFx, true);
});

test('汇率输入接受 USD 基准下的 EUR 和 CNY，并过滤未来日期', () => {
  const rows = parseFx([
    { date: '2026-11-19', base: 'USD', quote: 'EUR', rate: .82 },
    { date: '2026-11-19', base: 'USD', quote: 'CNY', rate: 7 },
    { date: '2026-11-20', base: 'USD', quote: 'EUR', rate: .85 },
    { date: '2026-11-19', base: 'EUR', quote: 'CNY', rate: 8 },
  ], when('10:00'));
  assert.deepEqual(rows.map(({ date, currency, price }) => [date, currency, price]), [
    ['2026-11-19', 'EUR', .82], ['2026-11-19', 'CNY', 7],
  ]);
});
