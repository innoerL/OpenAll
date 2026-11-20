const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function helperDataDirectory(appData, custom, fixture) {
  // 辅助进程的样例模式永不写入正式目录，即使环境变量被普通启动继承。
  if (fixture) return fs.mkdtempSync(path.join(os.tmpdir(), 'openall-gold-fixture-'));
  return custom || path.join(appData, 'OpenAll', 'gold');
}

module.exports = { helperDataDirectory };
