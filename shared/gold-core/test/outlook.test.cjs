const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { dateAt, DAY } = require('../time.cjs');
const { createSources, marketIsClosed } = require('../sources.cjs');
const { getChanges } = require('../changes.cjs');
const { forecast, classifyReturn, estimateDirection } = require('../outlook.cjs');
const { parseFred, parseNews } = require('../market-context.cjs');
const { parseBls, parseFomc, parseEia, upcomingCalendar } = require('../macro-calendar.cjs');
const { EdgeDock, edgeSide, edgeBounds, railBounds, smoothStep } = require('../edge-dock.cjs');

test('涨跌优先比较保存的同单位报价，并显示前移后的实际日期', () => {
  const now = { date: '2026-11-23', price: 110 };
  const history = [{ date: '2026-11-20', price: 98 }, { date: '2026-11-16', price: 120 }];
  const snapshots = [{ date: '2026-11-20', price: 100 }, { date: '2026-11-23', price: 110 }];
  const { daily, weekly } = getChanges(now, history, snapshots);
  assert.equal(daily.date, '2026-11-20');
  assert.equal(daily.exact, false);
  assert.equal(daily.basis, '已保存报价');
  assert.equal(Math.round(daily.percent), 10);
  assert.equal(weekly.date, '2026-11-16');
  assert.equal(weekly.exact, true);
  assert.equal(Math.round(weekly.percent), -8);
});

test('宏观数据区分真正的零实际利率和缺失字段', () => {
  const rows = Array.from({ length: 31 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 8, index + 1)).toISOString().slice(0, 10);
    return `${date},90,120,${index ? .6 : 0}`;
  });
  rows.push('2026-11-18,,,.', '2026-11-19,90,,0');
  const result = parseFred('observation_date,DCOILWTICO,DTWEXBGS,DFII10\n' + rows.join('\n'), '2026-11-20');
  assert.equal(result.DFII10[0].price, 0);
  assert.equal(result.DFII10.at(-1).price, 0);
  assert.equal(result.DTWEXBGS.at(-1).date, '2026-10-01');
});

test('采用近期且来源匹配的事件标题，拒绝过期报道与外域链接', () => {
  const now = Date.parse('2026-11-20T12:00:00Z');
  const item = (title, date, href) =>
    `<item><title><![CDATA[${title}]]></title><pubDate>${date}</pubDate><link>${href}</link></item>`;
  const results = parseNews(
    '<rss>' +
    item('也门战事升级', '2026-11-19T10:00:00Z', 'https://news.un.org/zh/one') +
    item('原油供应中断', '2026-11-20T10:00:00Z', 'https://example.com/a') +
    item('冲突升级', '2026-11-08T10:00:00Z', 'https://news.un.org/zh/old') +
    item('COP31 概览', '2026-11-20T10:00:00Z', 'https://news.un.org/zh/irrelevant') +
    '</rss>', now);
  assert.deepEqual(results.map(({ title, tag }) => [title, tag]), [['也门战事升级', '冲突风险']]);
});

test('桌面数据源注册同时获取行情因素和事件的入口', async () => {
  const requested = [];
  const now = Date.parse('2026-11-20T12:00:00Z');
  const source = createSources(async (url) => {
    requested.push(new URL(url).hostname);
    if (url.includes('fred.stlouisfed.org')) return new Response('', { status: 503 });
    return new Response('<rss><item><title>也门冲突升级</title><pubDate>2026-11-19T10:00:00Z</pubDate><link>https://news.un.org/zh/event</link></item></rss>');
  });
  const context = await source.signals.context(now);
  assert.deepEqual(requested.sort(), ['fred.stlouisfed.org', 'news.un.org', 'www.bls.gov', 'www.eia.gov', 'www.federalreserve.gov']);
  assert.equal(context.partial, true);
  assert.equal(context.news[0].tag, '冲突风险');
  assert.deepEqual(context.calendar, {});
});

test('三日展望涵盖实际日历，休市留空，新闻只展示在市场背景', () => {
  const now = Date.parse('2026-11-20T05:30:00Z');
  const today = dateAt(now);
  const history = Array.from({ length: 200 }, (_, index) => ({
    date: dateAt(now - (200 - index) * DAY), price: 110,
  }));
  const params = { instrument: 'gold', priceHistory: history, goldHistory: history, today, now, marketIsClosed };
  const calm = forecast(params);
  const risky = forecast({ ...params, news: [{ timestamp: now - DAY, tag: '供应风险' }] });
  assert.equal(calm.days.length, 3);
  assert.equal(calm.days[0].date, '2026-11-21');
  assert(calm.days[0].closed && calm.days[1].closed);
  assert.equal(calm.days[2].pointMethod, 'directional-median', '从周四历史基准至周一是四日跨度');
  assert.equal(calm.days[2].mid, 110);
  assert.equal(calm.days[2].direction, 'flat');
  assert(calm.days[2].confidence > 80 && calm.days[2].confidence < 100);
  assert(!Object.hasOwn(calm.days[0], 'confidence'));
  assert.deepEqual(risky, calm);
  assert.equal(forecast({ ...params, priceHistory: history.slice(-10) }), null);
});

test('涨跌以当前基准的实际百分比划分，正负 0.2% 边界仍属于维持', () => {
  assert.equal(classifyReturn(Math.log1p(.002)), 'flat');
  assert.equal(classifyReturn(Math.log1p(-.002)), 'flat');
  assert.equal(classifyReturn(Math.log1p(.00201)), 'up');
  assert.equal(classifyReturn(Math.log1p(-.00201)), 'down');
});

test('周大福与现货均只展望未来三个自然日，现货仅调整一日与三日点价', () => {
  const now = Date.parse('2026-11-16T05:30:00Z');
  const today = dateAt(now);
  const history = Array.from({ length: 200 }, (_, index) => ({
    date: dateAt(now - (200 - index) * DAY), price: 800 * Math.exp(index * .003),
  }));
  const input = { instrument: 'ctf', priceHistory: history, goldHistory: history, today,
    quote: { date: today, price: 1500 }, marketIsClosed };
  const result = forecast(input);
  const available = result.days.filter(day => day.probabilities);
  assert.deepEqual(available.map(day => day.date), ['2026-11-17', '2026-11-18', '2026-11-19']);
  assert.equal(result.version, '4.0.0');
  assert(available.every(day => day.pointMethod === 'joint-history' && day.mid > 1500));
  assert.equal(new Set(available.map(day => Math.round(day.mid))).size, 3);
  assert(available.every(day => day.direction === 'up' && day.low < day.mid && day.high > day.mid));
  const gold = forecast({ ...input, instrument: 'gold' });
  assert.equal(gold.version, '5.0.0');
  const old = forecast({ ...input, instrument: 'gold', modelMode: 'history' });
  assert.deepEqual(gold.days.map(day => day.date), available.map(day => day.date));
  for (const [index, day] of gold.days.entries()) {
    assert.deepEqual(day.probabilities, old.days[index].probabilities);
    if (index === 1) assert.deepEqual(day, old.days[index]);
    else {
      assert.equal(day.pointMethod, 'session-median');
      assert(day.mid < old.days[index].mid);
    }
  }
});

test('使用最多历史情景选出预计方向与可信度，预计价与方向保持一致', () => {
  const rising = estimateDirection(0, [.01, .015, .003, -.01, 0], 1);
  const falling = estimateDirection(0, [-.01, -.015, -.003, .01, 0], 1);
  const flat = estimateDirection(0, [0, 0, .001, -.001, -.01], 1);
  assert.deepEqual([rising.direction, rising.confidence], ['up', 50]);
  assert.deepEqual([falling.direction, falling.confidence], ['down', 50]);
  assert.deepEqual([flat.direction, flat.confidence], ['flat', 63]);
  for (const result of [rising, falling, flat]) {
    assert.equal(classifyReturn(result.mid), result.direction);
    assert(result.low < result.mid && result.high > result.mid);
    assert.equal(Object.values(result.probabilities).reduce((sum, item) => sum + item, 0), 1);
  }
});

test('财经日历跨月与美东夏令时转换，库存发布节假日按官方例外表顺延', () => {
  const now = Date.parse('2026-09-04T02:00:00Z');
  const bls = parseBls('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\n' +
    'DTSTART;TZID=America/New_York:20260904T083000\r\nSUMMARY:Employment Situation for August\r\nEND:VEVENT\r\nEND:VCALENDAR');
  const fomc = parseFomc('<div><h4>2026 FOMC Meetings</h4><div class="fomc-meeting__month"><strong>April/May</strong></div>' +
    '<div class="fomc-meeting__date">30-1*</div></div>');
  const eia = parseEia('10:30 a.m. eastern time on Wednesday<table class="basic-table schedule"><tr>' +
    '<th scope="row">September 4, 2026</th><td>September 10, 2026</td><td>Thursday</td><td>12:00 p.m.</td></tr></table>', now);
  const result = upcomingCalendar({ bls: { fetchedAt: now, events: bls }, eia: { fetchedAt: now, events: eia } }, now);
  assert.deepEqual(result.available, ['bls', 'eia']);
  assert.deepEqual(result.events.map(({ timestamp }) => new Date(timestamp).toISOString()), [
    '2026-09-04T12:30:00.000Z', '2026-09-10T16:00:00.000Z',
  ]);
  assert.equal(new Date(fomc[0].timestamp).toISOString(), '2026-05-01T18:00:00.000Z');
});

test('左右贴边时独立胶囊保持透明窗口，浮窗在原尺寸收起和恢复', (context) => {
  const area = { x: -1000, y: 12, width: 1000, height: 720 };
  const input = { x: -470, y: 25, width: 462, height: 570 };
  let cursor = { x: -450, y: 25 };
  let now = 1000;

  function mockWindow(bounds, visible) {
    const native = new EventEmitter();
    native.visible = visible;
    native.getBounds = () => bounds;
    native.setBounds = (value) => { bounds = value; };
    native.isMinimized = native.isDestroyed = () => false;
    native.setAlwaysOnTop = (value) => { native.onTop = value; };
    native.setIgnoreMouseEvents = native.moveTop = () => {};
    native.showInactive = () => { native.visible = true; };
    native.hide = () => { native.visible = false; };
    native.setOpacity = (value) => { native.opacity = value; };
    return native;
  }

  const win = mockWindow(input, true);
  const rail = mockWindow({}, false);
  const dock = new EdgeDock({
    window: win, rail, enabled: true, preferences: () => ({ pinned: false }),
    screen: { getDisplayMatching: () => ({ workArea: area }), getCursorScreenPoint: () => cursor },
    persistPosition() {}, reducedMotion: () => true, clock: () => now,
  });
  context.after(() => dock.stop());
  assert.equal(edgeSide(input, area), 'right');
  assert.equal(edgeSide({ ...input, x: -995 }, area), 'left');
  assert.equal(railBounds(edgeBounds(input, area, 'left'), area, 'left').x, area.x);
  dock.beginOpening();
  dock.checkPlacement();
  cursor = { x: -650, y: 100 };
  dock.poll();
  now += 14999;
  dock.poll();
  assert.equal(win.visible, true, '主动打开后，鼠标在外也至少展示十五秒');
  assert.equal(rail.visible, false);
  now += 1;
  dock.poll();
  assert.equal(win.getBounds().width, 462);
  assert.equal(win.visible, false);
  assert.equal(rail.visible, true);
  assert.equal(rail.getBounds().x, -16);
  assert.equal(rail.opacity, 1);

  cursor = { x: -6, y: rail.getBounds().y + 35 };
  dock.poll();
  now += 125;
  dock.poll();
  assert.equal(win.visible, true);
  assert.equal(win.onTop, true);
  assert.equal(rail.visible, false);
  cursor = { x: -650, y: 100 };
  dock.poll();
  now += 425;
  dock.poll();
  assert.equal(win.visible, false);
  dock.setEnabled(false);
  assert.equal(win.visible, true);
  assert.equal(win.onTop, false);
  assert.equal(win.getBounds().width, 462);

  dock.beginOpening();
  dock.setEnabled(true);
  cursor = { x: -230, y: 100 };
  now += 16000;
  dock.poll();
  assert.equal(win.visible, true, '阅读时限已过，鼠标仍在窗口内就继续显示');
  cursor = { x: -650, y: 100 };
  dock.poll();
  now += 341;
  dock.poll();
  assert.equal(win.visible, false, '离开后按正常延时收回');
});

test('透明度曲线在首尾变缓，两个窗口在中点透明度相等', () => {
  const values = [0, .25, .5, .75, 1].map(smoothStep);
  assert.deepEqual(values, [0, .15625, .5, .84375, 1]);
});
