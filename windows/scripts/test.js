const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
// UI 回归单独启动 Electron；纯逻辑测试顺序运行，保持输出简洁。
for (const file of fs.readdirSync('test').filter(name => /\.test\.js$/.test(name) && !name.includes('-ui.'))) {
  execFileSync(process.execPath, ['test/' + file], { stdio: 'inherit' });
}
