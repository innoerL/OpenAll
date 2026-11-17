function createDiffCore() {
  function splitLines(text) {
    return text === '' ? [] : text.replace(/\r\n?/g, '\n').split('\n');
  }

  function naturalSortLines(text) {
    const normalized = String(text).replace(/\r\n?/g, '\n');
    if (!normalized) return '';
    // 末尾换行是文档结束标记，不能作为空行参与排序；其余空行与重复行全部保留。
    const trailing = normalized.endsWith('\n');
    const lines = (trailing ? normalized.slice(0, -1) : normalized).split('\n');
    const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'variant' });
    // 目标 Safari/Chromium 均保证稳定排序，相等数字键保持原先顺序。
    lines.sort(collator.compare);
    return lines.join('\n') + (trailing ? '\n' : '');
  }

  function align(leftText, rightText, ignoreTrailingSpace = false) {
    return alignLines(splitLines(leftText), splitLines(rightText), ignoreTrailingSpace);
  }

  function alignLines(left, right, ignoreTrailingSpace) {
    const equals = (a, b) => ignoreTrailingSpace ? a.trimEnd() === b.trimEnd() : a === b;
    const n = left.length;
    const m = right.length;
    // 共同前后缀直接对齐；长文档里新增一行也能保留后续段落的位置。
    let prefix = 0, suffix = 0;
    while (prefix < Math.min(n, m) && equals(left[prefix], right[prefix])) prefix++;
    while (suffix < Math.min(n, m) - prefix && equals(left[n - suffix - 1], right[m - suffix - 1])) suffix++;
    if (prefix || suffix) {
      const middle = alignLines(left.slice(prefix, n - suffix), right.slice(prefix, m - suffix), ignoreTrailingSpace);
      const rows = [];
      for (let i = 0; i < prefix; i++) rows.push(makeRow(left, right, i, i, equals));
      for (const row of middle.rows) rows.push({ ...row, leftLine: row.leftLine === null ? null : row.leftLine + prefix,
        rightLine: row.rightLine === null ? null : row.rightLine + prefix });
      for (let i = suffix; i > 0; i--) rows.push(makeRow(left, right, n - i, m - i, equals));
      return { rows, limited: middle.limited };
    }
    if (n * m > 4000000) {
      const rows = [];
      for (let i = 0; i < Math.max(n, m); i++) {
        rows.push(makeRow(left, right, i < n ? i : null, i < m ? i : null, equals));
      }
      return { rows, limited: true };
    }
    const width = m + 1;
    // 矩阵只比较整数，避免在每个格子里反复扫描超长行和去除尾部空格。
    const identifiers = new Map();
    const intern = line => { const key = ignoreTrailingSpace ? line.trimEnd() : line;
      if (!identifiers.has(key)) identifiers.set(key, identifiers.size); return identifiers.get(key); };
    const leftIDs = left.map(intern), rightIDs = right.map(intern);
    const dp = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * width + j] = leftIDs[i] === rightIDs[j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
      }
    }
    const ops = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (leftIDs[i] === rightIDs[j]) { ops.push({ type: 'equal', li: i++, ri: j++ }); }
      else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) { ops.push({ type: 'remove', li: i++ }); }
      else { ops.push({ type: 'add', ri: j++ }); }
    }
    while (i < n) ops.push({ type: 'remove', li: i++ });
    while (j < m) ops.push({ type: 'add', ri: j++ });
    const rows = [];
    let k = 0;
    while (k < ops.length) {
      if (ops[k].type === 'equal') {
        rows.push(makeRow(left, right, ops[k].li, ops[k].ri, equals));
        k++;
        continue;
      }
      const removed = [];
      const added = [];
      while (k < ops.length && ops[k].type !== 'equal') {
        if (ops[k].type === 'remove') removed.push(ops[k].li);
        else added.push(ops[k].ri);
        k++;
      }
      for (let x = 0; x < Math.max(removed.length, added.length); x++) {
        rows.push(makeRow(left, right, removed[x] ?? null, added[x] ?? null, equals));
      }
    }
    return { rows, limited: false };
  }

  function makeRow(left, right, li, ri, equals) {
    const a = li === null ? null : left[li];
    const b = ri === null ? null : right[ri];
    const type = a === null ? 'added' : b === null ? 'removed' : equals(a, b) ? 'equal' : 'changed';
    return { type, leftLine: li === null ? null : li + 1, rightLine: ri === null ? null : ri + 1, left: a, right: b };
  }

  function charMarks(a, b) {
    const left = Array.from(a);
    const right = Array.from(b);
    const markedLeft = Array(left.length).fill(true);
    const markedRight = Array(right.length).fill(true);
    const pairs = [];
    let prefix = 0, suffix = 0;
    while (prefix < Math.min(left.length, right.length) && left[prefix] === right[prefix]) { pairs.push([prefix, prefix]); prefix++; }
    while (suffix < Math.min(left.length, right.length) - prefix && left[left.length - suffix - 1] === right[right.length - suffix - 1]) suffix++;
    const n = left.length - prefix - suffix, m = right.length - prefix - suffix;
    // 先剥离公共边界；长 JSON 行中仅一处值变化也能维持字符级精度。
    if (n * m <= 150000) {
      const width = m + 1;
      const dp = new Uint32Array((n + 1) * width);
      for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
          dp[i * width + j] = left[prefix + i] === right[prefix + j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
        }
      }
      let i = 0, j = 0;
      while (i < n && j < m) {
        if (left[prefix + i] === right[prefix + j]) { pairs.push([prefix + i++, prefix + j++]); }
        else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) i++;
        else j++;
      }
    } else {
      // 长行中的少量、分散修改用有界 Myers 定位，不能把中间相同片段整段染色。
      // 距离及扫描预算均有上限，内容完全不同时仍可快速退回连续变化块。
      const maximum = 64, offset = maximum + 1, trace = [], vector = new Int32Array(maximum * 2 + 3).fill(-1);
      vector[offset + 1] = 0;
      let budget = 250000, found = false;
      outer: for (let distance = 0; distance <= maximum; distance++) {
        trace.push(vector.slice());
        for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
          let x = diagonal === -distance || diagonal !== distance && vector[offset + diagonal - 1] < vector[offset + diagonal + 1]
            ? vector[offset + diagonal + 1] : vector[offset + diagonal - 1] + 1;
          let y = x - diagonal;
          while (x < n && y < m && left[prefix + x] === right[prefix + y]) { x++; y++; if (--budget < 0) break outer; }
          vector[offset + diagonal] = x;
          if (x >= n && y >= m) { found = true; break outer; }
        }
      }
      if (found) {
        const matches = []; let x = n, y = m;
        for (let distance = trace.length - 1; distance >= 0; distance--) {
          const previous = trace[distance], diagonal = x - y;
          const previousDiagonal = diagonal === -distance || diagonal !== distance && previous[offset + diagonal - 1] < previous[offset + diagonal + 1] ? diagonal + 1 : diagonal - 1;
          const previousX = previous[offset + previousDiagonal], previousY = previousX - previousDiagonal;
          while (x > previousX && y > previousY) { matches.push([prefix + x - 1, prefix + y - 1]); x--; y--; }
          x = previousX; y = previousY;
        }
        for (let i = matches.length - 1; i >= 0; i--) pairs.push(matches[i]);
      }
    }
    for (let i = suffix; i > 0; i--) pairs.push([left.length - i, right.length - i]);
    const gapsLeft = [], gapsRight = [];
    let previousLeft = -1, previousRight = -1;
    for (const [i, j] of [...pairs, [left.length, right.length]]) {
      if (i === previousLeft + 1 && j > previousRight + 1) gapsLeft.push(i);
      if (j === previousRight + 1 && i > previousLeft + 1) gapsRight.push(j);
      if (i < left.length) { markedLeft[i] = false; markedRight[j] = false; }
      previousLeft = i; previousRight = j;
    }
    return { left, right, markedLeft, markedRight, gapsLeft, gapsRight };
  }

  return { align, charMarks, splitLines, naturalSortLines };
}
const DiffCore = createDiffCore();
// 独立工作线程只传回行号和类型，不把两份全文再次复制回界面线程。
DiffCore.workerSource = `const core = (${createDiffCore.toString()})(); onmessage = event => {
  try { const started = performance.now();
    if (event.data.action === 'sort') { postMessage({ text: core.naturalSortLines(event.data.text), elapsed: performance.now() - started }); return; }
    const result = core.align(...event.data.texts, event.data.ignore);
    const encoded = new Int32Array(result.rows.length * 3);
    const types = ['equal', 'changed', 'added', 'removed'];
    for (let i = 0; i < result.rows.length; i++) { const row = result.rows[i];
      encoded[i * 3] = types.indexOf(row.type); encoded[i * 3 + 1] = row.leftLine || 0; encoded[i * 3 + 2] = row.rightLine || 0; }
    postMessage({ encoded, limited: result.limited, elapsed: performance.now() - started }, [encoded.buffer]);
  } catch (error) { postMessage({ error: String(error) }); }
};`;

if (typeof module !== 'undefined') module.exports = DiffCore;
