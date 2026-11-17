'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../src/tool-core');
const data = require('../assets/id-regions');
const { buildRegions } = require('../scripts/build-id-regions');
const source = path.join(__dirname, '../data/administrative-regions');
const text = fs.readFileSync(path.join(source, '2025.txt'), 'utf8');
const updates = JSON.parse(fs.readFileSync(path.join(source, 'updates.json'), 'utf8'));

test('离线数据与固定来源一致，全部县级代码无遗漏、无重复', () => {
  assert.deepEqual(data, buildRegions(text, updates));
  assert.equal(data.provinces.length, 31);
  const cities = data.provinces.flatMap(p => p.cities), regions = cities.flatMap(c => c.regions);
  assert.equal(cities.length, 341); assert.equal(regions.length, 2851);
  const codes = new Set(regions.map(r => r.code)); assert.equal(codes.size, regions.length);
  for (const line of text.trim().split('\n')) {
    const code = line.slice(0, 6);
    if (Number(code) < 710000 && !code.endsWith('00')) assert.ok(codes.has(code), code + ' 缺失');
  }
  for (const update of updates) assert.ok(codes.has(update.code));
  for (const province of data.provinces) for (const city of province.cities) for (const region of city.regions) {
    assert.match(region.code, /^\d{6}$/); assert.equal(region.code.slice(0, 2), province.code.slice(0, 2));
    if (!city.grouping) assert.equal(region.code.slice(0, 4), city.code.slice(0, 4));
  }
});

test('直辖市、直辖县级市、不设区县城市及新疆新增代码有明确归属', () => {
  const province = code => data.provinces.find(p => p.code === code);
  for (const code of ['110000', '120000', '310000', '500000']) {
    const p = province(code); assert.equal(p.cities.length, 1); assert.equal(p.cities[0].name, p.name);
  }
  const leaves = data.provinces.flatMap(p => p.cities).flatMap(c => c.regions);
  assert.deepEqual(leaves.filter(r => r.cityLevel).map(r => r.code).sort(), ['441900', '442000', '460400', '620200']);
  assert.ok(province('410000').cities.find(c => c.code === '419000').regions.some(r => r.code === '419001'));
  const xinjiang = province('650000');
  assert.ok(xinjiang.cities.find(c => c.code === '653100').regions.some(r => r.code === '653132' && r.name === '岑岭县'));
  assert.ok(xinjiang.cities.find(c => c.code === '659000').regions.some(r => r.code === '659013' && r.name === '草湖市'));
});

test('每个末级地区均能生成对应前六位与有效校验位', () => {
  core.provinces.forEach((p, provinceIndex) => p.cities.forEach((c, cityIndex) => c.regions.forEach((r, regionIndex) => {
    const [number] = core.generateIDs({ provinceIndex, cityIndex, regionIndex, year: 2000, month: 2, day: 29 });
    assert.equal(number.slice(0, 6), r.code); assert.ok(core.idValid(number));
  })));
});

test('随机区县仅取所选城市，切换到省范围不会漏掉其他城市', () => {
  const provinceIndex = core.provinces.findIndex(p => p.code === '330000'), p = core.provinces[provinceIndex];
  const cityIndex = p.cities.findIndex(c => c.code === '330200'), codes = new Set(p.cities[cityIndex].regions.map(r => r.code));
  const numbers = core.generateIDs({ provinceIndex, cityIndex, count: 500 });
  assert.ok(numbers.every(n => codes.has(n.slice(0, 6))));
  assert.ok(core.generateIDs({ provinceIndex, count: 500 }).every(n => n.startsWith('33')));
  for (const input of [{ cityIndex: 0 }, { regionIndex: 0 }, { provinceIndex, cityIndex: 999 }, { provinceIndex, cityIndex, regionIndex: 999 }, { provinceIndex, cityIndex: -1 }, { provinceIndex: 1.5 }]) assert.throws(() => core.generateIDs(input));
});

test('年龄按本地今天月日减去整年，支持零岁与1900年边界', () => {
  const today = new Date(2026, 10, 16, 0, 5);
  assert.deepEqual(core.birthdayFromAge(25, today), { year: 2001, month: 11, day: 16, clamped: false });
  assert.deepEqual(core.birthdayFromAge(0, today), { year: 2026, month: 11, day: 16, clamped: false });
  assert.equal(core.birthdayFromAge(126, today).year, 1900);
  for (const age of [-1, 1.5, NaN, Infinity, '25', 127]) assert.throws(() => core.birthdayFromAge(age, today));
  assert.throws(() => core.birthdayFromAge(25, new Date('invalid')));
});

test('闰日反推到平年取2月28日，闰年保留2月29日', () => {
  const today = new Date(2024, 1, 29, 23, 59);
  assert.deepEqual(core.birthdayFromAge(1, today), { year: 2023, month: 2, day: 28, clamped: true });
  assert.deepEqual(core.birthdayFromAge(4, today), { year: 2020, month: 2, day: 29, clamped: false });
  const birthday = core.birthdayFromAge(1, today), [number] = core.generateIDs(birthday);
  assert.equal(number.slice(6, 14), '20230228'); assert.ok(core.idValid(number));
});
