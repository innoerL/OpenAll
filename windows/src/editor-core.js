'use strict';
const YAML = require('yaml');
const MAX_LENGTH = 10_000_000, MAX_LINES = 200_000;
function guardSize(text) {
  if (text.length > MAX_LENGTH || new TextEncoder().encode(text).length > 20_000_000) throw Error('内容超过 20 MB 或 1000 万字符，已保留原文');
  let lines = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10 && ++lines > MAX_LINES) throw Error('内容超过 20 万行，已保留原文');
}
// 保留数字原文、键顺序和重复键，不用 JSON.parse / stringify 往返破坏大整数。
function parseJSON(source) {
  guardSize(source);
  let at = 0, line = 1;
  const regions = [];
  const fail = message => { const error = Error(`${message}（第 ${line} 行，位置 ${at + 1}）`); error.offset = at; throw error; };
  const whitespace = () => { while (at < source.length && /[ \t\r\n]/.test(source[at])) { if (source[at] === '\n') line++; at++; } };
  function string() {
    const start = at++;
    while (at < source.length) {
      const c = source[at++];
      if (c === '"') return source.slice(start, at);
      if (c.charCodeAt(0) < 32) fail('字符串包含未转义的控制字符');
      if (c === '\\') {
        const escape = source[at++];
        if (escape === 'u') { if (!/^[\da-fA-F]{4}$/.test(source.slice(at, at + 4))) fail('Unicode 转义需要四位十六进制数字'); at += 4; }
        else if (!escape || !'"\\/bfnrt'.includes(escape)) fail('无效的字符串转义');
      }
    }
    fail('字符串缺少结束引号');
  }
  function value(depth) {
    if (depth > 512) fail('JSON 嵌套超过 512 层');
    whitespace();
    const start = at, startLine = line, c = source[at];
    if (c === '"') return { kind: 'scalar', raw: string() };
    if (c === '{' || c === '[') {
      const object = c === '{', close = object ? '}' : ']';
      at++; whitespace();
      const entries = [];
      if (source[at] !== close) {
        for (;;) {
          whitespace();
          let key;
          if (object) { if (source[at] !== '"') fail('对象键必须使用双引号'); key = string(); whitespace(); if (source[at++] !== ':') fail('对象键后缺少冒号'); }
          const child = value(depth + 1);
          entries.push(object ? { key, value: child } : child);
          whitespace();
          if (source[at] === close) break;
          if (source[at++] !== ',') fail('元素后缺少逗号或结束括号');
        }
      }
      at++;
      if (line > startLine) regions.push({ from: start + 1, to: at - 1, startLine, endLine: line });
      return { kind: object ? 'object' : 'array', entries };
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(source.slice(at));
    if (!token) fail('无效的 JSON 值');
    at += token[0].length;
    return { kind: 'scalar', raw: token[0] };
  }
  const node = value(0); whitespace();
  if (at !== source.length) fail('JSON 值之后存在多余内容');
  regions.sort((a, b) => a.from - b.from);
  return { node, regions, lineCount: line };
}
function formatJSON(source, mode = 'format') {
  source = String(source); guardSize(source);
  if (mode === 'escape') { const text = JSON.stringify(source); guardSize(text); return text; }
  if (mode === 'unescape') { const raw = source.trim(), value = JSON.parse(raw.startsWith('"') ? raw : '"' + raw + '"'); if (typeof value !== 'string') throw Error('输入不是 JSON 转义字符串'); guardSize(value); return value; }
  const { node } = parseJSON(source);
  if (mode === 'validate') return source;
  const compact = mode === 'compact', sort = mode === 'sort';
  const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'variant' });
  const chunks = []; let length = 0, lines = 1;
  const append = text => { length += text.length; if (length > MAX_LENGTH) throw Error('格式化后超过 1000 万字符，已保留原文'); chunks.push(text); };
  const newline = depth => { if (compact) return; if (++lines > MAX_LINES) throw Error('格式化后超过 20 万行，已保留原文'); append('\n' + '  '.repeat(depth)); };
  function emit(value, depth) {
    if (value.kind === 'scalar') { append(value.raw); return; }
    const object = value.kind === 'object';
    const entries = sort && object ? [...value.entries].sort((a, b) => collator.compare(JSON.parse(a.key), JSON.parse(b.key))) : value.entries;
    append(object ? '{' : '[');
    for (let index = 0; index < entries.length; index++) {
      if (index) append(','); newline(depth + 1);
      const entry = entries[index];
      if (object) { append(entry.key); append(compact ? ':' : ': '); emit(entry.value, depth + 1); }
      else emit(entry, depth + 1);
    }
    if (entries.length) newline(depth);
    append(object ? '}' : ']');
  }
  emit(node, 0);
  const output = chunks.join(''); guardSize(output); return output;
}
function findMatches(source, query, caseSensitive = false) {
  const matches = []; let limited = false;
  if (!query) return { matches, limited };
  const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'gu' : 'giu');
  for (const match of source.matchAll(expression)) {
    if (matches.length === 10000) { limited = true; break; }
    matches.push({ from: match.index, to: match.index + match[0].length });
  }
  return { matches, limited };
}
function formatConfiguration(input) {
  guardSize(input);
  const lines = input.replace(/\r\n?/g, '\n').split('\n');
  const significant = lines.map(x => x.trim()).filter(x => x && !/^[#!]/.test(x));
  if (!significant.length) throw Error('请输入 YAML 或 Properties 内容');
  function separator(line) { let escaped = false; for (let i = 0; i < line.length; i++) { if (escaped) { escaped = false; continue; } if (line[i] === '\\') { escaped = true; continue; } if ('=:'.includes(line[i])) return i; } return -1; }
  if (significant.every(line => line[separator(line)] === '=')) {
    const output = lines.map(raw => {
      const line = raw.replace(/^[ \t\f]+/, '');
      if (!line || /^[#!]/.test(line)) return raw;
      if ((/\\*$/.exec(line)[0].length % 2) || separator(line) < 1) throw Error('含续行或无效键的 Properties 不自动改写');
      const index = separator(line), left = line.slice(0, index);
      let escaped = false, spaces = false, key = '';
      for (const c of left) {
        if (escaped) { if (spaces) throw Error('无效的 Properties 键'); key += c; escaped = false; continue; }
        if (/[ \t\f]/.test(c)) { spaces = true; continue; }
        if (spaces) throw Error('Properties 键中的空格需要转义'); key += c; if (c === '\\') escaped = true;
      }
      if (!key || escaped) throw Error('无效的 Properties 键');
      return key + '=' + line.slice(index + 1).replace(/^[ \t\f]+/, '');
    }).join('\n');
    return { text: output, kind: 'Properties · 保留值、原顺序与注释' };
  }
  for (const line of significant) {
    if (line.startsWith('-') && line !== '---') throw Error('复杂 YAML 结构不自动改写');
    const colon = line.indexOf(':');
    if (colon < 0) { if (line === '---') continue; throw Error('仅支持 YAML 键值结构'); }
    if (/^[#&*!|>[{]/.test(line.slice(colon + 1).trim())) throw Error('复杂 YAML 结构不自动改写');
  }
  const parse = text => { const document = YAML.parseDocument(text, { uniqueKeys: true }); if (document.errors.length) throw Error(document.errors[0].message); return JSON.stringify(document.toJS()); };
  const original = parse(input), levels = [];
  const output = lines.map(raw => {
    const clean = raw.trim(); if (!clean || clean.startsWith('#') || clean === '---') return raw;
    const indent = /^ */.exec(raw)[0].length;
    while (levels.length && levels.at(-1) >= indent) levels.pop();
    const depth = levels.length; if (clean.endsWith(':')) levels.push(indent);
    return '  '.repeat(depth) + clean;
  }).join('\n');
  if (parse(output) !== original) throw Error('整理会改变 YAML 含义，已保留原文');
  return { text: output, kind: 'YAML · 仅整理受支持的键值结构' };
}
function formatSQL(input) {
  guardSize(input); if (!input.trim()) throw Error('请输入 SQL');
  const tokens = [], spaced = new Set(); let current = '', quote = null, index = 0;
  const fail = () => { throw Error('SQL 含方言歧义或不完整语法，已保留原文'); };
  const flush = () => { if (current) { tokens.push(current); current = ''; } };
  while (index < input.length) {
    const c = input[index], next = input[index + 1];
    if (quote) { if (c === '\\') fail(); current += c; if (c === quote) { if (next === quote) { current += next; index += 2; } else { quote = null; index++; flush(); } } else index++; continue; }
    if ('\'"`'.includes(c)) {
      const prefix = current.toLowerCase();
      if (c !== '`' && (prefix === 'u&' || /^_[a-z0-9_]+$/i.test(prefix))) fail();
      if (!(c === "'" && ['n', 'e', 'b', 'x'].includes(prefix))) { if (c === "'" && ['q', 'nq', 'u&'].includes(prefix)) fail(); flush(); }
      quote = c; current += c; index++; continue;
    }
    if ('[]#'.includes(c) || (c === '$' && /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.test(input.slice(index)))) fail();
    if (c === '-' && next === '-') { if (input[index + 2] && !/\s/.test(input[index + 2])) fail(); flush(); let end = input.indexOf('\n', index); if (end < 0) end = input.length; tokens.push(input.slice(index, end)); index = end; continue; }
    if (c === '/' && next === '*') { const end = input.indexOf('*/', index + 2); if (end < 0 || input.slice(index + 2, end).includes('/*')) fail(); flush(); tokens.push(input.slice(index, end + 2)); index = end + 2; continue; }
    if (/\s/.test(c)) { flush(); index++; continue; }
    if (',();'.includes(c)) { flush(); if (c === '(' && index && /\s/.test(input[index - 1])) spaced.add(tokens.length); tokens.push(c); index++; continue; }
    current += c; index++;
  }
  if (quote) fail(); flush();
  const literal = token => /^(?:[nebx])?'/i.test(token);
  for (let i = 1; i < tokens.length; i++) if (literal(tokens[i - 1]) && literal(tokens[i])) fail();
  const lines = []; let selectList = false, depth = 0, position = 0;
  const finish = () => { const line = current.trim(); if (line) lines.push(current.startsWith('  ') ? '  ' + line : line); current = ''; };
  while (position < tokens.length) {
    const token = tokens[position], upper = token.toUpperCase(), next = (tokens[position + 1] || '').toUpperCase();
    if (!depth) {
      if (upper === 'SELECT') { finish(); lines.push('SELECT'); current = '  '; selectList = true; position++; continue; }
      let clause = null, consumed = 1;
      if (['LEFT', 'RIGHT', 'INNER', 'FULL', 'CROSS'].includes(upper) && next === 'JOIN') { clause = upper + ' JOIN'; consumed = 2; }
      else if (['GROUP', 'ORDER'].includes(upper) && next === 'BY') { clause = upper + ' BY'; consumed = 2; }
      else if (['FROM', 'WHERE', 'JOIN', 'HAVING', 'LIMIT', 'VALUES', 'SET', 'UNION'].includes(upper)) clause = upper;
      if (clause) { finish(); current = clause; selectList = false; position += consumed; continue; }
    }
    if (token.startsWith('--') || token.startsWith('/*')) { finish(); lines.push(token); }
    else if (token === ',') { current = current.trimEnd() + ','; if (selectList && !depth) { finish(); current = '  '; } }
    else if (token === '(') { current = current.trimEnd(); if (spaced.has(position) && current) current += ' '; current += '('; depth++; }
    else if (token === ')') { if (!depth) fail(); current = current.trimEnd() + ')'; depth--; }
    else if (token === ';') { current = current.trimEnd() + ';'; finish(); selectList = false; }
    else { if (current && current !== '  ' && !current.endsWith('(')) current += ' '; current += token; }
    position++;
  }
  if (depth) fail(); finish(); return lines.join('\n');
}
module.exports = { guardSize, parseJSON, formatJSON, formatConfiguration, formatSQL, findMatches };
