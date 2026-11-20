const { DAY, dateAt, isDate, scheduledAt } = require('./time.cjs');

const CALENDAR_URLS = {
  fomc: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',
  bls: 'https://www.bls.gov/schedule/news_release/bls.ics',
  eia: 'https://www.eia.gov/petroleum/supply/weekly/schedule.php',
};
const MONTHS = 'January February March April May June July August September October November December'.split(' ');
const EASTERN = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'longOffset' });

function easternTime(date, time) {
  if (!isDate(date)) return NaN;
  const offset = EASTERN.formatToParts(Date.parse(date + 'T12:00:00Z')).find(({ type }) => type === 'timeZoneName').value.slice(3);
  return Date.parse(`${date}T${time}:00${offset}`);
}

const makeDate = (year, month, day) => `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
const plain = (value) => value.replace(/<[^>]*>/g, '').trim();

function parseFomc(html) {
  const years = html.split(/>(20\d{2}) FOMC Meetings\s*</);
  const events = [];
  for (let index = 1; index < years.length; index += 2) {
    for (const [, monthLabel, range] of years[index + 1].matchAll(/fomc-meeting__month[^>]*>([\s\S]*?)<\/div>[\s\S]*?fomc-meeting__date[^>]*>([^<]+)</g)) {
      const match = range.trim().match(/^(\d{1,2})(?:[-–](\d{1,2}))?\*?$/);
      const month = MONTHS.indexOf(plain(monthLabel).split(/[/–-]/)[0].trim()) + 1;
      if (!month || !match) continue;
      const firstDay = Number(match[1]);
      const lastDay = Number(match[2] ?? firstDay);
      const monthIndex = month - 1 + Number(lastDay < firstDay);
      const date = makeDate(Number(years[index]) + Math.floor(monthIndex / 12), monthIndex % 12 + 1, lastDay);
      // 联储日历给出会议日期，利率决议在会议最后一天下午发布。
      events.push({ timestamp: easternTime(date, '14:00'), title: '美联储 FOMC 利率决议', source: 'fomc' });
    }
  }
  if (!events.some(({ timestamp }) => Number.isFinite(timestamp))) throw new Error('美联储日历格式变化');
  return events;
}

function parseBls(ical) {
  const data = ical.replace(/\r?\n[ \t]/g, '');
  if (!data.startsWith('BEGIN:VCALENDAR') || !data.includes('BEGIN:VEVENT')) throw new Error('劳工统计局日历格式变化');
  const releases = [
    [/^Consumer Price Index\b/i, '美国消费者物价指数 CPI'],
    [/^Employment Situation\b/i, '美国非农就业报告'],
    [/^Producer Price Index\b/i, '美国生产者物价指数 PPI'],
  ];
  return [...data.matchAll(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/g)].flatMap(([, event]) => {
    if (/^STATUS:CANCELLED\s*$/mi.test(event)) return [];
    const summary = event.match(/^SUMMARY:(.*)$/m)?.[1] ?? '';
    const type = releases.find(([pattern]) => pattern.test(summary));
    const start = event.match(/^DTSTART(?:;TZID=(?:America\/New_York|US\/Eastern))?:(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})\d{2}(Z)?\s*$/m);
    if (!type || !start) return [];
    const [, year, month, day, hour, minute, utc] = start;
    const date = makeDate(year, month, day);
    const time = `${hour}:${minute}`;
    const timestamp = utc ? Date.parse(`${date}T${time}:00Z`) : easternTime(date, time);
    return [{ timestamp, title: type[1], source: 'bls' }];
  });
}

function parseEia(html, now) {
  const table = html.match(/<table[^>]*class="[^"]*\bschedule\b[^"]*"[^>]*>([\s\S]*?)<\/table>/i)?.[1];
  if (!table || !/10:30 a\.m\. eastern time on Wednesday/i.test(html)) throw new Error('能源信息署日历格式变化');
  const exceptions = new Map();
  for (const [, ending, publish, time] of table.matchAll(/<th scope="row">([^<]+)<\/th>\s*<td>([^<]+)<\/td>\s*<td>[^<]+<\/td>\s*<td>([^<]+)<\/td>/g)) {
    const friday = Date.parse(ending + ' GMT');
    const alternate = Date.parse(publish + ' GMT');
    const hours = time.match(/^(\d{1,2}):(\d{2})\s+([ap])\.m\.$/i);
    if (!Number.isFinite(friday) || !Number.isFinite(alternate) || !hours) continue;
    const hour = (Number(hours[1]) % 12) + (hours[3].toLowerCase() === 'p' ? 12 : 0);
    const standardDate = dateAt(friday + 5 * DAY);
    exceptions.set(standardDate, easternTime(dateAt(alternate), `${String(hour).padStart(2, '0')}:${hours[2]}`));
  }
  const events = [];
  for (let offset = -2; offset <= 8; offset++) {
    const date = dateAt(scheduledAt(dateAt(now)) + offset * DAY);
    if (new Date(date).getUTCDay() !== 3) continue;
    const timestamp = exceptions.get(date) ?? easternTime(date, '10:30');
    events.push({ timestamp, title: '美国 EIA 周度石油库存', source: 'eia' });
  }
  return events;
}

async function fetchCalendar(read, now) {
  const jobs = [
    ['fomc', 'text/html', parseFomc],
    ['bls', 'text/calendar', parseBls],
    ['eia', 'text/html', parseEia],
  ];
  const results = await Promise.allSettled(jobs.map(([id, accept, parse]) =>
    read(CALENDAR_URLS[id], accept).then((data) => parse(data, now))));
  return Object.fromEntries(results.flatMap((result, index) =>
    result.status === 'fulfilled' ? [[jobs[index][0], { fetchedAt: now, events: result.value }]] : []));
}

function upcomingCalendar(calendar, now) {
  const sources = Object.entries(calendar ?? {}).filter(([, entry]) => now - entry.fetchedAt <= 3 * DAY);
  const until = scheduledAt(dateAt(now)) + 7 * DAY;
  const events = sources.flatMap(([, entry]) => entry.events)
    .filter(({ timestamp }) => timestamp > now && timestamp <= until)
    .sort((a, b) => a.timestamp - b.timestamp);
  return { events, available: sources.map(([id]) => id) };
}

module.exports = { CALENDAR_URLS, fetchCalendar, upcomingCalendar, parseFomc, parseBls, parseEia };
