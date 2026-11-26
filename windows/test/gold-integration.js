const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
process.env.OPENALL_TEST_MODE = '1';
const output = path.resolve(process.env.OPENALL_GOLD_TEST_OUTPUT || path.join(__dirname, '../artifacts/gold'));
fs.mkdirSync(output, { recursive: true });
require('../src/main');
const watchdog = setTimeout(() => { console.error('金价集成回归超时'); app.exit(1); }, 90000);

async function verifyForecastMetrics(search, report) {
  const execute = (win, fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
  const check = (condition, label) => { assert.ok(condition, label); report.checks.push(label); };
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
    check(await execute(gold, () => {
      const headings = [...document.querySelectorAll('#forecast-table thead th')].map(cell => cell.innerText);
      return headings.length === 3 && headings[1].includes('参考价') && headings[2].includes('区间') &&
        !document.querySelector('#forecast-table').innerText.includes('概率') &&
        !document.querySelector('.forecast-day-toggle[aria-expanded=true]');
    }), '首屏只展示日期、参考价与区间');
    check(original.outlook.verification.ctf.byHorizon[1].priceCount === 0 &&
      await execute(gold, () => document.querySelector('#verification-note').textContent.includes('暂无到期的准时报价可验证') &&
        !/0(?:\.0+)?%/.test(document.querySelector('#verification-note').textContent)), '没有到期样本时明确说明，不展示零误差');
    check(original.outlook.forecasts.ctf.days.every(day => day.pointMethod === 'joint-history') &&
      await execute(gold, () => document.querySelector('#model-note').textContent.includes('国际现货收盘走势')),
    '周大福逐日估价展示对应的数据来源');

    const comparison = structuredClone(original);
    comparison.view = 'quotes';
    comparison.combined = true;
    const lastDate = '2026-11-19';
    Object.assign(comparison.instruments.ctf, {
      quote: { ...comparison.instruments.ctf.quote, date: comparison.today, price: 1103 },
      yesterday: { date: lastDate, price: 1091, basis: '已保存报价' },
      previousForecast: { date: lastDate, price: 1089 },
    });
    gold.webContents.send('openall:gold-snapshot', comparison);
    await until(() => execute(gold, () => ['#ctf', '#summary-ctf'].every(selector => {
      const card = document.querySelector(selector);
      const yesterday = card.querySelector('[data-reference=yesterday]');
      const forecast = card.querySelector('[data-reference=forecast]');
      return yesterday?.querySelector('.reference-price').textContent === '1,091' &&
        yesterday.querySelector('.reference-delta').textContent === '+12' &&
        forecast?.querySelector('.reference-price').textContent === '1,089' &&
        forecast.querySelector('.reference-delta').textContent === '偏差 +14';
    })));
    comparison.instruments.ctf.quote.date = lastDate;
    gold.webContents.send('openall:gold-snapshot', comparison);
    await until(() => execute(gold, () => {
      const card = document.querySelector('#summary-ctf');
      return !card.querySelector('[data-reference=yesterday] .reference-delta') &&
        card.querySelector('[data-reference=forecast] .reference-delta').textContent === '实价待更新' &&
        card.querySelector('[data-reference=forecast] .reference-price').textContent === '1,089';
    }));
    check(true, '行情与合并卡显示昨日实价、昨日预测及偏差，今价未到时保留预测价');

    const fullSize = gold.getContentSize();
    const fitsWindow = () => execute(gold, () => {
      const root = document.documentElement;
      return root.scrollHeight <= root.clientHeight + 1 && root.scrollWidth <= root.clientWidth + 1 &&
        document.querySelector('#edge-setting').getBoundingClientRect().bottom <= innerHeight;
    });
    try {
      gold.setContentSize(345, 560);
      await until(() => execute(gold, () => Math.abs(innerWidth - 345) <= 1 && Math.abs(innerHeight - 560) <= 1));
      comparison.instruments.gold.quote.date = '2026-11-18';
      comparison.instruments.gold.status = 'retry';
      comparison.instruments.ctf.status = 'pending';
      for (const combined of [true, false]) {
        comparison.combined = combined;
        gold.webContents.send('openall:gold-snapshot', comparison);
        await until(() => execute(gold, expected => {
          const ctf = document.querySelector(expected ? '#summary-ctf' : '#ctf');
          const goldCard = document.querySelector(expected ? '#summary-gold' : '#gold');
          return document.querySelector('#combined').hidden !== expected &&
            ctf.querySelector('.quote-freshness').innerText === '昨日金价 · 今日数据未更新' &&
            goldCard.querySelector('.quote-freshness').innerText === '11/18 报价 · 今日数据未更新' &&
            ctf.querySelector('.changes').hidden;
        }, combined));
        await until(fitsWindow);
      }
      check(true, '矮窄窗口的合并与分开行情一屏可见，昨日及更早报价按实际日期标记');
      comparison.view = 'outlook';
      gold.webContents.send('openall:gold-snapshot', comparison);
      await until(() => execute(gold, () => !document.querySelector('#outlook').hidden &&
        document.querySelector('.forecast-freshness')?.innerText === '昨日金价 · 今日数据未更新'));
      await until(fitsWindow);
      check(await execute(gold, () => ['#events', '#calendar'].every(selector => {
        const details = document.querySelector(selector).closest('details');
        if (details.open) return false;
        details.querySelector('summary').click();
        const opened = details.open;
        details.querySelector('summary').click();
        return opened;
      })), '矮窄窗口三日展望一屏完整，国际事件和财经日历均可就地展开');
    } finally {
      gold.setContentSize(...fullSize);
      gold.webContents.send('openall:gold-snapshot', original);
    }
    await until(() => execute(gold, () => !document.querySelector('#outlook').hidden &&
      !document.querySelector('.forecast-freshness') && document.querySelector('#ctf .quote-freshness').hidden));

    // 只向页面发送内存快照，既不修改宿主状态，也不往预测存档写入虚构样本。
    const directions = structuredClone(original);
    const directionsDays = directions.outlook.forecasts.ctf.days;
    for (const [index, direction] of ['up', 'down', 'flat'].entries()) {
      directionsDays[index].direction = direction;
      directionsDays[index].probabilities = { up: .2, down: .2, flat: .2, [direction]: .6 };
    }
    gold.webContents.send('openall:gold-snapshot', directions);
    await until(() => execute(gold, () => document.querySelectorAll('.forecast-trend')[2]?.dataset.direction === 'flat'));
    check(await execute(gold, () => {
      const rows = [...document.querySelectorAll('.forecast-day')];
      const colour = variable => {
        const sample = document.createElement('span');
        sample.style.color = 'var(' + variable + ')'; document.body.append(sample);
        const value = getComputedStyle(sample).color; sample.remove(); return value;
      };
      return [['预计涨','--rise'],['预计跌','--fall'],['预计维持','--flat']].every(([label, token], index) => {
        const row = rows[index], icon = row.querySelector('.forecast-trend');
        return icon?.getAttribute('aria-label') === label && getComputedStyle(icon).color === colour(token) &&
          row.querySelector('button').getAttribute('aria-expanded') === 'false' &&
          icon.getBoundingClientRect().right <= icon.nextElementSibling.getBoundingClientRect().left;
      }) && rows.length === 3;
    }), '收起时每日报价前显示红涨、绿跌或灰平');
    const weak = structuredClone(directions);
    const weakDays = weak.outlook.forecasts.ctf.days;
    Object.assign(weakDays[0], { direction: 'down', confidence: 47, probabilities: { up: .425, down: .471, flat: .104 } });
    Object.assign(weakDays[1], { direction: 'down', confidence: 51, probabilities: { up: .222, down: .508, flat: .270 } });
    Object.assign(weakDays[2], { direction: 'down', confidence: 60, probabilities: { up: .301, down: .599, flat: .100 } });
    gold.webContents.send('openall:gold-snapshot', weak);
    await until(() => execute(gold, () => [...document.querySelectorAll('.forecast-trend')].every(icon =>
      icon.dataset.direction === 'uncertain' && icon.getAttribute('aria-label') === '方向不明') &&
      document.querySelector('.ctf .week-direction').textContent === '方向不明'));
    check(await execute(gold, () => {
      document.querySelector('.forecast-day-toggle').click();
      const detail = document.querySelector('.forecast-detail:not([hidden])');
      const probabilities = detail?.querySelector('.direction-probabilities')?.textContent;
      document.querySelector('.forecast-day-toggle').click();
      return probabilities === '涨 42.5% · 跌 47.1% · 维持 10.4%（未校准）';
    }), '弱信号使用独立的方向不明标记，展开仍可查看三个方向概率');
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

    // 第三天的快照改变后，详情必须带出同一日期的新概率。
    const refreshed = structuredClone(original);
    const updatedDay = refreshed.outlook.forecasts.ctf.days[2];
    updatedDay.direction = 'up';
    updatedDay.confidence = 85;
    updatedDay.probabilities = { up: .85, down: .10, flat: .05 };
    await execute(gold, () => document.querySelectorAll('.forecast-day-toggle')[2].click());
    gold.webContents.send('openall:gold-snapshot', refreshed);
    await until(() => execute(gold, () => {
      const button = document.querySelectorAll('.forecast-day-toggle')[2];
      return button.getAttribute('aria-expanded') === 'true' &&
        /8[45]%/.test(document.getElementById(button.getAttribute('aria-controls')).innerText);
    }));
    check(true, '收到行情刷新后仍展示所选日期的最新概率');
    await execute(gold, () => document.querySelectorAll('.forecast-day-toggle')[2].click());

    for (const [id,step] of [['ctf',1],['gold',.01]]) {
      await execute(gold, instrument => document.querySelector('#forecast-' + instrument).click(), id);
      const rounded = structuredClone(original);
      const forecast = rounded.outlook.forecasts[id];
      const template = forecast.days.find(day => Number.isFinite(day.mid));
      [0,1].forEach(index => {
        forecast.days[index] = {...template,date:forecast.days[index].date,low:1207,high:1209,
          mid:1208 + (index ? .4 : -.4) * step};
      });
      gold.webContents.send('openall:gold-snapshot', rounded);
      const expected = id === 'ctf' ? '1,208' : '1,208.00';
      await until(() => execute(gold, text => [...document.querySelectorAll('.forecast-price')].slice(0,2)
        .every(cell => cell.innerText === text), expected));
      check(await execute(gold, () => {
        const bars = [...document.querySelectorAll('.forecast-day .range-track i')].slice(0,2);
        return bars.length === 2 && bars[0].style.left === bars[1].style.left &&
          Math.abs(bars[0].getBoundingClientRect().left - bars[1].getBoundingClientRect().left) < .1;
      }), id === 'ctf' ? '相同整元牌价的两日参考点重合' : '相同分位国际金价的两日参考点重合');
    }
    await execute(gold, () => document.querySelector('#forecast-ctf').click());

    const stale = structuredClone(original);
    stale.instruments.ctf.quote.date = '2026-11-19';
    stale.instruments.ctf.quote.price = 1058;
    gold.webContents.send('openall:gold-snapshot', stale);
    await until(() => execute(gold, () => document.querySelector('#forecast-title').innerText === '最近周大福牌价'));
    check(await execute(gold, () => {
      const lines = document.querySelectorAll('#forecast-meta .forecast-baseline');
      return lines[0].querySelector('strong').textContent === '1,058 人民币/克' &&
        !lines[0].querySelector('time').hidden && lines[0].querySelector('time').dateTime === '2026-11-19' && lines[1].textContent.includes('预测基准') &&
        document.querySelector('#today-key').hidden && !document.querySelector('.range-today');
    }), '已有预测与当前报价不同，表头分别标记最近牌价及预测基准');

    for (const price of [null, 123456789]) {
      const outside = structuredClone(original);
      outside.instruments.ctf.quote = price == null ? null : {...outside.instruments.ctf.quote,price};
      gold.webContents.send('openall:gold-snapshot', outside);
      await until(() => execute(gold, expected => document.querySelector('.forecast-baseline strong').textContent === expected,
        price == null ? '待更新' : '123,456,789 人民币/克'));
      check(await execute(gold, () => document.querySelector('#today-key').hidden && !document.querySelector('.range-today')),
        price == null ? '没有今日实价时关闭虚线及图例' : '超出共有刻度的实价不显示虚线或改变刻度');
    }

    const partial = structuredClone(original);
    const partialDay = partial.outlook.forecasts.ctf.days[2];
    delete partialDay.probabilities;
    gold.webContents.send('openall:gold-snapshot', partial);
    await until(() => execute(gold, () => {
      const button = document.querySelectorAll('.forecast-day-toggle')[2];
      if (button.getAttribute('aria-expanded') !== 'true') button.click();
      const detail = document.getElementById(button.getAttribute('aria-controls'));
      return !detail.querySelector('.day-direction') && /概率/.test(detail.innerText);
    }));
    const partialView = await execute(gold, () => {
      const button=document.querySelectorAll('.forecast-day-toggle')[2], row=button.closest('tr');
      return {price: row.querySelector('.forecast-price').textContent, range: row.querySelector('.range-values').textContent,
        detail: document.getElementById(button.getAttribute('aria-controls')).innerText};
    });
    const formatCTF = new Intl.NumberFormat('zh-CN',{maximumFractionDigits:0});
    check(partialView.price === formatCTF.format(partialDay.mid) &&
      [partialDay.low,partialDay.high].every(n=>partialView.range.includes(formatCTF.format(n))) &&
      !/样本不足|不生成参考价|不提供参考价|[0-9]+%/.test(partialView.detail),
      '存档缺概率时保留已有参考价和区间，详情仅提示缺失的信息');

    const savedSize = gold.getContentSize();
    const principal = 123456789.12;
    try {
      gold.setContentSize(345, savedSize[1]);
      await until(() => execute(gold, () => innerWidth <= 345));
      for (const [currency,id] of [['USD','gold'],['CNY','gold'],['CNY','ctf']]) {
        const large = structuredClone(original);
        large.currency = currency;
        await execute(gold, id === 'gold' ? () => document.querySelector('#forecast-gold').click()
          : () => document.querySelector('#forecast-ctf').click());
        const day = large.outlook.forecasts[id].days.find(entry => entry.model);
        large.outlook.forecasts[id].days[0] = {...day,date:large.outlook.forecasts[id].days[0].date,mid:principal,low:principal-100,high:principal+100};
        gold.webContents.send('openall:gold-snapshot', large);
        await until(() => execute(gold, () => document.querySelector('.forecast-price').textContent.includes('123,456,789')));
        const geometry = await execute(gold, () => {
          const table = document.querySelector('#forecast-table').getBoundingClientRect();
          const overflows = [];
          for (const cell of document.querySelector('.forecast-day').cells) {
            const box = cell.getBoundingClientRect();
            const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
            for (let text = walker.nextNode(); text; text = walker.nextNode()) {
              if (!text.textContent.trim()) continue;
              const range = document.createRange();
              range.selectNodeContents(text);
              for (const rect of range.getClientRects()) {
                if (rect.left < box.left - 1 || rect.right > box.right + 1) {
                  overflows.push({column:cell.cellIndex,text:text.textContent,cell:[box.left,box.right],glyph:[rect.left,rect.right]});
                }
              }
            }
          }
          return {innerWidth,documentWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,
            tableLeft:table.left,tableRight:table.right,tableWidth:table.width,price:document.querySelector('.forecast-price').textContent,overflows};
        });
        report.narrowAmounts.push({currency,instrument:id,...geometry});
        // 窗口内宽含原生滚动条，可布局宽度由浏览器实际占用决定。
        const fits = Math.abs(geometry.innerWidth - 345) <= 1 && geometry.scrollWidth <= geometry.documentWidth + 1 &&
          geometry.tableLeft >= 0 && geometry.tableRight <= geometry.documentWidth + 1 && !geometry.overflows.length;
        if (!fits) {
          const filename = 'gold-outlook-long-' + currency + '-' + id + '.png';
          fs.writeFileSync(path.join(output, filename), (await gold.webContents.capturePage()).toPNG());
          report.screenshots.push(filename);
        }
        check(fits, '345 像素下长金额完整留在各列：'+currency+' / '+id);
      }
    } finally {
      gold.setContentSize(...savedSize);
      gold.webContents.send('openall:gold-snapshot', original);
    }

    const sparse = structuredClone(original);
    const reasons = ['gold-history', 'ctf-history', 'paired-history'];
    sparse.outlook.forecasts.ctf.days = sparse.outlook.forecasts.ctf.days.map(({date}, index) => ({
      date, sparse: true, sparseReason: reasons[index % reasons.length],
    }));
    gold.webContents.send('openall:gold-snapshot', sparse);
    await until(() => execute(gold, () => !(/\d/).test(document.querySelector('#forecast-rows .forecast-price').textContent)));
    check(await execute(gold, () => {
      const dates = [...document.querySelectorAll('.forecast-day-toggle')].map(button => button.dataset.date);
      const reasons = ['国际行情不足','牌价历史不足','同期样本不足'];
      return document.querySelector('#today-key').hidden && !document.querySelector('.range-today') && dates.length === 3 && dates.every((date, i) => {
        const button = document.querySelector('.forecast-day-toggle[data-date="' + date + '"]');
        button.click();
        const row = button.closest('tr'), detail = document.getElementById(button.getAttribute('aria-controls'));
        const reason = row.innerText + (detail?.innerText || '');
        return !row.querySelector('.forecast-trend') && reason.includes(reasons[i % reasons.length]) && !(/\d+%/).test(row.innerText) && !(/\d+%/).test(detail?.innerText || '');
      });
    }), '缺国际行情、近期牌价或配对样本时逐日说明原因，避免显示虚构概率');

    const closed = structuredClone(original);
    closed.outlook.forecasts.gold.days[0] = {date: closed.outlook.forecasts.gold.days[0].date, closed: true};
    gold.webContents.send('openall:gold-snapshot', closed);
    await execute(gold, () => document.querySelector('#forecast-gold').click());
    await until(() => execute(gold, () => {
      const button = document.querySelector('.forecast-day-toggle');
      if (button.getAttribute('aria-expanded') !== 'true') button.click();
      const row = button.closest('tr'), detail = document.getElementById(button.getAttribute('aria-controls'));
      return !row.querySelector('.forecast-trend') && (row.innerText + (detail?.innerText || '')).includes('休市') && !(/\d+%/).test(detail?.innerText || '');
    }));
    check(true, '国际休市日可以查看原因并保留空价格');
    await execute(gold, () => document.querySelector('#forecast-ctf').click());

    const empty = structuredClone(original);
    empty.outlook.forecasts.ctf = null;
    gold.webContents.send('openall:gold-snapshot', empty);
    await until(() => execute(gold, () => document.querySelector('#forecast-table').hidden));
    check(await execute(gold, () => document.querySelector('#forecast-title').innerText === '今日周大福牌价' &&
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
    verification.recent = { origin: '2026-11-18', target: '2026-11-21', horizon: 3, onSchedule: true,
      predictedDirection: 'down', actualDirection: 'up', directionProbability: .51,
      predictedReturn: -.01, actualReturn: .02, errorRate: .03 };
    sample.outlook.forecasts.ctf.provisional = true;
    gold.webContents.send('openall:gold-snapshot', sample);
    await until(() => execute(gold, () => document.querySelector('#verification-note').textContent.includes('1.25%')));
    check(await execute(gold, () => {
      const primary = document.querySelector('#verification-note').textContent;
      const late = document.querySelector('#verification-details').textContent;
      return primary.includes('1.25%') && primary.includes('12 次') && primary.includes('75%') &&
        !primary.includes('8%') && late.includes('迟到明日价误差 8%') && late.includes('不计入上方统计');
    }), '明日价百分比误差、样本量与区间覆盖优先展示，迟到样本分开统计');
    check(await execute(gold, () => document.querySelector('#forecast-meta').textContent.includes('暂估 · 尚未存档')),
      '未正式发行的展望明确标记暂估');
    check(await execute(gold, () => {
      const recent = document.querySelector('#verification-recent').textContent;
      return recent.includes('2026-11-18 预测 2026-11-21（3 日）') &&
        recent.includes('模型判跌（51%），实际涨 +2.00%，方向未命中');
    }), '到期记录保留原始模型判断，并明确标出了实际方向和未命中');
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
    report.narrowAmounts = [];
    await verifyForecastMetrics(search, report);
    report.passed = true;
  } catch (error) { Object.assign(report, error.goldReport); report.error = error.stack; console.error(error.stack); }
  finally {
    clearTimeout(watchdog); fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    app.once('will-quit', () => app.exit(report.passed ? 0 : 1));
    app.quit();
  }
});
