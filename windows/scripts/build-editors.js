'use strict';
const fs = require('node:fs');
const path = require('node:path');

const windowsRoot = path.resolve(__dirname, '..');
const repositoryRoot = path.resolve(windowsRoot, '..');
const comparisonRoot = path.join(repositoryRoot, 'macos/comparison-editor');
const comparisonModules = path.join(comparisonRoot, 'node_modules');
const windowsModules = path.join(windowsRoot, 'node_modules');
const installHelp = '请在仓库根目录执行：\nnpm --prefix windows ci\nnpm --prefix macos/comparison-editor ci --ignore-scripts';

function checkDependencies(root, names) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  for (const name of names) {
    const manifest = path.join(root, 'node_modules', name, 'package.json');
    if (!fs.existsSync(manifest)) throw Error(`缺少编辑器构建依赖 ${name}。\n${installHelp}`);
    const installed = JSON.parse(fs.readFileSync(manifest, 'utf8')).version;
    if (installed !== lock.packages['node_modules/' + name]?.version) throw Error(`依赖 ${name} 与锁文件不一致。\n${installHelp}`);
  }
}

function main() {
  const options = process.argv.slice(2);
  if (options.some(value => value !== '--check')) throw Error('用法：npm run build:editors [-- --check]');
  const check = options.includes('--check');
  // CodeMirror 与 esbuild 复用 Mac 已锁定的构建依赖；YAML 沿用 Windows 锁文件。
  checkDependencies(comparisonRoot, ['esbuild', '@codemirror/state', '@codemirror/view', '@codemirror/commands', '@codemirror/language']);
  checkDependencies(windowsRoot, ['yaml']);
  const esbuild = require(path.join(comparisonModules, 'esbuild'));
  const common = {
    absWorkingDir: repositoryRoot, bundle: true, format: 'iife', target: 'safari16',
    minify: true, legalComments: 'eof', write: false, nodePaths: [comparisonModules, windowsModules]
  };
  const entries = [
    ['windows/src/editor-core-view.mjs', 'editor-json.js'],
    ['windows/src/editor-core.js', 'editor-core.js', 'OpenAllEditorCore'],
    ['macos/comparison-editor/src.js', 'editor-comparison.js']
  ];
  // 先在内存生成全部资产；任一入口构建失败时，不留下部分更新的编辑器。
  const results = entries.map(([source, name, globalName]) => {
    const built = esbuild.buildSync({ ...common, entryPoints: [source], globalName });
    const file = path.join(windowsRoot, 'assets', name), content = Buffer.from(built.outputFiles[0].contents);
    return { file, name, content, equal: fs.existsSync(file) && fs.readFileSync(file).equals(content) };
  });
  if (check) {
    const different = results.filter(result => !result.equal);
    if (different.length) throw Error(`编辑器资产与源码不一致：${different.map(result => result.name).join('、')}。请运行 npm --prefix windows run build:editors 后重新检查。`);
    console.log('编辑器资产检查通过：3 个文件与源码生成结果逐字节一致，未写入文件。');
  } else {
    for (const result of results) if (!result.equal) fs.writeFileSync(result.file, result.content);
    console.log(`编辑器资产重建完成：3 个文件，更新 ${results.filter(result => !result.equal).length} 个。`);
  }
}

try { main(); }
catch (error) { console.error('编辑器构建失败：' + error.message); process.exitCode = 1; }
