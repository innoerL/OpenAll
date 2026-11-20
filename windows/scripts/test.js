const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
// UI 回归单独启动 Electron；纯逻辑测试顺序运行，保持输出简洁。
for (const folder of ['test', '../shared/gold-desk/test']) {
  for (const file of fs.readdirSync(folder).filter(name => /\.test\.[cm]?js$/.test(name) && !name.includes('-ui.'))) {
    execFileSync(process.execPath, [folder + '/' + file], { stdio: 'inherit' });
  }
}
