const { DAY, isDate } = require('./time.cjs');

const CURRENCIES = ['USD', 'EUR', 'CNY'];
const GRAMS_PER_TROY_OUNCE = 31.1034768;
const publicationZone = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', hourCycle: 'h23',
});

function cutoffDate(timestamp) {
  const parts = Object.fromEntries(publicationZone.formatToParts(timestamp).map(({ type, value }) => [type, value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return Number(parts.hour) < 16 ? earlier(date, 1) : date;
}

function earlier(date, days) {
  return new Date(Date.parse(date) - days * DAY).toISOString().slice(0, 10);
}

function parseFx(payload, now) {
  if (!Array.isArray(payload)) throw new Error('汇率返回格式变化');
  const parsed = payload.filter(({ date, base, quote, rate }) =>
    isDate(date) && date <= cutoffDate(now) && base === 'USD' && ['EUR', 'CNY'].includes(quote) &&
    Number.isFinite(rate) && rate > 0,
  ).map(({ date, quote, rate }) => ({ date, currency: quote, price: rate, source: 'Frankfurter' }));
  if (!['EUR', 'CNY'].every((currency) => parsed.some((row) => row.currency === currency))) {
    throw new Error('缺少人民币或欧元参考汇率');
  }
  return parsed;
}

function convertGold(quote, history, currency, rates) {
  const ratesByDate = new Map(rates.map((row) => [row.date, row.price]));
  function convert(point, targetDate) {
    if (currency === 'USD') return { ...point, price: point.price / GRAMS_PER_TROY_OUNCE, fxDate: null };
    for (let days = 0; days <= 10; days++) {
      const date = earlier(targetDate, days);
      const rate = ratesByDate.get(date);
      if (rate) return { ...point, price: point.price * rate / GRAMS_PER_TROY_OUNCE, fxDate: date };
    }
    return null;
  }
  const convertedQuote = quote ? convert(quote, cutoffDate(quote.fetchedAt)) : null;
  const series = history.map((point) => convert(point, point.date)).filter(Boolean);
  return { quote: convertedQuote, history: series, waitingForFx: Boolean(quote && !convertedQuote) };
}

module.exports = { CURRENCIES, GRAMS_PER_TROY_OUNCE, earlier, cutoffDate, parseFx, convertGold };
