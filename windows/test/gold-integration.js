const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
process.env.OPENALL_TEST_MODE = '1';
const output = path.resolve(process.env.OPENALL_GOLD_TEST_OUTPUT || path.join(__dirname, '../artifacts/gold'));
fs.mkdirSync(output, { recursive: true });
require('../src/main');
const watchdog = setTimeout(() => { console.error('金价集成回归超时'); app.exit(1); }, 90000);

async function verifyForecastMetrics(search, checks) {
  const execute = (win, fn) => win.webContents.executeJavaScript(`(${fn.toString()})()`);
  const check = (condition, label) => { assert.ok(condition, label); checks.push(label); };
  async function until(fn) {
    const started = Date.now();
    while (!await fn()) {
      if (Date.now() - started > 10000) throw Error('金价评价页面更新超时');
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  }
  let gold, original;
  try {
    await execute(search, () => openall.openTool('gold'));
    await until(async () => {
      gold = BrowserWindow.getAllWindows().find(win => /gold-ui\/index\.html/.test(win.webContents.getURL()));
      return gold && execute(gold, () => !!window.OpenAllGoldUI?.ready);
    });
    await execute(gold, () => openallGold.action('view', 'outlook'));
    await execute(gold, () => document.querySelector('#forecast-ctf').click());
    original = await execute(gold, () => openallGold.read());
    check(await execute(gold, () => document.querySelector('#forecast-table th:nth-child(2)').textContent.includes('方向概率') &&
      document.querySelector('#forecast-table th:nth-child(3)').textContent === '参考估计' &&
      document.querySelector('#forecast-meta').textContent.includes('方向概率未校准') && !document.body.textContent.includes('可信度')),
    '展望使用未校准方向概率与参考估计，不把概率称为价格准确率');
    check(original.outlook.verification.ctf.byHorizon[1].priceCount === 0 &&
      await execute(gold, () => document.querySelector('#verification-note').textContent.includes('暂无到期的准时价格误差样本') &&
        !/0(?:\.0+)?%/.test(document.querySelector('#verification-note').textContent)), '没有到期样本时明确说明，不展示零误差');
    check(original.outlook.forecasts.ctf.days.some(day => day.pointMethod === 'persistence') &&
      await execute(gold, () => document.querySelector('#model-note').textContent.includes('不变价保守基准') &&
        document.querySelector('#model-note').textContent.includes('不代表保证价格不变')), '周大福保守点价说明不保证未来价格不变');

    // 只向页面发送内存快照，既不修改宿主状态，也不往预测存档写入虚构样本。
    const sample = structuredClone(original), verification = sample.outlook.verification.ctf;
    verification.byHorizon[1] = { ...verification.byHorizon[1], total: 12, hit: 8, priceCount: 12,
      mae: 15, mape: .0125, baselineMAE: 20, intervalCount: 12, intervalCoverage: .75 };
    verification.late = 2;
    verification.lateByHorizon[1] = { ...verification.byHorizon[1], total: 2, hit: 1, priceCount: 2,
      mape: .08, intervalCount: 2, intervalCoverage: .5 };
    sample.outlook.forecasts.ctf.provisional = true;
    gold.webContents.send('openall:gold-snapshot', sample);
    await until(() => execute(gold, () => document.querySelector('#verification-note').textContent.includes('1.25%')));
    check(await execute(gold, () => {
      const primary = document.querySelector('#verification-note').textContent;
      const late = document.querySelector('#verification-details').textContent;
      return primary.includes('1.25%') && primary.includes('12 次') && primary.includes('75%') &&
        !primary.includes('8%') && late.includes('迟到明日价误差 8%') && late.includes('不计入上方统计');
    }), '明日价百分比误差、样本量与区间覆盖优先展示，迟到样本分开统计');
    check(await execute(gold, () => document.querySelector('#forecast-meta').textContent.includes('数据尚未就绪，暂估')),
      '未正式发行的展望明确标记暂估');
    const persisted = await execute(gold, () => openallGold.read());
    assert.deepEqual(persisted.outlook.verification, original.outlook.verification);
    gold.webContents.send('openall:gold-snapshot', original);
    await until(() => execute(gold, () => document.querySelector('#verification-note').textContent.includes('暂无到期的准时价格误差样本')));
    check(true, '评价样例仅影响页面并已恢复，宿主统计保持不变');
  } finally {
    if (gold && !gold.isDestroyed()) {
      if (original) gold.webContents.send('openall:gold-snapshot', original);
      gold.close();
    }
  }
}

app.whenReady().then(async () => {
  const report = { passed: false, platform: process.platform, electron: process.versions.electron, checks: [], screenshots: [] };
  try {
    let search;
    const started = Date.now();
    while (!search) {
      for (const win of BrowserWindow.getAllWindows()) {
        if (await win.webContents.executeJavaScript('!!window.OpenAllApp?.ready && window.OpenAllApp.page === "search"').catch(() => false)) { search = win; break; }
      }
      if (Date.now() - started > 20000) throw Error('OpenAll 搜索初始化超时');
      if (!search) await new Promise(resolve => setTimeout(resolve, 35));
    }
    Object.assign(report, await require('../src/gold-check')(search, output));
    await verifyForecastMetrics(search, report.checks);
    report.passed = true;
  } catch (error) { Object.assign(report, error.goldReport); report.error = error.stack; console.error(error.stack); }
  finally {
    clearTimeout(watchdog); fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    app.once('will-quit', () => app.exit(report.passed ? 0 : 1));
    app.quit();
  }
});
