const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = path.resolve(__dirname, '../../shared/gold-core');
const { Store } = require(path.join(core, 'store.cjs'));
const { Scheduler } = require(path.join(core, 'scheduler.cjs'));
const { createFixture } = require(path.join(core, 'fixture.cjs'));

// 同一份业务模块分别运行于 Node 与 JavaScriptCore，逐字段核对完整模型输出。
async function main() {
  const store = new Store(':memory:');
  const sample = createFixture();
  const scheduler = new Scheduler({ store, sources: sample.sources, clock: sample.clock, online: () => true,
    publish: () => scheduler.snapshot() });
  await scheduler.tick('startup');
  const expected = JSON.parse(JSON.stringify({ ...scheduler.snapshot(), pinned: true, dark: false,
    edgeEnabled: true, combined: false, position: null, dockSide: null, imported: false }));
  const actual = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  let fields = 0;
  function compare(left, right, field = 'snapshot') {
    fields++;
    if (typeof left === 'number' && typeof right === 'number') {
      assert.ok(Math.abs(left - right) <= 1e-10 * Math.max(1, Math.abs(left)), `${field}: ${left} != ${right}`);
    } else if (left && right && typeof left === 'object' && typeof right === 'object') {
      assert.deepEqual(Object.keys(left).sort(), Object.keys(right).sort(), `${field} 字段`);
      for (const key of Object.keys(left)) compare(left[key], right[key], `${field}.${key}`);
    } else assert.deepEqual(left, right, field);
  }
  compare(expected, actual);
  store.close();
  console.log(`Node / JavaScriptCore 全快照一致：${fields} 个字段`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
