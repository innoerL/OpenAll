const { dateAt, dateBeforeYear, isDate } = require('./time.cjs');
const { earlier, parseFx } = require('./currency.cjs');
const { fetchContext } = require('./market-context.cjs');

const GOLD = 'https://api.gold-api.com/price/XAU';
const GOLD_HISTORY = 'https://api.goldprice.dev/v1/public/xau-history';
const JINJIA = 'https://www.jinjia.com.cn/chowtaifook/';
const JINZI = 'https://www.jinziyinzi.com/zhoudafu.htm';
const SOJINJIA = 'https://www.sojinjia.cn/pinpai/zhoudafu';
const FX = 'https://api.frankfurter.dev/v2/rates';
const CTF_OFFICIAL = '周大福官方商城';
const CTF_CORROBORATED = '金价网 · 金子银子';
const MARKET_ZONE = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', hourCycle: 'h23',
});

function positive(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const number = Number(String(value).replaceAll(',', '').trim());
  return Number.isFinite(number) && number > 0 ? number : null;
}

function marketIsClosed(now) {
  const parts = MARKET_ZONE.formatToParts(now);
  const day = parts.find(({ type }) => type === 'weekday').value;
  const hour = Number(parts.find(({ type }) => type === 'hour').value);
  return day === 'Sat' || (day === 'Fri' && hour >= 17) ||
    (day === 'Sun' && hour < 18) || hour === 17;
}

function parseGold(payload, now) {
  const price = positive(payload?.price);
  const timestamp = Date.parse(payload?.updatedAt);
  if (payload?.symbol !== 'XAU' || payload.currency !== 'USD' || price === null ||
      !Number.isFinite(timestamp) || timestamp > now + 120_000) {
    throw new Error('现货接口未返回有效报价');
  }

  const age = now - timestamp;
  const closed = marketIsClosed(now);
  const closingLimit = closed ? 4 * 86_400_000 : 15 * 60_000;
  if (age > closingLimit) throw new Error('现货报价时间过旧');
  return {
    price,
    date: dateAt(timestamp),
    quoteTime: new Date(timestamp).toISOString(),
    source: 'Gold API',
    note: closed ? '例行休市时段' : '',
  };
}

function parseGoldHistory(payload, now) {
  if (payload?.symbol !== 'XAU-USD-SPOT' || payload.interval !== '1d' || !Array.isArray(payload.series)) {
    throw new Error('现货日线返回格式变化');
  }

  const today = dateAt(now);
  const earliest = dateBeforeYear(today);
  const rows = payload.series
    .filter(({ date, close }) => isDate(date) && date >= earliest && date < today && positive(close) !== null)
    .map(({ date, close }) => ({ date, price: positive(close), source: 'goldprice.dev' }));
  if (!rows.length) throw new Error('现货日线暂无数据');
  return rows;
}

const plainCell = (value) => value.replace(/<[^>]*>/g, '').replaceAll('&nbsp;', ' ').trim();

function parseOfficialCtf(text) {
  const update = text.match(/更新于\s*(\d{4})[年-](\d{1,2})[月-](\d{1,2})日?\s+(\d{2}:\d{2}:\d{2})/);
  const listing = text.match(/足金\s*[（(]\s*饰品\s*[、，,]\s*工艺品类\s*[）)]\s*([\d,.]+)\s*元\s*[／/]\s*克/);
  const price = positive(listing?.[1]);
  if (!update || price === null) throw new Error('周大福官网暂无有效足金饰品牌价');
  const [, year, month, day, time] = update;
  const date = [year, month.padStart(2, '0'), day.padStart(2, '0')].join('-');
  const timestamp = Date.parse(`${date}T${time}+08:00`);
  if (!isDate(date) || !Number.isFinite(timestamp)) throw new Error('周大福官网牌价时间无效');
  return { date, price, quoteTime: new Date(timestamp).toISOString(), source: CTF_OFFICIAL, note: '' };
}

function parseJinjia(html, today) {
  const list = html.match(/<li\b[^>]*>\s*<div class="name">名称<\/div>\s*<div class="new">黄金饰品<\/div>/);
  if (!list) throw new Error('金价网饰品报价表结构变化');
  for (const [, row] of html.slice(list.index).matchAll(/<li>([\s\S]*?)<\/li>/g)) {
    const name = row.match(/<div class="name">([\s\S]*?)<\/div>/)?.[1];
    const value = row.match(/<div class="new">([\s\S]*?)<\/div>/)?.[1];
    const date = row.match(/<div class="time">([^<]+)<\/div>/)?.[1];
    if (name && value && plainCell(name) === '周大福' && date === today) {
      const price = positive(plainCell(value).replace(/\s*元\s*\/\s*克$/, ''));
      if (price !== null) return price;
    }
  }
  throw new Error('金价网未更新当日黄金饰品报价');
}

function parseJinzi(html, today) {
  const rates = html.match(/<table\b[^>]*>\s*<thead>\s*<tr>\s*<th>足金零售价<\/th>[\s\S]*?<\/table>/)?.[0];
  for (const [, row] of (rates ?? '').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = Array.from(row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g), (cell) => plainCell(cell[1]));
    if (cells.length === 6 && cells[1] === '元/克' && cells[5] === today && positive(cells[0]) !== null) {
      return positive(cells[0]);
    }
  }
  throw new Error('金子银子未更新当日足金零售价');
}

function parseCtfHistory(html) {
  // 只读取页面为图表公开的 JSON 数据，禁止执行远程脚本。
  const match = html.match(/(?:["']trendChart["']|\btrendChart)\s*:\s*(\{"seriesName"[^\r\n]*?\})(?=,?\s*(?:\r?\n|\}\s*;))/);
  if (!match) throw new Error('搜金价历史页面结构变化');
  const chart = JSON.parse(match[1]);
  const jewelry = chart.series?.find(({ name }) => name === '饰品金价');
  if (chart.seriesName !== '内地行' || chart.unit !== '元/克' ||
      !Array.isArray(chart.xlabels) || jewelry?.values?.length !== chart.xlabels.length) {
    throw new Error('搜金价历史数据口径不匹配');
  }

  const rows = chart.xlabels.flatMap((date, index) => {
    const price = positive(jewelry.values[index]);
    return isDate(date) && price !== null ? [{ date, price, source: '搜金价' }] : [];
  });
  if (!rows.length) throw new Error('搜金价暂无饰品金价历史');
  return rows.sort((left, right) => left.date.localeCompare(right.date));
}

async function response(fetcher, url, type) {
  const res = await fetcher(url, {
    signal: AbortSignal.timeout(12_000),
    cache: 'no-store',
    headers: {
      Accept: type === 'json' ? 'application/json' : 'text/html',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
    redirect: 'error',
  });
  if (!res.ok) throw new Error(`数据源 HTTP ${res.status}`);
  return res[type]();
}

function quoteForToday(quote, now) {
  if (!quote || quote.date !== dateAt(now)) throw new Error('等待当日足金饰品牌价');
  if (quote.quoteTime && Date.parse(quote.quoteTime) > now + 120_000) throw new Error('足金牌价时间晚于当前时间');
  return quote;
}

function createSources(fetcher, clock = Date.now, readOfficialCtf) {
  return {
    signals: { context: (now) => fetchContext(fetcher, now) },
    fx: {
      history: async (now) => {
        const today = dateAt(now);
        const from = earlier(dateBeforeYear(today), 10);
        const url = `${FX}?base=USD&quotes=EUR,CNY&providers=ECB&from=${from}&to=${today}`;
        return parseFx(await response(fetcher, url, 'json'), clock());
      },
    },
    gold: {
      quote: async () => parseGold(await response(fetcher, GOLD, 'json'), clock()),
      history: async () => parseGoldHistory(await response(fetcher, GOLD_HISTORY, 'json'), clock()),
    },
    ctf: {
      quote: async () => {
        try {
          const quote = await readOfficialCtf();
          return quoteForToday(quote, clock());
        } catch (primaryError) {
          try {
            const today = dateAt(clock());
            const [first, second] = await Promise.all([
              response(fetcher, JINJIA, 'text').then((html) => parseJinjia(html, today)),
              response(fetcher, JINZI, 'text').then((html) => parseJinzi(html, today)),
            ]);
            if (first !== second || today !== dateAt(clock())) throw new Error('两处备用牌价尚未一致');
            return { date: today, price: first, quoteTime: null, source: CTF_CORROBORATED, note: '' };
          } catch (fallbackError) {
            if (isConnectionError(primaryError) && isConnectionError(fallbackError)) throw primaryError;
            throw new Error('当日足金饰品牌价尚未核实');
          }
        }
      },
      history: async (now) => {
        const today = dateAt(now);
        const earliest = dateBeforeYear(today);
        const currentYear = today.slice(0, 4);
        const priorYear = earliest.slice(0, 4);
        const urls = [`${SOJINJIA}/lishi`, `${SOJINJIA}/lishi/${priorYear}`];
        if (currentYear === priorYear) urls.pop();
        const results = await Promise.allSettled(urls.map(async (url) => parseCtfHistory(await response(fetcher, url, 'text'))));
        const rows = results.flatMap((result) => result.status === 'fulfilled' ? result.value : [])
          .filter(({ date }) => date >= earliest && date <= today);
        if (!rows.length) throw results.find(({ status }) => status === 'rejected')?.reason ?? new Error('暂无近一年历史');
        return { rows, partial: results.some(({ status }) => status === 'rejected') };
      },
    },
  };
}

function isConnectionError(error) {
  return /ERR_(?:INTERNET_DISCONNECTED|NETWORK_CHANGED|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE|CONNECTION_(?:RESET|REFUSED|CLOSED|TIMED_OUT))|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ECONNRESET|ETIMEDOUT/.test(
    `${error?.message ?? ''} ${error?.cause?.code ?? ''}`,
  );
}

module.exports = {
  createSources, parseGold, parseGoldHistory, parseOfficialCtf, parseJinjia, parseJinzi, parseCtfHistory,
  isConnectionError, marketIsClosed, CTF_OFFICIAL, CTF_CORROBORATED,
};
