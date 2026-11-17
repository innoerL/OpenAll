'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

// 从固定快照构建离线三级目录；虚拟分组只用于选择界面，不用于号码地区码。
function buildRegions(text, updates = []) {
  const names = new Map();
  for (const line of text.trim().split(/\r?\n/)) {
    const match = line.match(/^(\d{6})\s+(.+)$/);
    if (!match || names.has(match[1])) throw Error('地区数据行无效或重复：' + line);
    if (Number(match[1]) < 710000) names.set(match[1], match[2]);
  }
  for (const update of updates) {
    if (!/^\d{6}$/.test(update.code) || !update.name || !update.source || names.has(update.code)) throw Error('地区增量无效');
    names.set(update.code, update.name);
  }
  const provinces = [...names].filter(([code]) => code.endsWith('0000')).map(([code, name]) => ({ code, name, cities: [] }));
  const provinceMap = new Map(provinces.map(p => [p.code.slice(0, 2), p]));
  const cities = new Map();
  const municipalities = new Set(['11', '12', '31', '50']);
  for (const [code, name] of names) {
    if (!code.endsWith('00') || code.endsWith('0000')) continue;
    const province = provinceMap.get(code.slice(0, 2));
    if (!province) throw Error('城市缺少所属省：' + code);
    const city = { code, name, regions: [] };
    cities.set(code, city); province.cities.push(city);
  }
  for (const [code, name] of [...names].sort(([a], [b]) => a.localeCompare(b))) {
    if (code.endsWith('00')) continue;
    const prefix = code.slice(0, 2), province = provinceMap.get(prefix);
    if (!province) throw Error('区县缺少所属省：' + code);
    const cityCode = municipalities.has(prefix) ? province.code : code.slice(0, 4) + '00';
    let city = cities.get(cityCode);
    if (!city) {
      if (!municipalities.has(prefix) && code.slice(2, 4) !== '90') throw Error('区县缺少所属城市：' + code);
      city = { code: cityCode, name: municipalities.has(prefix) ? province.name : (prefix === '65' ? '自治区' : '省') + '直辖县级行政区划', grouping: true, regions: [] };
      cities.set(cityCode, city); province.cities.push(city);
    }
    city.regions.push({ code, name });
  }
  for (const province of provinces) {
    province.cities.sort((a, b) => a.code.localeCompare(b.code));
    for (const city of province.cities) {
      // 东莞、中山、嘉峪关、儋州没有县级建制，保留正式市级代码作为本级选项。
      if (!city.regions.length) city.regions.push({ code: city.code, name: city.name + '（不设区县）', cityLevel: true });
    }
  }
  return { version: '2025-12-31', amendmentsThrough: updates.map(x => x.date).sort().at(-1) || null, provinces };
}

if (require.main === module) {
  const source = path.join(root, 'data/administrative-regions');
  const data = buildRegions(fs.readFileSync(path.join(source, '2025.txt'), 'utf8'), JSON.parse(fs.readFileSync(path.join(source, 'updates.json'), 'utf8')));
  const content = '// 行政区划离线快照，由 scripts/build-id-regions.js 生成；来源见 data/administrative-regions/README.md。\n(function(scope){const data=' + JSON.stringify(data) + ';if(typeof module!=="undefined"&&module.exports)module.exports=data;else scope.OpenAllIDRegions=data;})(typeof self!=="undefined"?self:globalThis);\n';
  fs.writeFileSync(path.join(root, 'assets/id-regions.js'), content);
  console.log(JSON.stringify({ provinces: data.provinces.length, cities: data.provinces.reduce((n, p) => n + p.cities.length, 0), regions: data.provinces.reduce((n, p) => n + p.cities.reduce((m, c) => m + c.regions.length, 0), 0) }));
}
module.exports = { buildRegions };
