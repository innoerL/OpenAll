const { DatabaseSync } = require('node:sqlite');
const { dateAt } = require('./time.cjs');
const { MODEL_VERSION, classifyReturn } = require('./outlook.cjs');
const { onSchedule, summarizeChecks } = require('./forecast-verification.cjs');

class Store {
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS jobs (
        kind TEXT NOT NULL,
        instrument TEXT NOT NULL,
        slot TEXT NOT NULL,
        status TEXT NOT NULL,
        retry_at INTEGER,
        detail TEXT,
        PRIMARY KEY (kind, instrument, slot)
      );
      CREATE TABLE IF NOT EXISTS quotes (
        instrument TEXT NOT NULL,
        slot TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        price REAL NOT NULL,
        date TEXT NOT NULL,
        quote_time TEXT,
        source TEXT NOT NULL,
        note TEXT NOT NULL,
        PRIMARY KEY (instrument, slot)
      );
      CREATE TABLE IF NOT EXISTS history (
        instrument TEXT NOT NULL,
        date TEXT NOT NULL,
        price REAL NOT NULL,
        source TEXT NOT NULL,
        PRIMARY KEY (instrument, date)
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS forecast_checks (
        model_version TEXT NOT NULL,
        instrument TEXT NOT NULL,
        origin TEXT NOT NULL,
        target TEXT NOT NULL,
        issued_at INTEGER NOT NULL,
        origin_fetched_at INTEGER NOT NULL,
        origin_price REAL NOT NULL,
        estimate TEXT NOT NULL,
        target_fetched_at INTEGER,
        target_price REAL,
        actual TEXT,
        PRIMARY KEY (model_version, instrument, origin, target)
      );
      CREATE INDEX IF NOT EXISTS forecast_checks_target ON forecast_checks (instrument, target);
    `);
  }

  close() {
    this.db.close();
  }

  commit(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      action();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  job(kind, instrument, slot) {
    return this.db.prepare('SELECT status, retry_at AS retryAt, detail FROM jobs WHERE kind = ? AND instrument = ? AND slot = ?')
      .get(kind, instrument, slot);
  }

  setJob(kind, instrument, slot, status, retryAt = null, detail = null) {
    this.db.prepare(`
      INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (kind, instrument, slot) DO UPDATE SET
      status = excluded.status, retry_at = excluded.retry_at, detail = excluded.detail
    `).run(kind, instrument, slot, status, retryAt, detail);
  }

  saveQuote(instrument, slot, quote, fetchedAt) {
    this.commit(() => {
      this.db.prepare(`
        INSERT INTO quotes VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (instrument, slot) DO UPDATE SET fetched_at = excluded.fetched_at, price = excluded.price,
        date = excluded.date, quote_time = excluded.quote_time, source = excluded.source, note = excluded.note
      `)
        .run(instrument, slot, fetchedAt, quote.price, quote.date, quote.quoteTime, quote.source, quote.note);
      this.setJob('quote', instrument, slot, 'done');
      if (quote.date === slot && dateAt(fetchedAt) === slot) this.settleForecasts(instrument, slot, quote.price, fetchedAt);
    });
  }

  settleForecasts(instrument, target, price, fetchedAt) {
    const pending = this.db.prepare(`
      SELECT model_version AS version, origin, origin_price AS price FROM forecast_checks
      WHERE instrument = ? AND target = ? AND actual IS NULL AND issued_at < ?
        AND json_type(estimate, '$.probabilities') = 'object'
    `).all(instrument, target, fetchedAt);
    const settle = this.db.prepare(`
      UPDATE forecast_checks SET target_fetched_at = ?, target_price = ?, actual = ?
      WHERE model_version = ? AND instrument = ? AND origin = ? AND target = ?
    `);
    for (const row of pending) {
      const actual = classifyReturn(Math.log(price / row.price));
      settle.run(fetchedAt, price, actual, row.version, instrument, row.origin, target);
    }
  }

  issueForecast(instrument, origin, quote, forecast, issuedAt) {
    if (quote?.date !== origin || quote.slot !== origin || dateAt(quote.fetchedAt) !== origin ||
        dateAt(issuedAt) !== origin || !forecast?.anchor.fromQuote) return forecast;
    const getIssued = this.db.prepare(`
      SELECT estimate, origin_price AS price FROM forecast_checks
      WHERE model_version = ? AND instrument = ? AND origin = ? ORDER BY target
    `);
    const get = () => getIssued.all(MODEL_VERSION, instrument, origin);
    let existing = get();
    if (!existing.length && forecast.days.some((day) => day.probabilities)) {
      this.commit(() => {
        const save = this.db.prepare(`
          INSERT OR IGNORE INTO forecast_checks
          (model_version, instrument, origin, target, issued_at, origin_fetched_at, origin_price, estimate)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const day of forecast.days) {
          save.run(MODEL_VERSION, instrument, origin, day.date, issuedAt, quote.fetchedAt, quote.price, JSON.stringify(day));
        }
      });
      existing = get();
    }
    if (!existing.length) return forecast;
    return {
      ...forecast,
      anchor: { date: origin, price: existing[0].price, fromQuote: existing[0].price === quote.price },
      days: existing.map((row) => JSON.parse(row.estimate)),
    };
  }

  forecastStats(instrument) {
    const offsets = [1, 3, 7];
    const rows = this.db.prepare(`
      SELECT origin, target, issued_at AS issuedAt, origin_fetched_at AS originFetchedAt, estimate, actual,
        target_fetched_at AS targetFetchedAt, (julianday(target) - julianday(origin)) AS horizon
      FROM forecast_checks WHERE model_version = ? AND instrument = ? AND actual IS NOT NULL
    `).all(MODEL_VERSION, instrument).filter(({ horizon }) => offsets.includes(horizon));
    const scheduled = rows.filter((row) =>
      onSchedule(row.origin, row.originFetchedAt) && onSchedule(row.origin, row.issuedAt) && onSchedule(row.target, row.targetFetchedAt));
    const byHorizon = Object.fromEntries(offsets.map((days) => [
      days,
      summarizeChecks(scheduled.filter(({ horizon }) => horizon === days)
        .map((row) => ({ ...JSON.parse(row.estimate), actual: row.actual }))),
    ]));
    return { byHorizon, late: rows.length - scheduled.length };
  }

  latestQuote(instrument) {
    return this.db.prepare(`
      SELECT slot, fetched_at AS fetchedAt, price, date, quote_time AS quoteTime, source, note
      FROM quotes WHERE instrument = ? ORDER BY slot DESC LIMIT 1
    `).get(instrument);
  }

  priorQuotes(instrument, date) {
    return this.db.prepare(`
      SELECT date, price, fetched_at AS fetchedAt FROM quotes
      WHERE instrument = ? AND date < ? AND source != '上海有色网' ORDER BY fetched_at DESC LIMIT 24
    `).all(instrument, date).reverse();
  }

  saveContext(slot, data, timestamp, retryAt) {
    this.commit(() => {
      const previous = this.getSetting('marketContext') ?? {};
      if (data.macro !== undefined) Object.assign(previous, { macro: data.macro, macroFetched: timestamp });
      if (data.news !== undefined) Object.assign(previous, { news: data.news, newsFetched: timestamp });
      if (data.calendar) previous.calendar = { ...previous.calendar, ...data.calendar };
      this.setSetting('marketContext', previous);
      this.setJob('context', 'signals', slot, retryAt ? 'retry' : 'done', retryAt, retryAt ? '部分展望数据待更新' : null);
    });
  }

  recheckOldCtfQuote(slot) {
    if (this.getSetting('officialCtfChecked')) return;
    this.commit(() => {
      const quote = this.latestQuote('ctf');
      if (quote?.slot === slot && ['上海有色网', '搜金价'].includes(quote.source)) {
        this.setJob('quote', 'ctf', slot, 'retry', null, '需要重新核对周大福官网牌价');
      }
      this.setSetting('officialCtfChecked', true);
    });
  }

  saveHistory(instrument, slot, rows, retryAt) {
    this.commit(() => {
      const upsert = this.db.prepare(`
        INSERT INTO history VALUES (?, ?, ?, ?)
        ON CONFLICT (instrument, date) DO UPDATE SET price = excluded.price, source = excluded.source
      `);
      for (const row of rows) upsert.run(row.currency ? `fx:${row.currency}` : instrument, row.date, row.price, row.source);
      this.setJob('history', instrument, slot, retryAt ? 'retry' : 'done', retryAt, retryAt ? '历史数据部分可用' : null);
    });
  }

  history(instrument, firstDate, lastDate) {
    return this.db.prepare(`
      SELECT date, price, source FROM history
      WHERE instrument = ? AND date BETWEEN ? AND ? ORDER BY date
    `).all(instrument, firstDate, lastDate);
  }

  getSetting(key) {
    const value = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
    return value === undefined ? undefined : JSON.parse(value);
  }

  setSetting(key, value) {
    this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?, ?)').run(key, JSON.stringify(value));
  }
}

module.exports = { Store };
