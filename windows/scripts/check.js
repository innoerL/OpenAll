const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
for (const folder of ['src', 'test', 'scripts', '../shared/gold-desk/app', '../shared/gold-desk/test']) {
  for (const name of fs.readdirSync(folder)) {
    if (/\.[cm]?js$/.test(name)) execFileSync(process.execPath, ['--check', path.join(folder, name)], { stdio: 'inherit' });
  }
}
console.log('JavaScript 语法检查通过');
