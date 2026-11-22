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
    check(await execute(gold, () => document.querySelector('#forecast-table th:nth-child(3)').textContent.includes('概率') &&
      document.querySelector('#forecast-price-heading').textContent === '每日参考价' &&
      document.querySelector('#forecast-meta').textContent.includes('方向概率未校准') && !document.body.textContent.includes('可信度')),
    '展望区分方向概率与每日参考价');
    check(original.outlook.verification.ctf.byHorizon[1].priceCount === 0 &&
      await execute(gold, () => document.querySelector('#verification-note').textContent.includes('暂无到期的准时报价可验证') &&
        !/0(?:\.0+)?%/.test(document.querySelector('#verification-note').textContent)), '没有到期样本时明确说明，不展示零误差');
    check(original.outlook.forecasts.ctf.days.every(day => day.pointMethod === 'joint-history') &&
      await execute(gold, () => document.querySelector('#model-note').textContent.includes('国际现货收盘走势')),
    '周大福逐日估价展示对应的数据来源');

    // 只向页面发送内存快照，既不修改宿主状态，也不往预测存档写入虚构样本。
    const legacy = structuredClone(original);
    legacy.outlook.forecasts.ctf.version = '3.0.0';
    for (const day of legacy.outlook.forecasts.ctf.days) {
      day.pointMethod = 'persistence';
      day.mid = legacy.outlook.forecasts.ctf.anchor.price;
    }
    gold.webContents.send('openall:gold-snapshot', legacy);
    await until(() => execute(gold, () => document.querySelector('#forecast-price-heading').textContent === '基准参考价'));
    check(await execute(gold, () => document.querySelector('#forecast-meta').textContent.includes('旧版沿用基准价') &&
      document.querySelector('#model-note').textContent.includes('发行时的基准牌价')), '旧档按发行版本标明固定参考价');

    const stale = structuredClone(original);
    stale.instruments.ctf.quote.date = '2026-11-19';
    stale.instruments.ctf.quote.price = 1058;
    gold.webContents.send('openall:gold-snapshot', stale);
    await until(() => execute(gold, () => document.querySelector('.forecast-baseline').textContent.includes('最近周大福牌价')));
    check(await execute(gold, () => {
      const lines = document.querySelectorAll('#forecast-meta .forecast-baseline');
      return lines[0].querySelector('strong').textContent === '1,058 人民币/克' &&
        lines[0].querySelector('time').dateTime === '2026-11-19' && lines[1].textContent.includes('预测基准');
    }), '已有预测与当前报价不同，表头分别标记最近牌价及预测基准');

    const sparse = structuredClone(original);
    const reasons = ['gold-history', 'ctf-history', 'paired-history'];
    sparse.outlook.forecasts.ctf.days = sparse.outlook.forecasts.ctf.days.map(({date}, index) => ({
      date, sparse: true, sparseReason: reasons[index % reasons.length],
    }));
    gold.webContents.send('openall:gold-snapshot', sparse);
    await until(() => execute(gold, () => document.querySelector('#forecast-rows').textContent.includes('同期样本不足')));
    check(await execute(gold, () => {
      const rows = [...document.querySelectorAll('#forecast-rows tr')];
      const reasons = ['国际行情不足', '牌价历史不足', '同期样本不足'];
      return rows.length === 7 && rows.every((row, i) =>
        row.querySelector('.forecast-direction').textContent === reasons[i % reasons.length] && row.querySelector('.forecast-price').textContent === '—');
    }), '缺国际行情、近期牌价或配对样本时逐日显示原因');

    const empty = structuredClone(original);
    empty.outlook.forecasts.ctf = null;
    gold.webContents.send('openall:gold-snapshot', empty);
    await until(() => execute(gold, () => document.querySelector('#forecast-table').hidden));
    check(await execute(gold, () => document.querySelector('#forecast-meta').textContent.includes('今日周大福牌价') &&
      document.querySelector('.forecast-baseline strong').textContent.includes('人民币/克')), '预测未就绪时仍可读取今日实际牌价');

    empty.instruments.ctf.quote = null;
    gold.webContents.send('openall:gold-snapshot', empty);
    await until(() => execute(gold, () => document.querySelector('.forecast-baseline strong').textContent === '待更新'));
    check(true, '尚无牌价时显示待更新');
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
    await until(() => execute(gold, () => document.querySelector('#verification-note').textContent.includes('暂无到期的准时报价可验证')));
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
