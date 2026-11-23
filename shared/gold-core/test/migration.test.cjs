const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { Store } = require('../store.cjs');
const { openGoldStore } = require('../migrate.cjs');

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openall-gold-migration-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  fs.mkdirSync(path.join(root, '旧金价 #1'));
  fs.mkdirSync(path.join(root, 'host'));
  const legacy = path.join(root, '旧金价 #1');
  return { legacy, source: path.join(legacy, 'quotes.sqlite'), destination: path.join(root, 'host/quotes.sqlite') };
}

for (const hasForecasts of [false, true]) {
  test(`首次导入${hasForecasts ? '五' : '四'}表旧库，包含原应用仍打开的 WAL 数据`, t => {
    const { legacy, source, destination } = directory(t);
    const original = new Store(source);
    try {
      if (!hasForecasts) original.db.exec('DROP TABLE forecast_checks');
      else original.db.exec(`INSERT INTO forecast_checks (model_version,instrument,origin,target,issued_at,origin_fetched_at,origin_price,estimate)
        VALUES ('1','gold','2026-10-01','2026-10-02',1,1,100,'{"date":"2026-10-02"}')`);
      original.setSetting('currency', 'CNY');
      original.setSetting('firstSlot', '2026-10-01');
      original.setJob('quote', 'gold', '2026-11-20', 'done');
      original.saveHistory('gold', '2026-11-20', [{ date: '2026-11-19', price: 2345, source: '样例' }]);
      assert.ok(fs.statSync(source + '-wal').size > 0);
      const { store, imported, warning } = openGoldStore(destination, legacy);
      try {
        assert.equal(warning, null);
        assert.equal(imported, true);
        assert.equal(store.getSetting('currency'), 'CNY');
        assert.equal(store.getSetting('firstSlot'), '2026-10-01');
        assert.equal(store.job('quote', 'gold', '2026-11-20').status, 'done');
        assert.equal(store.history('gold', '2026-11-19', '2026-11-20')[0].price, 2345);
        assert.equal(store.db.prepare('SELECT count(*) AS n FROM forecast_checks').get().n, Number(hasForecasts));
        store.setSetting('currency', 'EUR');
        assert.equal(original.getSetting('currency'), 'CNY');
        assert.equal(!!original.db.prepare("SELECT 1 FROM sqlite_master WHERE name='forecast_checks'").get(), hasForecasts);
      } finally { store.close(); }
    } finally { original.close(); }
  });
}

test('空白宿主正常启用，既有宿主不覆盖且不会访问迁入的无关文件', t => {
  const { legacy, source, destination } = directory(t);
  const first = openGoldStore(destination, legacy);
  try {
    assert.equal(first.imported, false);
    assert.equal(first.warning, null);
    first.store.setSetting('currency', 'EUR');
  } finally { first.store.close(); }
  fs.writeFileSync(source, '不是数据库');
  const next = openGoldStore(destination, legacy);
  try {
    assert.equal(next.imported, false);
    assert.equal(next.warning, null);
    assert.equal(next.store.getSetting('currency'), 'EUR');
  } finally { next.store.close(); }
});

for (const problem of ['无关库', '损坏文件', '同名异构表', '损坏设置']) {
  test(`${problem}不阻塞宿主；原库只读，修复后重试并保留期间新增记录`, t => {
    const { legacy, source, destination } = directory(t);
    if (problem === '损坏文件') fs.writeFileSync(source, '不是数据库');
    else if (problem === '无关库') {
      const db = new DatabaseSync(source);
      try { db.exec('CREATE TABLE unrelated (value TEXT)'); } finally { db.close(); }
    } else {
      const old = new Store(source);
      try {
        old.setJob('quote', 'gold', '2026-10-01', 'done');
        if (problem === '同名异构表') old.db.exec('ALTER TABLE settings RENAME COLUMN value TO other_value');
        else old.db.exec("INSERT INTO settings VALUES ('currency', 'not json')");
      } finally { old.close(); }
    }
    const before = fs.readFileSync(source);
    const first = openGoldStore(destination, legacy);
    try {
      assert.equal(first.imported, false);
      assert.match(first.warning, /重试/);
      assert.equal(first.store.job('quote', 'gold', '2026-10-01'), undefined, '失败的导入事务全部回滚');
      first.store.setSetting('currency', 'EUR');
    } finally { first.store.close(); }
    assert.deepEqual(fs.readFileSync(source), before);
    fs.renameSync(source, source + '.saved');
    const repaired = new Store(source);
    try {
      repaired.setSetting('currency', 'CNY');
      repaired.setSetting('combined', true);
      repaired.setJob('quote', 'gold', '2026-10-01', 'done');
    } finally { repaired.close(); }
    const next = openGoldStore(destination, legacy);
    try {
      assert.equal(next.imported, true);
      assert.equal(next.warning, null);
      assert.equal(next.store.getSetting('currency'), 'EUR');
      assert.equal(next.store.getSetting('combined'), true);
      assert.equal(next.store.job('quote', 'gold', '2026-10-01').status, 'done');
    } finally { next.store.close(); }
    const last = openGoldStore(destination, legacy);
    try { assert.equal(last.imported, false); } finally { last.store.close(); }
  });
}
