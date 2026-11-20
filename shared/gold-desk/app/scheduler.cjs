const { dateAt, dateBeforeYear, latestSlot, scheduledAt, DAY, HALF_HOUR } = require('./time.cjs');
const { isConnectionError, marketIsClosed } = require('./sources.cjs');
const { convertGold, earlier } = require('./currency.cjs');
const { getChanges } = require('./changes.cjs');
const { forecast } = require('./outlook.cjs');
const { upcomingCalendar } = require('./macro-calendar.cjs');

const INSTRUMENTS = ['gold', 'ctf'];

class Scheduler {
  constructor({ store, sources, online, publish, onConnectionError = () => {}, clock = Date.now }) {
    Object.assign(this, { store, sources, online, publish, onConnectionError, clock });
    this.running = new Set();
    this.stopped = false;
    this.forecastCache = null;
    this.firstSlot = store.getSetting('firstSlot') ?? dateAt(clock());
    store.setSetting('firstSlot', this.firstSlot);
    store.recheckOldCtfQuote(latestSlot(clock()));
  }

  snapshot() {
    const now = this.clock();
    const today = dateAt(now);
    const slot = latestSlot(now);
    const since = dateBeforeYear(today);
    const instruments = {};
    const prior = {};
    const currency = this.store.getSetting('currency') ?? 'USD';
    for (const instrument of INSTRUMENTS) {
      const job = this.store.job('quote', instrument, slot);
      const saved = this.store.latestQuote(instrument);
      const quote = instrument === 'ctf' && saved?.slot === slot &&
        ['上海有色网', '搜金价'].includes(saved.source) ? null : saved;
      const history = this.store.history(instrument, since, today);
      prior[instrument] = quote ? this.store.priorQuotes(instrument, quote.date) : [];
      if (instrument === 'ctf' && quote?.date === today) {
        const point = { date: today, price: quote.price, source: quote.source };
        if (history.at(-1)?.date === today) history[history.length - 1] = point;
        else history.push(point);
      }
      instruments[instrument] = {
        quote: quote ?? null,
        history,
        status: this.running.has(`quote:${instrument}`) ? 'loading' : job?.status ?? 'pending',
        retryAt: job?.retryAt ?? null,
        detail: job?.detail ?? null,
        historyStatus: this.running.has(`history:${instrument}`) ? 'loading' :
          this.store.job('history', instrument, today)?.status ?? 'pending',
      };
    }
    const outlook = this.outlook(instruments, today, now);
    const gold = instruments.gold;
    const rates = currency === 'USD' ? [] : this.store.history(`fx:${currency}`, earlier(since, 10), today);
    prior.gold = prior.gold.map((point) => convertGold(point, [], currency, rates).quote).filter(Boolean);
    Object.assign(gold, convertGold(gold.quote, gold.history, currency, rates));
    const goldForecast = outlook.forecasts.gold;
    if (goldForecast) {
      const { anchor, days } = goldForecast;
      const anchorPrice = anchor.date === gold.quote?.date && anchor.fromQuote ?
        gold.quote.price : convertGold(null, [anchor], currency, rates).history[0]?.price;
      const ratio = anchorPrice / anchor.price;
      outlook.forecasts.gold = Number.isFinite(ratio) ? {
        ...goldForecast,
        anchor: { ...anchor, price: anchorPrice },
        days: days.map((day) => day.mid ? { ...day, mid: day.mid * ratio, low: day.low * ratio, high: day.high * ratio } : day),
      } : null;
    }
    for (const id of INSTRUMENTS) {
      const item = instruments[id];
      item.changes = getChanges(item.quote, item.history, prior[id]);
    }
    return { today, slot, since, currency, online: this.online(), nextDailyAt: scheduledAt(dateAt(scheduledAt(slot) + DAY)), instruments, outlook };
  }

  outlook(instruments, today, now) {
    if (this.forecastCache?.date !== today) {
      const context = this.store.getSetting('marketContext') ?? {};
      const forecasts = {};
      const verification = {};
      for (const id of INSTRUMENTS) {
        const data = instruments[id];
        const value = forecast({
          instrument: id, priceHistory: data.history, goldHistory: instruments.gold.history,
          quote: data.quote, today, marketIsClosed, macro: context.macro,
        });
        if (value) value.anchor.fromQuote = data.quote?.date === value.anchor.date && data.quote?.price === value.anchor.price;
        forecasts[id] = id === 'gold' && marketIsClosed(scheduledAt(today)) ? value :
          this.store.issueForecast(id, today, data.quote, value, now);
        verification[id] = this.store.forecastStats(id);
      }
      const events = (context.news ?? []).filter((event) => event.timestamp <= now && now - event.timestamp <= 4 * DAY)
        .sort((a, b) => Number(b.tag.endsWith('风险')) - Number(a.tag.endsWith('风险')) || b.timestamp - a.timestamp);
      this.forecastCache = {
        date: today, forecasts, events, verification, calendar: context.calendar, newsFetched: context.newsFetched,
      };
    }
    const state = this.store.job('context', 'signals', today);
    const { calendar, ...cached } = this.forecastCache;
    return {
      ...cached, forecasts: { ...cached.forecasts }, calendar: upcomingCalendar(calendar, now),
      status: this.running.has('context:signals') ? 'loading' : state?.status ?? 'pending',
    };
  }

  tick(reason = 'timer') {
    if (this.stopped) return Promise.resolve();
    if (!this.online()) {
      this.publish();
      return Promise.resolve();
    }

    const now = this.clock();
    const quoteSlot = latestSlot(now);
    const today = dateAt(now);
    const force = ['startup', 'resume', 'reconnect'].includes(reason);
    const operations = INSTRUMENTS.flatMap((instrument) => {
      const history = this.run('history', instrument, today, now, force);
      return quoteSlot >= this.firstSlot ?
        [this.run('quote', instrument, quoteSlot, now, force), history] : [history];
    });
    if (this.sources.fx) operations.push(this.run('history', 'fx', today, now, force));
    if (this.sources.signals) operations.push(this.run('context', 'signals', today, now, force));
    return Promise.all(operations);
  }

  async run(kind, instrument, slot, now, force) {
    const key = `${kind}:${instrument}`;
    const state = this.store.job(kind, instrument, slot);
    if (this.running.has(key) || state?.status === 'done' || (!force && state?.retryAt > now)) return;

    this.running.add(key);
    this.publish();
    try {
      const data = await this.sources[instrument][kind](now);
      if (this.stopped) return;
      const finished = this.clock();
      if (kind === 'quote') {
        this.store.saveQuote(instrument, slot, data, finished);
      } else if (kind === 'context') {
        this.store.saveContext(slot, data, finished, data.partial ? finished + HALF_HOUR : null);
      } else {
        this.store.saveHistory(instrument, slot, data.rows ?? data, data.partial ? finished + HALF_HOUR : null);
      }
      this.forecastCache = null;
    } catch (error) {
      if (this.stopped) return;
      const detail = isConnectionError(error) ? '连接行情服务失败' :
        (error?.message?.startsWith('net::') ? '行情接口暂不可用' : (error?.message ?? '行情接口暂不可用'));
      this.store.setJob(kind, instrument, slot, 'retry', this.clock() + HALF_HOUR, detail.slice(0, 72));
      if (isConnectionError(error)) this.onConnectionError();
    } finally {
      this.running.delete(key);
      if (!this.stopped) this.publish();
    }
  }

  stop() {
    this.stopped = true;
  }
}

module.exports = { Scheduler };
