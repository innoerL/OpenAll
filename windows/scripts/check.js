const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
for (const folder of ['src', 'test', 'scripts', '../shared/gold-core', '../shared/gold-core/test', '../shared/gold-ui']) {
  for (const name of fs.readdirSync(folder)) {
    if (/\.[cm]?js$/.test(name)) execFileSync(process.execPath, ['--check', path.join(folder, name)], { stdio: 'inherit' });
  }
}
console.log('JavaScript 语法检查通过');
