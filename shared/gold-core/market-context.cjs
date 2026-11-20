const { DAY, dateAt, dateBeforeYear, isDate } = require('./time.cjs');
const { earlier } = require('./currency.cjs');
const { fetchCalendar } = require('./macro-calendar.cjs');

const FACTORS = {
  DCOILWTICO: { name: 'WTI 原油', lag: 3, unit: '%' },
  DTWEXBGS: { name: '广义美元指数', lag: 8, unit: '%' },
  DFII10: { name: '美国 10 年实际利率', lag: 2, unit: '基点' },
};
const NEWS_SITE = 'https://news.un.org/feed/subscribe/zh/news/all/rss.xml';
const FRED = 'https://fred.stlouisfed.org/graph/fredgraph.csv';

function parseFred(csv, today) {
  const [header, ...lines] = csv.trim().split(/\r?\n/);
  const columns = header.replace(/^\ufeff/, '').split(',');
  const indices = Object.keys(FACTORS).map((id) => [id, columns.indexOf(id)]);
  if (indices.some(([, index]) => index < 1)) throw new Error('宏观指标列不齐');
  const starts = earlier(dateBeforeYear(today), 20);
  const result = Object.fromEntries(indices.map(([id]) => [id, []]));
  for (const line of lines) {
    const fields = line.split(',');
    const date = fields[0];
    if (!isDate(date) || date < starts || date > today) continue;
    for (const [id, index] of indices) {
      const value = fields[index]?.trim();
      const price = Number(value);
      if (value && Number.isFinite(price) && (id === 'DFII10' || price > 0)) result[id].push({ date, price });
    }
  }
  for (const rows of Object.values(result)) rows.sort((left, right) => left.date.localeCompare(right.date));
  if (!Object.values(result).some((rows) => rows.length >= 30)) throw new Error('宏观指标历史不足');
  return result;
}

function decode(value) {
  const escapes = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, '')
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, key) => {
      if (key[0] !== '#') return escapes[key] ?? entity;
      const value = key[1].toLowerCase() === 'x' ? Number.parseInt(key.slice(2), 16) : Number(key.slice(1));
      return Number.isInteger(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : entity;
    }).replace(/\s+/g, ' ').trim();
}

function classify(title) {
  if (/供应中断|封锁|封航|油轮.{0,10}(袭|受损)|航运.{0,10}(中断|受阻)|海峡.{0,10}(风险|紧张|威胁)|能源供应.{0,10}(冲击|风险)/.test(title)) return '供应风险';
  if (/(战事|冲突|局势|敌对行动|战火).{0,12}(升级|加剧|蔓延)|空袭|炮击|停火.{0,10}(遭破坏|被打破)|破坏停火|导弹袭击|爆发.{0,8}(冲突|战争)/.test(title)) return '冲突风险';
  if (/停火|和谈|和平谈判|达成.{0,6}协议/.test(title)) return '外交进展';
  if (/原油|石油|油价|霍尔木兹|化石燃料|能源供应/.test(title)) return '能源动态';
  if (/关税|贸易争端|制裁|国际贸易/.test(title)) return '政策风险';
  if (/战争|武装冲突|中东局势|加沙|乌克兰|也门|苏丹/.test(title)) return '地缘动态';
  return null;
}

function parseNews(xml, now) {
  if (!/<rss\b/i.test(xml) || !/<item\b/i.test(xml)) throw new Error('事件订阅未返回新闻');
  const events = new Map();
  for (const [, item] of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const field = (name) => decode(item.match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, 'i'))?.[1] ?? '');
    const title = field('title').slice(0, 140);
    const timestamp = Date.parse(field('pubDate'));
    const tag = classify(title);
    if (!tag || !Number.isFinite(timestamp) || timestamp > now + 300_000 || now - timestamp > 4 * DAY) continue;
    try {
      const url = new URL(field('link'));
      if (url.origin !== 'https://news.un.org' || url.username || url.password || events.has(url.href)) continue;
      events.set(url.href, { title, tag, timestamp, url: url.href });
    } catch {
      continue;
    }
  }
  return [...events.values()].sort((a, b) => b.timestamp - a.timestamp).slice(0, 14);
}

async function fetchContext(fetcher, now) {
  const today = dateAt(now);
  const macroUrl = `${FRED}?id=${encodeURIComponent(Object.keys(FACTORS).join(','))}`;
  const read = async (url, accept) => {
    const response = await fetcher(url, {
      signal: AbortSignal.timeout(15_000), headers: { Accept: accept },
    });
    if (!response.ok) throw new Error(`数据源 HTTP ${response.status}`);
    return response.text();
  };
  const [macro, news, calendar] = await Promise.allSettled([
    read(macroUrl, 'text/csv').then((csv) => parseFred(csv, today)),
    read(NEWS_SITE, 'application/rss+xml, application/xml').then((xml) => parseNews(xml, now)),
    fetchCalendar(read, now),
  ]);
  const result = {
    macro: macro.status === 'fulfilled' ? macro.value : undefined,
    news: news.status === 'fulfilled' ? news.value : undefined,
    calendar: calendar.status === 'fulfilled' ? calendar.value : {},
    partial: macro.status === 'rejected' || news.status === 'rejected',
  };
  if (result.partial && !result.macro && !result.news && !Object.keys(result.calendar).length) {
    throw new Error('宏观数据和事件订阅暂不可用');
  }
  return result;
}

module.exports = { FACTORS, parseFred, parseNews, fetchContext };
