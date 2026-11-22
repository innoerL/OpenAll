import { EditorState, StateEffect, StateField, Transaction, Compartment } from '@codemirror/state';
import { EditorView, ViewPlugin, Decoration, keymap, lineNumbers, placeholder, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, undo, redo, indentWithTab, isolateHistory } from '@codemirror/commands';
import { codeFolding, foldGutter, foldService, foldedRanges, foldEffect, unfoldEffect, foldAll, unfoldAll, foldKeymap } from '@codemirror/language';

const regionsEffect = StateEffect.define(), searchEffect = StateEffect.define();
const regionsField = StateField.define({
  create: () => [],
  update(regions, transaction) {
    for (const effect of transaction.effects) if (effect.is(regionsEffect)) return effect.value;
    if (!transaction.docChanged) return regions;
    return regions.map(region => ({ ...region, from: transaction.changes.mapPos(region.from, -1), to: transaction.changes.mapPos(region.to, 1) })).filter(region => region.to > region.from);
  }
});
const searchField = StateField.define({
  create: () => Decoration.none,
  update(value, transaction) { for (const effect of transaction.effects) if (effect.is(searchEffect)) return effect.value; return value.map(transaction.changes); },
  provide: field => EditorView.decorations.from(field)
});
const parameterEffect = StateEffect.define();
const parameterField = StateField.define({
  create: () => Decoration.none,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(parameterEffect)) return effect.value;
    return transaction.docChanged ? Decoration.none : value;
  },
  provide: field => EditorView.decorations.from(field)
});
const syntaxFor = (mode = 'json') => ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this.paint(view); }
  update(update) { if (update.docChanged || update.viewportChanged) this.decorations = this.paint(update.view); }
  paint(view) {
    const marks = [];
    for (const range of view.visibleRanges) {
      if (range.to - range.from > 100000) continue;
      const expression = mode === 'markdown' ? /^#{1,6}[ \t]+.*$|^\s*(?:[-*+] |\d+\. |>[ \t]).*$|`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|!?\[[^\]\n]+\]\([^\n)]+\)|^\s*```[^\n]*$/gm
        : mode === 'sql' ? /'(?:''|[^'])*'|"(?:""|[^"])*"|`[^`]*`|--[^\n]*|\/\*[\s\S]*?\*\/|\b(?:SELECT|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|ON|AS|AND|OR|NOT|IN|IS|NULL|TRUE|FALSE|ORDER|BY|GROUP|HAVING|LIMIT|OFFSET|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|ALTER|DROP|TABLE|WITH|UNION|ALL|CASE|WHEN|THEN|ELSE|END|DISTINCT|ASC|DESC|EXISTS|LIKE|RETURNING|EXPLAIN|ANALYZE)\b|\b\d+(?:\.\d+)?\b/gi
        : mode === 'config' ? /"(?:\\.|[^"\\])*"|'.*?'|^[ \t]*[^#!=:\n]+(?=[ \t]*[=:])|#[^\n]*|^![^\n]*|\b(?:true|false|null|yes|no|on|off)\b|-?\b\d+(?:\.\d+)?\b/gm
        : /"(?:\\.|[^"\\])*"(\s*:)?|\b(?:true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g;
      const text = view.state.doc.sliceString(range.from, range.to);
      for (const match of text.matchAll(expression)) {
        const token = match[0].trimStart();
        const kind = mode === 'markdown' ? token.startsWith('#') ? 'heading' : token.startsWith('`') ? 'string' : token.startsWith('**') || token.startsWith('__') ? 'strong' : 'key'
          : mode === 'sql' ? /^(?:--|\/\*)/.test(token) ? 'comment' : /^["'`]/.test(token) ? 'string' : /^\d/.test(token) ? 'number' : 'key'
          : mode === 'config' ? /^[#!]/.test(token) ? 'comment' : /^["']/.test(token) ? 'string' : /^(?:true|false|null|yes|no|on|off)$/.test(token) ? 'literal' : /^-?\d/.test(token) ? 'number' : 'key'
          : token.startsWith('"') ? (match[1] ? 'key' : 'string') : /^(?:true|false|null)$/.test(token) ? 'literal' : 'number';
        const end = range.from + match.index + match[0].length - (match[1]?.length || 0);
        marks.push(Decoration.mark({ class: 'editor-json-' + kind }).range(range.from + match.index, end));
      }
    }
    return Decoration.set(marks, true);
  }
}, { decorations: plugin => plugin.decorations });
function create(options) {
  let view, documentCache, valueCache = '', peak = 0, historyDepth = 60, large = false;
  const historyConfig = new Compartment(), wrapConfig = new Compartment();
  function unfolded(state) { const effects = []; foldedRanges(state).between(0, state.doc.length, (from, to) => effects.push(unfoldEffect.of({ from, to }))); return effects; }
  const state = EditorState.create({
    doc: '', extensions: [
      EditorState.tabSize.of(2), EditorState.readOnly.of(!!options.readOnly), EditorView.editable.of(!options.readOnly), historyConfig.of(history({ minDepth: 60 })), wrapConfig.of(EditorView.lineWrapping),
      drawSelection(), lineNumbers(), regionsField, searchField, options.parameterMarks ? parameterField : [], options.syntax === false ? [] : syntaxFor(options.syntax),
      placeholder(options.placeholder || '在这里粘贴或输入 JSON，格式化后继续编辑'),
      EditorView.contentAttributes.of({ 'aria-label': options.label || 'JSON 编辑区', spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' }),
      codeFolding({
        preparePlaceholder: (state, range) => state.doc.lineAt(range.to).number - state.doc.lineAt(range.from).number,
        placeholderDOM: (_view, onclick, lines) => { const span = document.createElement('span'); span.className = 'cm-foldPlaceholder'; span.textContent = ` … ${lines} 行 `; span.title = '点击展开；局部删除先展开，全选可直接清空'; span.onclick = onclick; return span; }
      }),
      foldGutter({ openText: '⌄', closedText: '›', foldingChanged: update => update.transactions.some(transaction => transaction.effects.some(effect => effect.is(regionsEffect))) }),
      foldService.of((state, from, to) => {
        const regions = state.field(regionsField); let low = 0, high = regions.length;
        while (low < high) { const middle = (low + high) >>> 1; if (regions[middle].from < from) low = middle + 1; else high = middle; }
        const region = regions[low]; return region && region.from <= to && region.to > to ? { from: region.from, to: region.to } : null;
      }),
      // 折叠保留完整文档；全文删除直接清空，局部删除与替换仍先展开隐藏内容。
      EditorState.transactionFilter.of(transaction => {
        if (!transaction.docChanged || transaction.isUserEvent('undo') || transaction.isUserEvent('redo') || ['input.format', 'input.load'].includes(transaction.annotation(Transaction.userEvent))) return transaction;
        if (transaction.isUserEvent('delete') && transaction.newDoc.length === 0) return transaction;
        const effects = [], seen = new Set();
        transaction.changes.iterChangedRanges((from, to) => {
          if (to <= from) return;
          foldedRanges(transaction.startState).between(from, to, (foldFrom, foldTo) => {
            if (foldFrom >= to || foldTo <= from || seen.has(foldFrom)) return;
            seen.add(foldFrom); effects.push(unfoldEffect.of({ from: foldFrom, to: foldTo }));
          });
        });
        if (!effects.length) return transaction;
        options.onNotice?.('已展开折叠内容，再按一次删除才会删除');
        return { effects, annotations: Transaction.addToHistory.of(false) };
      }),
      EditorState.changeFilter.of(transaction => {
        if (transaction.newDoc.length <= 10000000 && transaction.newDoc.lines <= 200000) return true;
        options.onNotice?.('内容超过 1000 万字符或 20 万行，已保留原文'); return false;
      }),
      keymap.of([
        { key: 'Mod-f', run: () => { options.onFind?.(); return true; } },
        { key: 'Mod-Enter', run: () => { if (!options.onFormat) return false; options.onFormat(); return true; } },
        { key: 'F3', run: () => { options.onFindNext?.(1); return true; } },
        { key: 'Shift-F3', run: () => { options.onFindNext?.(-1); return true; } },
        indentWithTab, ...defaultKeymap, ...historyKeymap, ...foldKeymap
      ]),
      EditorView.updateListener.of(update => {
        if (update.docChanged) {
          peak = Math.max(peak, update.state.doc.length);
          const nextDepth = Math.max(3, Math.min(60, Math.floor(30000000 / Math.max(1, peak))));
          const nextLarge = update.state.doc.length > 200000;
          if (nextDepth !== historyDepth || nextLarge !== large) queueMicrotask(() => {
            if (!view || view.destroyed) return;
            historyDepth = nextDepth; large = nextLarge;
            view.dispatch({ effects: [historyConfig.reconfigure(history({ minDepth: historyDepth })), wrapConfig.reconfigure(large ? [] : EditorView.lineWrapping)], annotations: Transaction.addToHistory.of(false) });
          });
          options.onChange?.();
        }
        if (update.viewportChanged || update.docChanged) options.onViewport?.();
        if (update.transactions.some(transaction => transaction.effects.some(effect => effect.is(foldEffect) || effect.is(unfoldEffect)))) options.onFold?.();
      })
    ]
  });
  view = new EditorView({ state, parent: options.parent });
  view.contentDOM.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
  view.contentDOM.addEventListener('drop', event => { if (event.dataTransfer?.files.length) { event.preventDefault(); event.stopPropagation(); options.onDrop?.(event.dataTransfer.files[0]); } }, true);
  return {
    view,
    get value() { if (documentCache !== view.state.doc) { documentCache = view.state.doc; valueCache = view.state.sliceDoc(); } return valueCache; },
    get length() { return view.state.doc.length; },
    get lineCount() { return view.state.doc.length ? view.state.doc.lines : 0; },
    get selectedText() { return view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to); },
    get foldCount() { return foldedRanges(view.state).size; },
    get folded() { return this.foldCount > 0; },
    get hasFocus() { return view.hasFocus; },
    setText(text, formatted = false) {
      text = String(text).replace(/\r\n?/g, '\n');
      if (text.length > 10000000) { options.onNotice?.('内容超过 1000 万字符，已保留原文'); return false; }
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: 0 }, effects: unfolded(view.state), annotations: isolateHistory.of('full'), userEvent: formatted ? 'input.format' : 'input.load' });
      return true;
    },
    paste(text) { view.focus(); view.dispatch({ ...view.state.replaceSelection(String(text)), userEvent: 'input.paste' }); },
    focus() { view.focus(); },
    undo() { return undo(view); }, redo() { return redo(view); },
    setRegions(regions) { view.dispatch({ effects: regionsEffect.of(regions), annotations: Transaction.addToHistory.of(false) }); },
    foldLine(line) { const region = view.state.field(regionsField).find(item => view.state.doc.lineAt(item.from).number === line); if (!region) return false; view.dispatch({ effects: foldEffect.of(region), annotations: Transaction.addToHistory.of(false) }); return true; },
    foldAll() { return foldAll(view); }, unfoldAll() { return unfoldAll(view); },
    setParameterMarks(spans) {
      if (!options.parameterMarks) return;
      const mark = Decoration.mark({ class: 'editor-bound-parameter' });
      const ranges = spans.filter(({from, to}) => from >= 0 && from < to && to <= view.state.doc.length).map(({from, to}) => mark.range(from, to));
      view.dispatch({ effects: parameterEffect.of(Decoration.set(ranges)), annotations: Transaction.addToHistory.of(false) });
    },
    setSearch(matches, active = -1) {
      const ranges = []; const { from, to } = view.viewport;
      for (let i = 0; i < matches.length; i++) { const match = matches[i]; if (match.from > to) break; if (match.to < from || match.to > view.state.doc.length) continue; ranges.push(Decoration.mark({ class: 'editor-content-match' + (i === active ? ' active' : '') }).range(match.from, match.to)); }
      view.dispatch({ effects: searchEffect.of(Decoration.set(ranges, true)), annotations: Transaction.addToHistory.of(false) });
    },
    reveal(from, to) {
      const effects = [];
      foldedRanges(view.state).between(from, to, (a, b) => effects.push(unfoldEffect.of({ from: a, to: b })));
      effects.push(EditorView.scrollIntoView(from, { y: 'center' }));
      view.dispatch({ selection: { anchor: from, head: to }, effects, annotations: Transaction.addToHistory.of(false) });
    },
    destroy() { view.destroy(); }
  };
}
window.OpenAllJSONEditor = { create };
