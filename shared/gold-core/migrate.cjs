const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Store } = require('./store.cjs');

const PENDING = 'openallLegacyImportPending';
const REQUIRED = ['jobs', 'quotes', 'history', 'settings'];

function importRecords(store, source) {
  const db = store.db;
  const url = pathToFileURL(source);
  url.searchParams.set('mode', 'ro');
  db.prepare('ATTACH DATABASE ? AS legacy').run(url.href);
  try {
    // 一个只读快照包含旧库尚在 WAL 中的行情。宿主记录和待重试标记在同一事务内更新。
    store.commit(() => {
      const tables = new Set(db.prepare("SELECT name FROM legacy.sqlite_master WHERE type = 'table'").all().map(row => row.name));
      if (!REQUIRED.every(name => tables.has(name))) throw Error('旧库缺少金价桌台的行情或设置表');
      const check = db.prepare('PRAGMA legacy.quick_check').get();
      if (check.quick_check !== 'ok') throw Error('旧库未通过 SQLite 完整性检查');
      const layout = db.prepare('SELECT name, type, pk FROM pragma_table_info(?, ?) ORDER BY cid');
      // 早期版本只有四张表，v1.4 已加入预测表。仅接受宿主可以读写的表结构。
      const names = tables.has('forecast_checks') ? [...REQUIRED, 'forecast_checks'] : REQUIRED;
      for (const name of names) {
        const columns = layout.all(name, 'main');
        if (JSON.stringify(layout.all(name, 'legacy')) !== JSON.stringify(columns)) throw Error(`旧库的 ${name} 表结构不兼容`);
        if (name === 'settings' && db.prepare('SELECT 1 FROM legacy.settings WHERE NOT json_valid(value) LIMIT 1').get()) {
          throw Error('旧库设置包含损坏的 JSON');
        }
        if (name === 'forecast_checks' && db.prepare("SELECT 1 FROM legacy.forecast_checks WHERE CASE WHEN json_valid(estimate) THEN json_type(estimate) <> 'object' ELSE 1 END LIMIT 1").get()) {
          throw Error('旧库预测包含损坏的记录');
        }
        const keys = columns.filter(column => column.pk).sort((left, right) => left.pk - right.pk).map(column => column.name);
        // 只跳过宿主已经拥有的主键，损坏行或其他约束冲突必须回滚整批导入。
        db.exec(`INSERT INTO main.${name} SELECT * FROM legacy.${name} WHERE true ON CONFLICT (${keys.join(', ')}) DO NOTHING`);
      }
      db.prepare('DELETE FROM main.settings WHERE key = ?').run(PENDING);
    });
  } finally {
    db.exec('DETACH DATABASE legacy');
  }
}

function openGoldStore(filename, legacyDirectory) {
  const source = filename !== ':memory:' && legacyDirectory && path.join(legacyDirectory, 'quotes.sqlite');
  const eligible = source && path.resolve(filename) !== path.resolve(source);
  const newHost = eligible && !fs.existsSync(filename);
  const store = new Store(filename);
  const result = { store, imported: false, warning: null };
  if (!eligible) return result;
  try {
    if (!newHost && store.getSetting(PENDING) !== true) return result;
    if (newHost) store.setSetting(PENDING, true);
    if (!fs.statSync(source, { throwIfNoEntry: false })) {
      // 首次打开时没有旧库，无需迁移。此前已发现的旧库暂时移走时仍允许下次重试。
      if (newHost) store.db.prepare('DELETE FROM settings WHERE key = ?').run(PENDING);
      return result;
    }
    importRecords(store, source);
    result.imported = true;
  } catch (error) {
    result.warning = `旧金价记录暂未导入，已保留原文件。OpenAll 将使用自己的记录，下次启动会重试。\n${error.message}`;
  }
  return result;
}

module.exports = { openGoldStore };
