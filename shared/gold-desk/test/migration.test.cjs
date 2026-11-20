const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../app/store.cjs');
const { migrateLegacyData } = require('../app/migrate.cjs');
const { helperDataDirectory } = require('../app/data-location.cjs');

test('辅助进程误继承样例环境时也不会覆盖正式或显式指定的用户目录', () => {
  const official = path.join(os.tmpdir(), 'openall-not-created-data');
  const first = helperDataDirectory(official, '', true);
  const second = helperDataDirectory(official, official, true);
  try {
    assert.notEqual(first, second);
    assert.notEqual(first, path.join(official, 'OpenAll/gold'));
    assert.notEqual(second, official);
    assert.equal(path.dirname(first), os.tmpdir());
    assert.equal(helperDataDirectory(official, '', false), path.join(official, 'OpenAll/gold'));
    assert.equal(helperDataDirectory(official, official, false), official);
  } finally {
    fs.rmSync(first, { force: true, recursive: true });
    fs.rmSync(second, { force: true, recursive: true });
  }
});

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openall-gold-migration-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  fs.mkdirSync(path.join(root, 'legacy'));
  fs.mkdirSync(path.join(root, 'host'));
  return { legacy: path.join(root, 'legacy'), destination: path.join(root, 'host/quotes.sqlite') };
}

test('首次导入包含原应用仍打开的 WAL 数据，并保留原库与任务设置', async t => {
  const { legacy, destination } = directory(t);
  const original = new Store(path.join(legacy, 'quotes.sqlite'));
  t.after(() => original.close());
  original.setSetting('currency', 'CNY');
  original.setSetting('firstSlot', '2026-10-01');
  original.setJob('quote', 'gold', '2026-11-20', 'done');
  assert.ok(fs.statSync(path.join(legacy, 'quotes.sqlite-wal')).size > 0);
  assert.equal(await migrateLegacyData(destination, legacy), true);
  const copied = new Store(destination);
  try {
    assert.equal(copied.getSetting('currency'), 'CNY');
    assert.equal(copied.getSetting('firstSlot'), '2026-10-01');
    assert.equal(copied.job('quote', 'gold', '2026-11-20').status, 'done');
    copied.setSetting('currency', 'EUR');
    assert.equal(original.getSetting('currency'), 'CNY');
  } finally { copied.close(); }
});

test('宿主已有数据时不覆盖，即使旧文件无效', async t => {
  const { legacy, destination } = directory(t);
  fs.writeFileSync(path.join(legacy, 'quotes.sqlite'), '不是数据库');
  const existing = new Store(destination);
  existing.setSetting('currency', 'EUR');
  try {
    assert.equal(await migrateLegacyData(destination, legacy), false);
    assert.equal(existing.getSetting('currency'), 'EUR');
  } finally { existing.close(); }
});

test('不存在旧数据时继续使用新库，导入失败不留下半成品', async t => {
  const { legacy, destination } = directory(t);
  assert.equal(await migrateLegacyData(destination, legacy), false);
  fs.writeFileSync(path.join(legacy, 'quotes.sqlite'), '不是数据库');
  await assert.rejects(migrateLegacyData(destination, legacy), /原数据未修改/);
  assert.equal(fs.existsSync(destination), false);
  assert.equal(fs.readFileSync(path.join(legacy, 'quotes.sqlite'), 'utf8'), '不是数据库');
  assert.equal(fs.readdirSync(path.dirname(destination)).length, 0);
});
