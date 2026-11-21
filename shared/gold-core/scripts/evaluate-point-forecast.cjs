#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

function argumentsOf(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    console.log('用法：node shared/gold-core/scripts/evaluate-point-forecast.cjs --db <只读SQLite副本> --output <汇总报告目录>');
    console.log('固定复验已冻结的七候选和 persistence 选择，不支持改日期、选参或导出逐日行情。需要支持 node:sqlite 的 Node.js。');
    process.exit(0);
  }
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index], value = argv[index + 1];
    if (!['--db', '--output'].includes(name) || !value || value.startsWith('--') || options[name]) {
      throw new Error('只接受一次 --db 与 --output 参数；用 --help 查看用法。');
    }
    options[name] = path.resolve(value);
  }
  if (!options['--db'] || !options['--output']) throw new Error('必须显式指定 --db 与 --output，不读取默认用户数据库。');
  return { database: options['--db'], output: options['--output'] };
}

const options = argumentsOf(process.argv.slice(2));
const reportPaths = ['forecast-evaluation.json', 'forecast-evaluation.md'].map(name => path.join(options.output, name));
if (reportPaths.some(filename => fs.existsSync(filename))) throw new Error('输出报告已存在，请使用新的输出目录；不覆盖既有留出结果。');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const databaseHash = hash(fs.readFileSync(options.database));
const directory = __dirname;
const modulePath = path.join(directory, '..', 'outlook.cjs');
const source = fs.readFileSync(path.join(directory, 'outlook-v2-reference.cjs'), 'utf8');
const BASELINE_HASH = 'ff18664a35d0ebc244bc35247f4d7a31c29eb06aad706f751a903bf450fa28e9';
assert.equal(hash(source), BASELINE_HASH, '冻结 v2 参考算法已被修改');
const registrationText = fs.readFileSync(path.join(directory, 'ctf-point-preregistration.json'), 'utf8');
const registration = JSON.parse(registrationText);
const registrationHash = hash(registrationText);
assert.equal(registrationHash, '20b3f5d411d78296e325dd3a36887400b974c87f87e78fd17bc45f6f28fe1ef2', '冻结预注册已被修改');
const FROZEN_SELECTION = 'persistence';
const currentProduction = require(modulePath);

function compileReference(text, label) {
  // 只在内存中编译冻结源码，保持原模块的相对依赖解析；不改写生产文件。
  const instance = new Module(modulePath + '#' + label, module);
  instance.filename = modulePath;
  instance.paths = Module._nodeModulePaths(path.dirname(modulePath));
  instance._compile(text, modulePath);
  return instance.exports;
}
const production = compileReference(source, 'frozen-v2');
const midpointLine = 'const mid = quantile(groups[direction], .5);';
assert.equal(source.split(midpointLine).length, 2, '冻结源码的方向组中位数实现不匹配');
const fullMedian = compileReference(source.replace(midpointLine, 'const mid = quantile(scenarios, .5);'), 'full-median');

function readHistory(filename) {
  // 不实例化会建表、写入设置的生产 Store；SQLite 连接只读，只查询截至固定日期的历史表。
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    database.exec('PRAGMA query_only = ON; BEGIN;');
    const query = database.prepare('SELECT date, price, source FROM history WHERE instrument = ? AND date <= ? ORDER BY date');
    return Object.fromEntries(['ctf', 'gold'].map(instrument => {
      const points = query.all(instrument, registration.dataLimitInclusive);
      assert(points.every(point => /^\d{4}-\d{2}-\d{2}$/.test(point.date) && Number.isFinite(point.price) && point.price > 0),
        '历史包含无效日期或价格');
      return [instrument, points];
    }));
  } finally { database.close(); }
}
const data = readHistory(options.database);
const DAY = 86400000;
const epoch = date => Date.parse(date + 'T00:00:00Z');
const after = (date, horizon) => new Date(epoch(date) + horizon * DAY).toISOString().slice(0, 10);
const sum = values => values.reduce((a, b) => a + b, 0);
const mean = values => values.length ? sum(values) / values.length : null;
const quantile = (values, q) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * q)];
const clamp = (x, low, high) => Math.min(high, Math.max(low, x));
const models = registration.candidates.map(item => item.id);
const HORIZONS = registration.horizonsCalendarDays;
const allPrices = new Map(data.ctf.map(point => [point.date, point.price]));
const minTraining = registration.minimumPriorPricePoints;

function assertProductionMatches(actual, expected, phase, origin, horizon) {
  assert(actual, `生产 auto 缺少配对预测：${phase}/${origin}/${horizon}`);
  for (const key of ['mid', 'low', 'high', 'direction', 'confidence', 'sample']) {
    assert.equal(actual[key], expected[key], `生产 auto 与冻结 persistence 的 ${key} 不一致：${phase}/${origin}/${horizon}`);
  }
  for (const direction of production.DIRECTIONS) {
    assert.equal(actual.probabilities[direction], expected.probabilities[direction],
      `生产 auto 与冻结 persistence 概率不一致：${phase}/${origin}/${horizon}/${direction}`);
  }
  assert.equal(actual.pointMethod, 'persistence');
}
function fixedCentre(id, observations, horizon) {
  const latest = observations.at(-1);
  if (!latest) return 0;
  let slope;
  let phi;
  if (id === 'momentum1_damped' || id === 'momentum3_damped') {
    const intervals = id === 'momentum1_damped' ? 1 : 3;
    const first = observations.at(-1 - intervals);
    if (!first) return 0;
    slope = Math.log(latest.price / first.price) / ((epoch(latest.date) - epoch(first.date)) / DAY);
    if (id === 'momentum1_damped') slope *= 0.5;
    phi = id === 'momentum1_damped' ? 0.6 : 0.7;
  } else if (id === 'trend7_damped') {
    const points = observations.slice(-7);
    if (points.length < 7) return 0;
    const x = points.map(point => (epoch(point.date) - epoch(points[0].date)) / DAY);
    const y = points.map(point => Math.log(point.price));
    const xMean = mean(x), yMean = mean(y);
    slope = sum(x.map((value,index) => (value - xMean) * (y[index] - yMean))) /
      sum(x.map(value => (value - xMean) ** 2));
    phi = 0.8;
  } else throw new Error('未知固定候选');
  return clamp(slope * (1 - phi ** horizon) / (1 - phi), -0.07, 0.07);
}

function historicalReturns(points, horizon) {
  const known = new Map(points.map(point => [point.date, point.price]));
  return points.flatMap(point => {
    const target = known.get(after(point.date, horizon));
    return target ? [{ date: point.date, target: Math.log(target / point.price) }] : [];
  });
}

function simpleForecast(id, prior, anchor, horizon) {
  let residuals;
  let centre = 0;
  if (id === 'persistence') residuals = historicalReturns(prior, horizon).slice(-84).map(item => item.target);
  else {
    const prices = new Map(prior.map(point => [point.date, point.price]));
    const completed = prior.flatMap((point, index) => {
      const targetDate = after(point.date, horizon);
      const targetPrice = prices.get(targetDate);
      if (!targetPrice || index < 6) return [];
      // 每个校准残差也只使用其预测日及之前价格；目标已在当前origin之前结束。
      const forecast = fixedCentre(id, prior.slice(0, index + 1), horizon);
      return [Math.log(targetPrice / point.price) - forecast];
    });
    residuals = completed.slice(-84);
    centre = fixedCentre(id, [...prior, anchor], horizon);
  }
  if (residuals.length < 30) return null;
  const estimate = fullMedian.estimateDirection(centre, residuals, horizon);
  if (id === 'persistence') {
    // 点预测严格价格不变；概率及区间为相同历史误差的校准分布。
    estimate.mid = 0;
    const floor = 0.004 * Math.sqrt(horizon);
    estimate.low = Math.min(estimate.low, -floor);
    estimate.high = Math.max(estimate.high, floor);
  }
  return { ...estimate, mid: anchor.price * Math.exp(estimate.mid), low: anchor.price * Math.exp(estimate.low),
    high: anchor.price * Math.exp(estimate.high), model: id, sample: residuals.length };
}

function forecastsAt(index) {
  const anchor = data.ctf[index];
  const prior = data.ctf.slice(0, index);
  const goldPrior = data.gold.filter(point => point.date < anchor.date);
  if (prior.length < minTraining) throw new Error('训练历史不足120点');
  if (prior.some(point => point.date >= anchor.date) || goldPrior.some(point => point.date >= anchor.date)) {
    throw new Error('发现未来信息进入特征');
  }
  const input = { instrument: 'ctf', priceHistory: prior, goldHistory: goldPrior, quote: anchor,
    macro: {}, today: anchor.date, marketIsClosed: () => false, offsets: HORIZONS };
  const old = production.forecast({ ...input, modelMode: 'history' });
  const median = fullMedian.forecast({ ...input, modelMode: 'history' });
  const price = fullMedian.forecast({ ...input, modelMode: 'price' });
  const auto = currentProduction.forecast(input);
  const predictions = {};
  for (const horizon of HORIZONS) {
    const target = after(anchor.date, horizon);
    const extract = forecast => forecast?.days.find(day => day.date === target && Number.isFinite(day.mid));
    predictions[horizon] = {
      history_old: extract(old), history_median: extract(median), price_median: extract(price), production_auto: extract(auto),
      ...Object.fromEntries(['persistence','momentum1_damped','momentum3_damped','trend7_damped']
        .map(id => [id, simpleForecast(id, prior, anchor, horizon)])),
    };
  }
  return predictions;
}

function evaluate(phase) {
  const rows = [];
  let checkedPairs = 0;
  const origins = data.ctf.map((point, index) => ({ ...point, index })).filter(point =>
    point.index >= minTraining && (phase === 'dev' ? point.date < registration.developmentOriginBefore :
      point.date >= registration.holdoutOriginFrom) && point.date <= registration.dataLimitInclusive);
  for (const origin of origins) {
    const estimates = forecastsAt(origin.index);
    for (const horizon of HORIZONS) {
      const target = after(origin.date, horizon);
      // 开发标签不跨入留出段；留出标签不超出11月20日，也不补齐缺失周日。
      if (phase === 'dev' && target >= registration.developmentOriginBefore) continue;
      if (target > registration.dataLimitInclusive || !allPrices.has(target)) continue;
      if (models.some(id => !estimates[horizon][id])) continue;
      assertProductionMatches(estimates[horizon].production_auto, estimates[horizon].persistence, phase, origin.date, horizon);
      checkedPairs++;
      const actualPrice = allPrices.get(target);
      const actualDirection = production.classifyReturn(Math.log(actualPrice / origin.price));
      for (const id of models) {
        const estimate = estimates[horizon][id];
        const pointDirection = production.classifyReturn(Math.log(estimate.mid / origin.price));
        rows.push({ phase, id, origin: origin.date, target, horizon, trainCount: origin.index,
          anchor: origin.price, actualPrice, actualDirection, prediction: estimate.mid,
          direction: estimate.direction, pointDirection, probabilities: estimate.probabilities,
          low: estimate.low, high: estimate.high, model: estimate.model, sample: estimate.sample,
          absoluteError: Math.abs(estimate.mid - actualPrice), error: estimate.mid - actualPrice,
          hit: Number(estimate.direction === actualDirection), pointHit: Number(pointDirection === actualDirection),
          brier: sum(production.DIRECTIONS.map(direction => (estimate.probabilities[direction] - Number(direction === actualDirection)) ** 2)),
          covered: Number(actualPrice >= estimate.low && actualPrice <= estimate.high), width: estimate.high - estimate.low,
        });
      }
    }
  }
  const summary = Object.fromEntries(models.map(id => [id, Object.fromEntries(HORIZONS.map(horizon => {
    const group = rows.filter(row => row.id === id && row.horizon === horizon);
    return [horizon, { n: group.length, mae: mean(group.map(row => row.absoluteError)),
      rmse: Math.sqrt(mean(group.map(row => row.error ** 2))), bias: mean(group.map(row => row.error)),
      medianAbsoluteError: quantile(group.map(row => row.absoluteError), 0.5),
      directionAccuracy: mean(group.map(row => row.hit)), pointDirectionAccuracy: mean(group.map(row => row.pointHit)),
      brier: mean(group.map(row => row.brier)), coverage80: mean(group.map(row => row.covered)),
      meanWidth: mean(group.map(row => row.width)), firstOrigin: group[0]?.origin, lastOrigin: group.at(-1)?.origin,
    }];
  }))]));
  return { phase, originCount: origins.length, checkedPairs, summary, rows };
}


function randomGenerator(seed) {
  let state = seed >>> 0;
  // 固定整数种子的 Mulberry32，保证不同平台得到相同的块抽样索引。
  return () => {
    let value = state += 0x6D2B79F5;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function publicSummary(result) {
  const summaries = Object.fromEntries(models.map(id => [id, {}]));
  for (const horizon of HORIZONS) {
    const groups = Object.fromEntries(models.map(id => [id,
      result.rows.filter(row => row.id === id && row.horizon === horizon)]));
    const n = groups.history_old.length;
    assert(n > 0, `缺少 ${result.phase}/${horizon} 日配对样本`);
    const bootstrap = Object.fromEntries(models.map(id => [id, { mae: [], improvement: [] }]));
    const random = randomGenerator(20261120 + horizon);
    for (let replicate = 0; replicate < 5000; replicate++) {
      const weights = new Uint16Array(n);
      for (let sampled = 0; sampled < n;) {
        const start = Math.floor(random() * n);
        for (let offset = 0; offset < 7 && sampled < n; offset++, sampled++) weights[(start + offset) % n]++;
      }
      const errors = Object.fromEntries(models.map(id => [id,
        sum(groups[id].map((row, index) => row.absoluteError * weights[index])) / n]));
      for (const id of models) {
        bootstrap[id].mae.push(errors[id]);
        bootstrap[id].improvement.push(errors.history_old - errors[id]);
      }
    }
    for (const id of models) {
      const metrics = result.summary[id][horizon];
      summaries[id][horizon] = {
        n: metrics.n, mae: metrics.mae, rmse: metrics.rmse,
        directionAccuracy: metrics.directionAccuracy, pointDirectionAccuracy: metrics.pointDirectionAccuracy,
        brier: metrics.brier, coverage80: metrics.coverage80,
        maeCI95: [.025, .975].map(q => quantile(bootstrap[id].mae, q)),
        maeImprovementVsOld: result.summary.history_old[horizon].mae - metrics.mae,
        maeImprovementVsOldCI95: [.025, .975].map(q => quantile(bootstrap[id].improvement, q)),
      };
    }
  }
  return { eligibleOriginCount: result.originCount, productionAutoPairsChecked: result.checkedPairs,
    evaluatedOriginRange: [result.rows.map(row => row.origin).sort()[0], result.rows.map(row => row.origin).sort().at(-1)],
    byCandidate: summaries };
}

const names = {
  history_old: '旧 history（方向组中位）', persistence: '价格不变', history_median: 'history 全分布中位',
  price_median: '既有 price＋全分布中位', momentum1_damped: '1 日半强度阻尼动量',
  momentum3_damped: '3 间隔阻尼动量', trend7_damped: '7 点 OLS 阻尼趋势',
};

function markdown(report) {
  const selected = report.holdout.byCandidate.persistence[1];
  const old = report.holdout.byCandidate.history_old[1];
  const interval = selected.maeImprovementVsOldCI95;
  const lines = [
    '# 周大福点价格冻结回测', '',
    `开发段按预先规定的 1 日 MAE 最低规则选择 **persistence（价格不变）**，并在查看留出结果前冻结。留出次日 ${selected.n} 项预测中，MAE 从旧 history 的 **${old.mae.toFixed(3)} 降至 ${selected.mae.toFixed(3)} 元/克**。`, '',
    `改善估计为 ${(old.mae - selected.mae).toFixed(3)} 元/克，95% 时间块 bootstrap 区间为 [${interval.map(value => value.toFixed(3)).join(', ')}]，跨过 0，**不具有统计显著性，不能承诺未来稳定更准**。本实验不是当时 10:00 已发布预测的实盘回放，也没有使用 11/21 实际价格，不能称用户 11/21 那次预测更准。`, '',
    '使用固定七候选；不根据留出集或已知个例增加模型、改参数。开发 origin 与目标均早于 2026-09-01；留出 origin 自 2026-09-01 起，目标不晚于 2026-11-20。每次至少使用 120 个此前 CTF 价格点，另以当日历史牌价代理已知 anchor。gold 只允许使用 origin 前日线；目标日期缺失时不填补。历史表没有逐日抓取时间与修订版本，这是日期截断的历史价格回测。', '',
    '价格不变仅描述点估计，其方向概率及区间根据历史收益分布估计，方向概率仍未完成实盘校准。方向命中取概率最大的类别，涨跌阈值为 ±0.2%；另在 JSON 中记录点价格隐含方向命中。三分类 Brier 为概率平方误差之和，越小越好。覆盖率对应历史 10/90 分位区间及原最低半宽。', '',
  ];
  for (const [phase, title] of [['development', '开发集'], ['holdout', '留出集']]) {
    lines.push('## ' + title, '',
      '| 候选 | 日数 | N | MAE | RMSE | 方向命中 | Brier ↓ | 80% 覆盖 | MAE 95% 块区间 |',
      '|---|---:|---:|---:|---:|---:|---:|---:|---|');
    for (const id of models) for (const horizon of HORIZONS) {
      const item = report[phase].byCandidate[id][horizon];
      lines.push(`| ${names[id]} | ${horizon} | ${item.n} | ${item.mae.toFixed(3)} | ${item.rmse.toFixed(3)} | ${(100 * item.directionAccuracy).toFixed(1)}% | ${item.brier.toFixed(3)} | ${(100 * item.coverage80).toFixed(1)}% | [${item.maeCI95.map(value => value.toFixed(3)).join(', ')}] |`);
    }
    lines.push('');
  }
  lines.push('## 复现与边界', '',
    `生产默认 auto 的 CTF 点价格、三类概率、方向、可信度、样本数及区间，已与冻结 persistence 在开发 ${report.development.productionAutoPairsChecked} 对、留出 ${report.holdout.productionAutoPairsChecked} 对上逐值严格相等检查通过。此项只验证实现对应关系，不是新增预测候选。`, '',
    '所有候选与旧 history 的配对 MAE 改善及其 95% 区间见 [完整汇总 JSON](forecast-evaluation.json)。区间采用 7 个连续 origin 的循环块、5000 次抽样、固定种子；未假设相邻多日预测彼此独立。', '',
    '```sh',
    'node shared/gold-core/scripts/evaluate-point-forecast.cjs --db /path/to/readonly-snapshot.sqlite --output /path/to/new-report-directory',
    '```', '',
    '工具仅以只读 SQLite 连接查询 history，不隐式读取用户目录，并拒绝覆盖旧报告；输出仅有汇总结果，不导出逐日行情、基准价或个别日期的预测。固定候选见 [ctf-point-preregistration.json](../shared/gold-core/scripts/ctf-point-preregistration.json)。旧参考算法保留原 `shared/gold-core/outlook.cjs` / `MODEL_VERSION 2.0.0` 源码，见 [outlook-v2-reference.cjs](../shared/gold-core/scripts/outlook-v2-reference.cjs)。', '',
    '按时间推进训练与评估的方法说明参见 *Forecasting: Principles and Practice*, [Time series cross-validation](https://otexts.com/fpp3/toolbox.html#time-series-cross-validation)。', '',
    `数据范围：CTF ${report.data.history.ctf.count} 点，${report.data.history.ctf.firstDate}～${report.data.history.ctf.lastDate}；gold ${report.data.history.gold.count} 点，${report.data.history.gold.firstDate}～${report.data.history.gold.lastDate}。`, '',
    `数据库副本 SHA256：\`${report.data.databaseSha256}\`。`, '',
    `截断历史 SHA256：\`${report.data.historySha256}\`。`, '',
    `冻结 v2 参考算法 SHA256：\`${report.reference.sha256}\`。`, '',
    `预注册 SHA256：\`${report.protocolSha256}\`。`, '',
  );
  return lines.join('\n');
}

// 只复验已完成实验的固定选择；开发阶段不符合原规则时停止，不在新留出集上重新选模。
const development = evaluate('dev');
const developmentWinner = models.reduce((best, id) =>
  development.summary[id][1].mae < development.summary[best][1].mae ? id : best, models[0]);
assert.equal(developmentWinner, FROZEN_SELECTION, '当前输入的开发结果不再符合冻结选择；停止复验，不重新选参');
const holdout = evaluate('holdout');
const report = {
  schemaVersion: 1,
  reference: { originalName: 'shared/gold-core/outlook.cjs', sourceCommit: '30e6a49', modelVersion: '2.0.0', sha256: BASELINE_HASH },
  production: { modelVersion: currentProduction.MODEL_VERSION, sha256: hash(fs.readFileSync(modulePath)),
    ctfAutoMatchesFrozenPersistence: true, strictEquality: true },
  protocol: registration,
  protocolSha256: registrationHash,
  selection: { id: FROZEN_SELECTION, chosenBeforeHoldout: true, developmentRuleConfirmed: true,
    rule: registration.selectionCriterion, tieBreak: '相等时按预注册候选顺序保留较简单的在先候选，不参考留出结果' },
  data: { databaseSha256: databaseHash, historySha256: hash(JSON.stringify(data)),
    history: Object.fromEntries(Object.entries(data).map(([id, points]) => [id,
      { count: points.length, firstDate: points[0]?.date, lastDate: points.at(-1)?.date }])),
    historicalQuoteProxy: true, trueTenAMReplay: false, excludes20261121Actual: true },
  bootstrap: { type: 'circular-moving-block', blockOrigins: 7, replicates: 5000,
    randomGenerator: 'Mulberry32', seed: '20261120 + horizon', confidence: 0.95,
    pairedImprovementSign: '旧 history MAE 减当前候选 MAE；正值表示改善，区间跨零不能视为显著' },
  development: publicSummary(development), holdout: publicSummary(holdout),
};
assert.equal(hash(fs.readFileSync(options.database)), databaseHash, '复验期间数据库文件哈希变化，拒绝发布报告');
fs.mkdirSync(options.output, { recursive: true });
fs.writeFileSync(reportPaths[0], JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
fs.writeFileSync(reportPaths[1], markdown(report), { flag: 'wx' });
console.log(`冻结候选复验通过；生产 auto 与 persistence 严格配对相等：开发 ${development.checkedPairs}，留出 ${holdout.checkedPairs}。`);
console.log(`仅输出汇总报告：${reportPaths.map(filename => path.basename(filename)).join('、')}`);
