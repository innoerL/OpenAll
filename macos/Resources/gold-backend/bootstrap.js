// 原业务模块保持原样；此文件仅适配 JavaScriptCore 与原生宿主之间的边界。
(() => {
  'use strict';
  const pending = new Map();
  let nextRequest = 0;
  const nativeRequest = (kind, payload) => new Promise((resolve, reject) => {
    const id = ++nextRequest;
    pending.set(id, { resolve, reject });
    __request(JSON.stringify({ id, kind, ...payload }));
  });
  globalThis.__complete = (id, error, value) => {
    const item = pending.get(id);
    if (!item) return;
    pending.delete(id);
    if (error) item.reject(new Error(error));
    else item.resolve(value);
  };
  globalThis.AbortSignal = class AbortSignal {
    static timeout(milliseconds) { return { timeout: milliseconds }; }
  };
  globalThis.URL = class URL {
    constructor(value) {
      const parsed = JSON.parse(__parseURL(String(value)));
      if (parsed.error) throw new TypeError(parsed.error);
      Object.assign(this, parsed);
    }
  };
  const fetcher = async (url, options = {}) => {
    const response = await nativeRequest('fetch', {
      url: String(url), method: options.method ?? 'GET', headers: options.headers ?? {},
      timeout: options.signal?.timeout ?? 15000, redirect: options.redirect ?? 'follow',
    });
    return {
      ok: response.status >= 200 && response.status < 300, status: response.status,
      text: async () => response.body, json: async () => JSON.parse(response.body),
    };
  };
  const sql = (action, sql, parameters = []) => {
    const result = JSON.parse(__sql(JSON.stringify({ action, sql, parameters })));
    if (result.error) throw new Error(result.error);
    return result.value;
  };
  class DatabaseSync {
    constructor(filename) { sql('open', filename); }
    exec(statement) { sql('exec', statement); }
    close() { sql('close', ''); }
    prepare(statement) {
      return {
        run: (...parameters) => sql('run', statement, parameters),
        all: (...parameters) => sql('all', statement, parameters),
        get: (...parameters) => sql('all', statement, parameters)[0],
      };
    }
  }
  const cache = new Map();
  function require(name) {
    if (name === 'node:sqlite') return { DatabaseSync };
    const id = name.replace(/^\.\//, '');
    if (!Object.hasOwn(__moduleSources, id)) throw new Error(`不支持的金价模块：${name}`);
    if (cache.has(id)) return cache.get(id).exports;
    const module = { exports: {} };
    cache.set(id, module);
    new Function('require', 'module', 'exports', __moduleSources[id] + '\n//# sourceURL=gold-core/' + id)(require, module, module.exports);
    return module.exports;
  }
  const { Store } = require('./store.cjs');
  const { Scheduler } = require('./scheduler.cjs');
  const { createSources, parseOfficialCtf } = require('./sources.cjs');
  const { CURRENCIES } = require('./currency.cjs');
  const sample = __configuration.fixture ? require('./fixture.cjs').createFixture() : null;
  const store = new Store(__configuration.filename);
  let stopped = false;
  let osOnline = true;
  let internetOnline = true;
  let probing = false;
  let lastPublished;
  const snapshot = () => ({
    ...scheduler.snapshot(), pinned: store.getSetting('pinned') ?? true,
    dark: store.getSetting('dark') ?? false, edgeEnabled: store.getSetting('edgeEnabled') ?? true,
    combined: Boolean(store.getSetting('combined')), position: store.getSetting('position') ?? null,
    dockSide: null, imported: __configuration.imported,
  });
  const publish = () => {
    if (stopped) return;
    const next = JSON.stringify(snapshot());
    if (next !== lastPublished) { lastPublished = next; __publish(next); }
  };
  const scheduler = new Scheduler({
    store, clock: sample?.clock ?? Date.now, online: () => osOnline && internetOnline, publish,
    sources: sample?.sources ?? createSources(fetcher, Date.now,
      async () => parseOfficialCtf(await nativeRequest('official', {}))),
    onConnectionError: () => { void probeInternet(); },
  });
  const tick = async reason => {
    if (!stopped) await scheduler.tick(reason);
  };
  async function probeInternet() {
    if (sample || probing || !osOnline || stopped) return;
    probing = true;
    try {
      await Promise.any(['https://gold-api.com/', 'https://precious.smm.cn/'].map(url =>
        fetcher(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) })));
      const recovered = !internetOnline;
      internetOnline = true;
      if (recovered && !stopped) await tick('reconnect');
    } catch { internetOnline = false; }
    finally { probing = false; publish(); }
  }
  globalThis.__gold = {
    snapshot: () => JSON.stringify(snapshot()),
    async start(id) {
      try { await tick('startup'); __started(id, '', JSON.stringify(snapshot())); }
      catch (error) { __started(id, String(error.message ?? error), ''); }
    },
    tick(reason) {
      if (!internetOnline) void probeInternet();
      void tick(reason).catch(error => __report(String(error.message ?? error)));
    },
    network(available, resumed = false) {
      const wasOnline = osOnline;
      osOnline = sample ? true : available;
      publish();
      if (!osOnline) return;
      if (!internetOnline) void probeInternet();
      else if (resumed || !wasOnline) this.tick(!wasOnline ? 'reconnect' : 'resume');
    },
    recheck() { void probeInternet(); },
    currency(value) { if (CURRENCIES.includes(value)) store.setSetting('currency', value); publish(); return this.snapshot(); },
    preference(key) { return JSON.stringify(store.getSetting(key) ?? null); },
    setPreference(key, encoded) { store.setSetting(key, JSON.parse(encoded)); publish(); return this.snapshot(); },
    stop() { stopped = true; scheduler.stop(); pending.clear(); store.close(); },
  };
})();
