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
  for (const modelMode of ['auto', 'history', 'price', 'macro']) {
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
  for (const modelMode of ['auto', 'history', 'price', 'macro']) {
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

test('同一目标日独立估算，调换顺序或只估单日得到同一参考价', () => {
  const input = sample();
  const full = forecast({ ...input, offsets: [1, 2, 3, 4, 5, 6, 7] });
  const reordered = forecast({ ...input, offsets: [7, 2, 1] });
  assert.deepEqual(reordered.days, [full.days[6], full.days[1], full.days[0]]);
  assert.deepEqual(forecast({ ...input, offsets: [2] }).days, [full.days[1]]);
});

test('国际现货匹配开市跨度的样本不足时回退，历史七日也沿用原点价', () => {
  const input = { ...sample(), instrument: 'gold' };
  const sparse = { ...input, priceHistory: input.priceHistory.filter((_, index) => index % 3 === 0), offsets: [3] };
  const previous = forecast({ ...sparse, modelMode: 'history' });
  assert.equal(previous.days[0].pointMethod, 'directional-median');
  assert.deepEqual(forecast(sparse).days, previous.days);
  const seven = { ...input, offsets: [7] };
  assert.deepEqual(forecast(seven).days, forecast({ ...seven, modelMode: 'history' }).days);
});

test('当周大福与国际金价走势均平坦时，逐日计算可以自然同价', () => {
  const input = sample();
  const flat = input.priceHistory.map(row => ({ ...row, price: 1068 }));
  const result = forecast({ ...input, priceHistory: flat, goldHistory: flat,
    quote: { date: input.today, price: 1068 } });
  assert(result.days.every(day => day.mid === 1068 && day.pointMethod === 'joint-history'));
});

test('国际现货与周大福的近期走势均能改变同一期限的预测收益', () => {
  const input = sample();
  // 两组不同周期的收益分别驱动合成牌价。保持基准不变，分别改变各来源已知的近期涨跌。
  const spotReturn = index => .012 * Math.sin(index / 4);
  let spot = 3000, retail = 1000;
  const goldHistory = input.goldHistory.map((row, index) => ({ date: row.date, price: spot *= Math.exp(spotReturn(index)) }));
  const priceHistory = input.priceHistory.map((row, index) => ({
    date: row.date, price: retail *= Math.exp(.007 * Math.sin(index / 13) + .32 * spotReturn(index - 2)),
  }));
  const quote = { date: input.today, price: retail };
  const next = (priceHistory, goldHistory) => forecast({ ...input, quote, priceHistory, goldHistory, offsets: [1] }).days[0].mid;
  const replaceLast = (rows, ratio) => [...rows.slice(0, -1), { ...rows.at(-1), price: rows.at(-1).price * ratio }];
  const base = next(priceHistory, goldHistory);
  assert(Math.abs(base - next(priceHistory, replaceLast(goldHistory, 1.012))) > .01);
  assert(Math.abs(base - next(replaceLast(priceHistory, .995), goldHistory)) > .01);
});

test('周日缺少历史牌价仍可用同跨度真实样本，缺少国际历史时明确留空', () => {
  const input = sample();
  const priceHistory = input.priceHistory.filter(row => new Date(row.date).getUTCDay() !== 0);
  const offsets = [1, 2, 3, 4, 5, 6, 7];
  const result = forecast({ ...input, priceHistory, offsets });
  assert(result.days.every(day => day.mid > 0));
  for (const goldHistory of [[], input.goldHistory.slice(0, -10)]) {
    const missing = forecast({ ...input, priceHistory, goldHistory, offsets });
    assert(missing.days.every(day => day.sparseReason === 'gold-history' && day.mid === undefined));
  }
  const short = forecast({ ...input, priceHistory, goldHistory: input.goldHistory.slice(-12) });
  assert(short.days.every(day => day.sparseReason === 'paired-history'));
});
