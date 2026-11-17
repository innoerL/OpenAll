const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const DiffCore = require('../assets/editor-diff-core');

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'variant' });

function normalize(text) {
  return text.replace(/\r\n?/g, '\n');
}

function contentLines(text) {
  if (text === '') return [];
  // 尾换行是文档状态，不能混入待排序的空白行。
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
}

function frequencies(lines) {
  const counts = new Map();
  for (const line of lines) counts.set(line, (counts.get(line) || 0) + 1);
  return counts;
}

function assertSort(input, expected, label) {
  const normalized = normalize(input);
  const actual = DiffCore.naturalSortLines(input);
  assert.equal(typeof actual, 'string', `${label}：返回字符串`);
  if (expected !== undefined) assert.equal(actual, expected, `${label}：排序结果`);
  assert.equal(actual.includes('\r'), false, `${label}：统一使用 LF`);
  assert.equal(actual.endsWith('\n'), normalized.endsWith('\n'), `${label}：尾换行状态`);
  assert.deepEqual(frequencies(contentLines(actual)), frequencies(contentLines(normalized)),
    `${label}：保留每一行及其重复次数`);
  const lines = contentLines(actual);
  for (let index = 1; index < lines.length; index++) {
    assert.ok(collator.compare(lines[index - 1], lines[index]) <= 0, `${label}：第 ${index + 1} 行顺序`);
  }
  assert.equal(DiffCore.naturalSortLines(actual), actual, `${label}：重复排序保持不变`);
  return actual;
}

assert.equal(typeof DiffCore.naturalSortLines, 'function', 'DiffCore 应公开自然行排序 API');

const samples = [
  ['item10\nitem2\nitem1', 'item1\nitem2\nitem10', '英文及数字'],
  ['条目10\n条目2\n条目1', '条目1\n条目2\n条目10', '中文及数字'],
  ['100\n2\n10\n1', '1\n2\n10\n100', '纯数字'],
  ['item10\nitem2\nitem2\nitem1\nitem10', 'item1\nitem2\nitem2\nitem10\nitem10', '重复行'],
  ['item10\n\nitem2\n\nitem1', '\n\nitem1\nitem2\nitem10', '无尾换行的空白行'],
  ['item10\n\nitem2\n\n', '\n\nitem2\nitem10\n', '尾部连续空白行'],
  ['item10\nitem2\n', 'item2\nitem10\n', '保留尾换行'],
  ['item10\r\n\r\nitem2\r\n', '\nitem2\nitem10\n', 'CRLF 规范化'],
  ['', '', '空文档'],
  ['\n', '\n', '单空白行和尾换行'],
  ['\n\n', '\n\n', '多个空白行'],
  ['单行 item10🙂', '单行 item10🙂', '单行文档'],
  ['单行 item10🙂\n', '单行 item10🙂\n', '单行及尾换行'],
];
for (const [input, expected, label] of samples) assertSort(input, expected, label);

// 依照编辑器约定的中文区域设置判断中英文、大小写及重音。
const mixedLines = ['条目10', 'item10', 'A2', 'é2', '条目2', 'a2', 'E2', 'item2', 'e2', 'A10', 'a10', '🙂10', '🙂2'];
const mixedExpected = mixedLines.map((line, index) => ({ line, index }))
  .sort((left, right) => collator.compare(left.line, right.line) || left.index - right.index)
  .map(entry => entry.line).join('\n');
assert.notEqual(collator.compare('A2', 'a2'), 0, 'variant 必须保留大小写区别');
assertSort(mixedLines.join('\n'), mixedExpected, '中英文、大小写、重音和 emoji 混合排序');

const stableLines = ['item10', 'item02', 'item2', 'item002', 'item1', 'item0002'];
assert.equal(collator.compare('item02', 'item2'), 0, '前导零样例属于相同比较键');
assertSort(stableLines.join('\n'), 'item1\nitem02\nitem2\nitem002\nitem0002\nitem10', '相同比较键稳定排序');
assertSort('é2\ne\u03012\né02', 'é2\ne\u03012\né02', '规范等价字符与前导零保留原文和顺序');
assertSort('item10  \nitem2\t\n  item1\n \nitem2 ', undefined, '空格和制表符逐字保留');

let preciseMarkCases = 0;
function assertMarks(left, right, expectedLeft, expectedRight, label) {
  const marks = DiffCore.charMarks(left, right);
  assert.deepEqual(marks.left, Array.from(left), `${label}：左侧按 Unicode 码点分解`);
  assert.deepEqual(marks.right, Array.from(right), `${label}：右侧按 Unicode 码点分解`);
  assert.deepEqual(marks.markedLeft, marks.left.map((_, index) => expectedLeft.includes(index)),
    `${label}：左侧仅标记实际变化字符`);
  assert.deepEqual(marks.markedRight, marks.right.map((_, index) => expectedRight.includes(index)),
    `${label}：右侧仅标记实际变化字符`);
  preciseMarkCases++;
  return marks;
}

function assertGaps(marks, expectedLeft, expectedRight, label) {
  assert.deepEqual(marks.gapsLeft, expectedLeft, `${label}：左侧空位位于正确的码点边界`);
  assert.deepEqual(marks.gapsRight, expectedRight, `${label}：右侧空位位于正确的码点边界`);
}

assertMarks('abcdef', 'abXdef', [2], [2], '单字符替换');
assertMarks('abc', 'abXc', [], [2], '单字符插入');
assertMarks('abXc', 'abc', [2], [], '单字符删除');
assertMarks('{"count":12}', '{"count":13}', [10], [10], 'JSON 值变化');
assertMarks('你好世界', '你好世间', [3], [3], '中文变化');
assertMarks('A😀B', 'A😃B', [1], [1], 'emoji 替换');
assertMarks('A😀B', 'A😀🙂B', [], [2], 'emoji 插入');
assertMarks('a b', 'a  b', [], [2], '空格插入');
assertMarks('value ', 'value', [5], [], '尾空格删除');
assertMarks('a\tb', 'a b', [1], [1], '制表符与空格区别');
assertMarks('相同🙂 ', '相同🙂 ', [], [], '相同文本');
assertMarks('', '', [], [], '空文本');
assertMarks('', '🙂', [], [0], '空文本新增 emoji');
assertMarks('a'.repeat(512) + 'x' + 'b'.repeat(512), 'a'.repeat(512) + 'y' + 'b'.repeat(512),
  [512], [512], '长行快速路径中的单字符变化');

const longLine = 'A' + 'x'.repeat(10000) + 'B';
assertGaps(assertMarks(longLine, 'C' + 'x'.repeat(10000) + 'D', [0, 10001], [0, 10001],
  '长行两端替换只标记两端'), [], [], '两端替换不产生空位');

for (const position of [0, 5001, 10002]) {
  const inserted = longLine.slice(0, position) + '🙂' + longLine.slice(position);
  assertGaps(assertMarks(longLine, inserted, [], [position], `长行在 ${position} 处插入 emoji`),
    [position], [], `长行插入 ${position}`);
  assertGaps(assertMarks(inserted, longLine, [position], [], `长行在 ${position} 处删除 emoji`),
    [], [position], `长行删除 ${position}`);
}

// 两个分散插入点之间超过旧矩阵阈值，确保 Myers 回溯仍给出精确码点和空位。
const boundaryInsertions = '🙂' + longLine + '中';
assertGaps(assertMarks(longLine, boundaryInsertions, [], [0, 10003], '长行首尾同时插入'),
  [0, 10002], [], '长行首尾插入');
assertGaps(assertMarks(boundaryInsertions, longLine, [0, 10003], [], '长行首尾同时删除'),
  [], [0, 10002], '长行首尾删除');
const middleInsertions = 'A' + 'x'.repeat(2500) + '🙂' + 'x'.repeat(5000) + '中' + 'x'.repeat(2500) + 'B';
assertGaps(assertMarks(longLine, middleInsertions, [], [2501, 7502], '长行中间两处插入'),
  [2501, 7501], [], '长行中间插入');
assertGaps(assertMarks(middleInsertions, longLine, [2501, 7502], [], '长行中间两处删除'),
  [], [2501, 7501], '长行中间删除');

// 固定种子使重复字符的随机编辑可复现，同时覆盖中文、空格和双 UTF-16 单元 emoji。
let randomState = 0x51a7c0de;
function randomIndex(limit) {
  randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
  return randomState % limit;
}

const randomRounds = 64;
const repeatedCharacters = ['a', 'a', 'b', 'b', '中', '🙂', ' '];
for (let round = 0; round < randomRounds; round++) {
  const original = Array.from({ length: 2048 }, () => repeatedCharacters[randomIndex(repeatedCharacters.length)]);
  const edited = original.slice();
  let editCount = 0;
  for (let operation = 0; operation < 8; operation++) {
    if (operation % 2 === 0) {
      edited.splice(randomIndex(edited.length + 1), 0, repeatedCharacters[randomIndex(repeatedCharacters.length)]);
    } else {
      edited.splice(randomIndex(edited.length), 1);
    }
    editCount++;
  }
  for (const [left, right] of [[original, edited], [edited, original]]) {
    const marks = DiffCore.charMarks(left.join(''), right.join(''));
    const label = `重复字符随机编辑第 ${round + 1} 组`;
    assert.deepEqual(marks.left, left, `${label}：左侧码点保真`);
    assert.deepEqual(marks.right, right, `${label}：右侧码点保真`);
    assert.equal(marks.markedLeft.length, left.length, `${label}：左侧标记长度`);
    assert.equal(marks.markedRight.length, right.length, `${label}：右侧标记长度`);
    assert.equal(left.filter((_, index) => !marks.markedLeft[index]).join(''),
      right.filter((_, index) => !marks.markedRight[index]).join(''), `${label}：未标记字符连接后必须相同`);
    assert.ok(marks.markedLeft.filter(Boolean).length + marks.markedRight.filter(Boolean).length <= editCount,
      `${label}：少量编辑不能扩散标记共同片段`);
    for (const [gaps, length] of [[marks.gapsLeft, left.length], [marks.gapsRight, right.length]]) {
      assert.ok(gaps.every((position, index) => Number.isInteger(position) && position >= 0 && position <= length &&
        (index === 0 || gaps[index - 1] < position)), `${label}：空位是有序且有效的码点边界`);
    }
  }
}

// 压力样例包含重复行及多字节字符，大小超过 5 MiB；计时仅供观测，不绑定具体机器性能。
const stressLines = Array.from({ length: 65536 }, (_, index) =>
  `item${(65536 - index) % 20000}\t${'中文🙂'.repeat(7)}`);
stressLines.splice(100, 0, '', '');
const stressInput = stressLines.join('\n') + '\n';
const stressBytes = Buffer.byteLength(stressInput, 'utf8');
assert.ok(stressBytes >= 5 * 1024 * 1024, '压力文本至少为 5 MiB');
const started = performance.now();
assertSort(stressInput, undefined, '5 MiB 压力排序');
const elapsed = Math.round(performance.now() - started);
console.log(`自然排序与字符差异检查通过：${samples.length + 4} 组排序、${preciseMarkCases} 组精确标记、${randomRounds} 组双向随机编辑；压力 ${stressBytes} 字节，完整校验 ${elapsed} ms`);
