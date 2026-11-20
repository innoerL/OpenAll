const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync, backup } = require('node:sqlite');

// 在线一致性备份包含尚在 WAL 中的数据，原应用的数据库始终只读。
async function migrateLegacyData(destination, legacyDirectory) {
  if (fs.existsSync(destination) || !legacyDirectory) return false;
  const source = path.join(legacyDirectory, 'quotes.sqlite');
  if (!fs.existsSync(source) || path.resolve(source) === path.resolve(destination)) return false;
  const temporary = `${destination}.importing-${process.pid}`;
  let db;
  try {
    db = new DatabaseSync(source, { readOnly: true });
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
    if (!['jobs', 'quotes', 'history', 'settings', 'forecast_checks'].every(name => tables.has(name))) {
      throw new Error('旧数据库不是兼容的金价桌台记录');
    }
    await backup(db, temporary);
    // 另一个启动请求若已完成迁移，不覆盖它刚写入的行情。
    if (!fs.existsSync(destination)) fs.renameSync(temporary, destination);
    return true;
  } catch (error) {
    throw new Error(`导入金价桌台记录失败，原数据未修改：${error.message}`, { cause: error });
  } finally {
    db?.close();
    fs.rmSync(temporary, { force: true });
  }
}

module.exports = { migrateLegacyData };
