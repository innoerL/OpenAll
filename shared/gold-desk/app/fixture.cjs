const { DAY, dateAt } = require('./time.cjs');

// 仅在宿主显式传入 fixture 时使用；验证过程不连接行情服务或读取真实记录。
function createFixture() {
  const now = Date.parse('2026-11-20T10:05:00+08:00');
  const history = (base, step) => Array.from({ length: 390 }, (_, index) => ({
    date: dateAt(now - (389 - index) * DAY),
    price: base + index * step + Math.sin(index / 7) * step * 8,
    source: '离线测试样例',
  }));
  const gold = history(2800, 2);
  const ctf = history(900, 0.8);
  const quote = rows => ({ ...rows.at(-1), quoteTime: new Date(now).toISOString(), note: '离线验证数据' });
  return {
    clock: () => now,
    sources: {
      gold: { quote: async () => quote(gold), history: async () => gold },
      ctf: { quote: async () => quote(ctf), history: async () => ctf },
      fx: { history: async () => ['EUR', 'CNY'].flatMap(currency =>
        history(currency === 'EUR' ? 0.92 : 7.2, 0).map(row => ({ ...row, currency }))) },
      signals: { context: async () => ({
        macro: { DCOILWTICO: history(65, 0.03), DTWEXBGS: history(115, 0.01), DFII10: history(1.5, 0.001) },
        news: [{ timestamp: now - DAY, tag: '能源动态', title: '离线测试：能源市场观察', url: 'https://news.un.org/zh/' }],
        calendar: Object.fromEntries(['fomc', 'bls', 'eia'].map((source, index) => [source, {
          fetchedAt: now,
          events: [{ timestamp: now + (index + 1) * DAY, source, title: ['离线测试：利率决议', '离线测试：CPI 发布', '离线测试：石油库存'][index] }],
        }])),
        partial: false,
      }) },
    },
  };
}

module.exports = { createFixture };
