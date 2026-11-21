const test = require('node:test');
const assert = require('node:assert/strict');
const { forecast, classifyReturn, dateAfter } = require('../outlook.cjs');

// 全部使用确定性合成序列，不读取用户数据库，也不根据最近一次真实误差调参。
function sample() {
  let price = 1000;
  const history = Array.from({ length: 260 }, (_, index) => ({
    date: dateAfter('2026-01-01', index),
    price: price *= Math.exp(.007 * Math.sin(index / 11) + .003 * Math.sin(index / 37)),
  }));
  const today = dateAfter('2026-01-01', history.length);
  const macro = Object.fromEntries(['DCOILWTICO', 'DTWEXBGS', 'DFII10'].map((id, factor) => [id,
    history.map(({ date }, index) => ({ date, price: [60, 110, 1.5][factor] + index * [.03, .01, .001][factor] })),
  ]));
  return { instrument: 'ctf', priceHistory: history, goldHistory: history, macro,
    quote: { date: today, price }, today, marketIsClosed: () => false, offsets: [1, 3, 7] };
}

test('旧基准必须使用基准日到目标日的实际日历跨度，不能套用展示日起的一日收益', () => {
  const input = sample();
  const anchorDate = input.today;
  const displayedToday = dateAfter(anchorDate, 2);
  const stale = forecast({ ...input, today: displayedToday, offsets: [1, 3, 7] });
  const issuedAtAnchor = forecast({ ...input, offsets: [3, 5, 9] });
  assert.equal(stale.anchor.date, anchorDate);
  assert.equal(stale.days[0].date, dateAfter(displayedToday, 1));
  assert.deepEqual(stale.days, issuedAtAnchor.days,
    '相同已知数据、基准和目标日期应使用同一期限情景，不能因展示日期推进而缩短预测跨度');
});

test('价格模型可利用当日已知周大福报价的原点动量，而非只把旧预测等比例缩放', () => {
  const input = sample();
  const low = forecast({ ...input, modelMode: 'price', offsets: [1],
    quote: { ...input.quote, price: input.quote.price * Math.exp(-.015) } });
  const high = forecast({ ...input, modelMode: 'price', offsets: [1],
    quote: { ...input.quote, price: input.quote.price * Math.exp(.015) } });
  assert.ok(low.days[0].probabilities && high.days[0].probabilities);
  const lowReturn = Math.log(low.days[0].mid / low.anchor.price);
  const highReturn = Math.log(high.days[0].mid / high.anchor.price);
  assert.ok(Math.abs(lowReturn - highReturn) > 1e-8,
    '该合成序列具有可预测的动量；改变已知原点收益应改变预测收益，不能仅改变价格分母');
});

test('当日历史日线不能冒充已知原点报价，也不能进入当日尚未结束的训练目标', () => {
  const input = sample();
  for (const modelMode of ['history', 'price', 'macro']) {
    const expected = forecast({ ...input, modelMode });
    const poisoned = forecast({ ...input, modelMode,
      priceHistory: [...input.priceHistory, { date: input.today, price: 1e12 }],
      goldHistory: [...input.goldHistory, { date: input.today, price: 1e-6 }],
    });
    assert.deepEqual(poisoned, expected, `${modelMode} 应以传入的已知 quote 为原点，忽略同日未定历史栏`);
  }
});

test('加入或改写原点之后的历史价、目标价与宏观行，不得改变已发时点的预测', () => {
  const input = sample();
  const future = [1, 2, 3, 7, 14].map((offset, index) => ({
    date: dateAfter(input.today, offset), price: index % 2 ? 1e-6 : 1e12,
  }));
  for (const modelMode of ['history', 'price', 'macro']) {
    const expected = forecast({ ...input, modelMode });
    const withFutureTargets = forecast({ ...input, modelMode,
      priceHistory: [...input.priceHistory, ...future],
      goldHistory: [...input.goldHistory, ...future],
      macro: Object.fromEntries(Object.entries(input.macro).map(([id, rows]) => [id, [...rows, ...future]])),
    });
    assert.deepEqual(withFutureTargets, expected, `${modelMode} 不得让未来标签或未来特征参与原点计算`);
  }
});

test('未来日期的 quote 不得被选为当前基准', () => {
  const input = sample();
  const expected = forecast({ ...input, quote: null });
  const withFutureQuote = forecast({ ...input,
    quote: { date: dateAfter(input.today, 1), price: 1e12 },
  });
  assert.deepEqual(withFutureQuote, expected);
  assert.ok(withFutureQuote.anchor.date < input.today);
});

test('时间对齐改动不改变正负 0.2% 的涨跌分类边界', () => {
  assert.equal(classifyReturn(Math.log1p(.002)), 'flat');
  assert.equal(classifyReturn(Math.log1p(-.002)), 'flat');
  assert.equal(classifyReturn(Math.log1p(.00201)), 'up');
  assert.equal(classifyReturn(Math.log1p(-.00201)), 'down');
});
