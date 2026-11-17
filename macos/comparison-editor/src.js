import { EditorState, StateEffect, StateField, Transaction, RangeSet, Compartment } from '@codemirror/state';
import { EditorView, Decoration, WidgetType, GutterMarker, gutter, lineNumbers, keymap, placeholder, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, undo, redo, isolateHistory } from '@codemirror/commands';

const setLayout = StateEffect.define();
const setCharacters = StateEffect.define();
const setSearch = StateEffect.define();
const searchField = StateField.define({
  create: () => Decoration.none,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setSearch)) return effect.value;
    return value.map(transaction.changes);
  },
  provide: field => EditorView.decorations.from(field)
});
const layoutField = StateField.define({
  create: () => ({ decorations: Decoration.none, markers: RangeSet.empty }),
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setLayout)) return effect.value;
    return { decorations: value.decorations.map(transaction.changes), markers: value.markers.map(transaction.changes) };
  },
  provide: field => EditorView.decorations.from(field, value => value.decorations)
});
const characterField = StateField.define({
  create: () => Decoration.none,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setCharacters)) return effect.value;
    return value.map(transaction.changes);
  },
  provide: field => EditorView.decorations.from(field)
});

// 块级占位只参与版面布局，不属于文档内容或撤销记录。
class Spacer extends WidgetType {
  constructor(height) { super(); this.height = height; }
  eq(other) { return this.height === other.height; }
  get estimatedHeight() { return this.height; }
  toDOM() {
    const element = document.createElement('div');
    element.className = 'cm-diffSpacer';
    element.style.height = this.height + 'px';
    element.setAttribute('aria-hidden', 'true');
    return element;
  }
  updateDOM(element) { element.style.height = this.height + 'px'; return true; }
  ignoreEvent() { return false; }
}

class ChangeMarker extends GutterMarker {
  constructor(kind, selected = false) { super(); this.kind = kind; this.selected = selected; }
  eq(other) { return this.kind === other.kind && this.selected === other.selected; }
  toDOM() {
    const element = document.createElement('span');
    element.className = 'cm-changeMark ' + this.kind + (this.selected ? ' current' : '');
    element.textContent = this.kind === 'added' ? '+' : this.kind === 'removed' ? '−' : this.kind ? '~' : '';
    element.title = this.kind === 'added' ? '新增行' : this.kind === 'removed' ? '删除行' : this.kind ? '修改行' : '';
    return element;
  }
}

// 零宽标记指示本侧缺失片段的位置，不向正文或复制内容插入字符。
class ChangeGap extends WidgetType {
  constructor(side) { super(); this.side = side; }
  eq(other) { return this.side === other.side; }
  toDOM() {
    const element = document.createElement('span');
    element.className = 'cm-diffGap ' + (this.side === 0 ? 'removed' : 'added');
    element.title = this.side === 0 ? '此处对应右侧新增的片段' : '此处对应左侧删除的片段';
    element.setAttribute('aria-label', element.title); return element;
  }
}

function overLineLimit(text) {
  let count = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10 && ++count > 200000) return true;
  return false;
}

function create(options) {
  let suppress = false;
  let characterSignature = '';
  let layoutSignature = '';
  let searchSignature = '';
  let valueDocument = null, valueCache = '';
  const historyConfiguration = new Compartment();
  let historyPeak = 0, historyDepth = 60;
  const historyLimit = length => Math.max(3, Math.min(60, Math.floor(30000000 / Math.max(1, length))));
  const makeState = text => {
    historyPeak = text.length;
    historyDepth = historyLimit(historyPeak);
    return EditorState.create({
    doc: String(text).replace(/\r\n?/g, '\n'),
    extensions: [
      EditorState.tabSize.of(4),
      historyConfiguration.of(history({ minDepth: historyDepth })),
      EditorState.changeFilter.of(transaction => {
        if (transaction.newDoc.length <= 10000000 && transaction.newDoc.lines <= 200000) return true;
        options.onReject?.('内容超过 1000 万字符或 20 万行，已保留当前内容');
        return false;
      }),
      keymap.of([{ key: 'Tab', run: view => {
        view.dispatch({ ...view.state.replaceSelection('\t'), userEvent: 'input' });
        return true;
      } }, ...defaultKeymap, ...historyKeymap]),
      drawSelection(),
      placeholder(options.side === 0 ? '粘贴或输入左侧文本' : '粘贴或输入右侧文本'),
      layoutField,
      characterField,
      searchField,
      gutter({ class: 'cm-changeGutter', markers: view => view.state.field(layoutField).markers,
        initialSpacer: () => new ChangeMarker('changed'), renderEmptyElements: true }),
      lineNumbers({ formatNumber: (number, state) => state.doc.length ? String(number) : '' }),
      EditorView.contentAttributes.of({ 'aria-label': options.side === 0 ? '左侧文本，可直接编辑' : '右侧文本，可直接编辑',
        spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' }),
      EditorView.updateListener.of(update => {
        if (update.docChanged) {
          historyPeak = Math.max(historyPeak, update.state.doc.length);
          // 等当前编辑事务结束后收紧历史预算；保留现有状态和最近撤销记录。
          if (historyLimit(historyPeak) !== historyDepth) queueMicrotask(() => {
            const next = historyLimit(historyPeak);
            if (next === historyDepth) return;
            historyDepth = next;
            view.dispatch({ effects: historyConfiguration.reconfigure(history({ minDepth: next })),
              annotations: Transaction.addToHistory.of(false) });
          });
          characterSignature = layoutSignature = searchSignature = '';
          if (!suppress) options.onChange?.();
        }
        if (update.viewportChanged || update.geometryChanged) options.onViewport?.();
      })
    ]
  });
  };
  const view = new EditorView({ state: makeState(''), parent: options.parent });
  view.contentDOM.addEventListener('focus', () => options.onFocus?.());
  view.contentDOM.addEventListener('compositionstart', () => options.onComposition?.(true));
  view.contentDOM.addEventListener('compositionend', () => options.onComposition?.(false));
  view.scrollDOM.addEventListener('scroll', () => options.onScroll?.());
  view.contentDOM.addEventListener('dragover', event => {
    if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
  });
  view.contentDOM.addEventListener('drop', event => {
    if (event.dataTransfer?.files.length) { event.preventDefault(); event.stopPropagation(); options.onDrop?.(event.dataTransfer.files[0]); }
  }, true);

  return {
    view,
    get value() {
      if (valueDocument !== view.state.doc) { valueDocument = view.state.doc; valueCache = view.state.sliceDoc(); }
      return valueCache;
    },
    get length() { return view.state.doc.length; },
    get lineCount() { return view.state.doc.length ? view.state.doc.lines : 0; },
    lineText(number) { return number ? view.state.doc.line(number).text : null; },
    get selectionStart() { return view.state.selection.main.from; },
    get selectionEnd() { return view.state.selection.main.to; },
    get scrollTop() { return view.scrollDOM.scrollTop; },
    set scrollTop(value) { view.scrollDOM.scrollTop = value; },
    get scrollLeft() { return view.scrollDOM.scrollLeft; },
    set scrollLeft(value) { view.scrollDOM.scrollLeft = value; },
    get clientHeight() { return view.scrollDOM.clientHeight; },
    get hasFocus() { return view.hasFocus; },
    get composing() { return view.compositionStarted; },
    focus() { view.focus(); },
    setSelectionRange(from, to) { view.dispatch({ selection: { anchor: from, head: to } }); },
    replaceSelection(text) { view.dispatch({ ...view.state.replaceSelection(text), userEvent: 'input' }); },
    undo() { return undo(view); },
    redo() { return redo(view); },
    replaceDocument(text) {
      if (view.compositionStarted || String(text).length > 10000000 || overLineLimit(String(text))) return false;
      if (view.state.doc.toString() === text) return true;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: 0 },
        annotations: isolateHistory.of('full'), userEvent: 'input.sort' });
      view.scrollDOM.scrollTop = view.scrollDOM.scrollLeft = 0; return true;
    },
    setText(text) {
      if (String(text).length > 10000000 || overLineLimit(String(text))) {
        options.onReject?.('内容超过 1000 万字符或 20 万行，已保留当前内容'); return false;
      }
      suppress = true;
      // 载入新比较时清空历史；普通编辑、差异刷新和滚动都保留同一编辑器及历史。
      view.setState(makeState(String(text)));
      suppress = false;
      characterSignature = layoutSignature = searchSignature = '';
      view.scrollDOM.scrollTop = view.scrollDOM.scrollLeft = 0;
      return true;
    },
    visibleLines() {
      return [...new Set(view.viewportLineBlocks.flatMap(block => Array.isArray(block.type) ? block.type : [block])
        .filter(block => block.type === 0).map(block => view.state.doc.lineAt(block.from).number))];
    },
    lineTop(number) {
      const block = view.lineBlockAt(view.state.doc.line(Math.max(1, Math.min(number, view.state.doc.lines))).from);
      return Array.isArray(block.type) ? (block.type.find(part => part.type === 0)?.top ?? block.top) : block.top;
    },
    lineRect(number) { return view.coordsAtPos(view.state.doc.line(number).from); },
    revealSearch(from, to) {
      view.dispatch({ selection: { anchor: from, head: to },
        effects: EditorView.scrollIntoView(from, { y: 'center', x: 'nearest' }),
        annotations: Transaction.addToHistory.of(false) });
    },
    applySearch(matches, current) {
      // 只为当前视口生成标记；全文搜索结果不进入正文、差异或历史。
      const from = view.viewport.from, to = view.viewport.to;
      let low = 0, high = matches.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (matches[middle].to < from) low = middle + 1; else high = middle;
      }
      const visible = [];
      for (let index = low; index < matches.length && matches[index].from <= to; index++) {
        const match = matches[index];
        if (match.to <= view.state.doc.length) visible.push([match.from, match.to, index === current]);
      }
      const signature = JSON.stringify(visible);
      if (signature === searchSignature) return;
      searchSignature = signature;
      view.dispatch({ effects: setSearch.of(Decoration.set(visible.map(([start, end, selected]) =>
        Decoration.mark({ class: 'cm-contentMatch' + (selected ? ' active' : '') }).range(start, end)), true)),
        annotations: Transaction.addToHistory.of(false) });
    },
    applyLayout(spacers, kinds, selected, version = 0) {
      const first = Math.max(0, view.state.doc.lineAt(view.viewport.from).number - 2);
      const last = Math.min(kinds.length, view.state.doc.lineAt(view.viewport.to).number + 1);
      const signature = `${version}:${first}:${last}:${selected}`;
      if (signature === layoutSignature) return;
      layoutSignature = signature;
      const decorations = [], markers = [];
      for (const spacer of spacers) {
        if (spacer.before && spacer.line > view.state.doc.lines) continue;
        const position = spacer.before ? view.state.doc.line(spacer.line).from : view.state.doc.length;
        decorations.push(Decoration.widget({ widget: new Spacer(spacer.count * 22), block: true, side: spacer.before ? -1 : 1 }).range(position));
      }
      // 行背景和边栏标记只覆盖可见行；跨整份文档的占位仍保留以维持滚动高度。
      for (let index = first; index < last; index++) {
        if (index >= view.state.doc.lines) break;
        const kind = kinds[index];
        const current = selected && index >= selected[0] && index <= selected[1];
        if (!kind && !current) continue;
        const position = view.state.doc.line(index + 1).from;
        markers.push(new ChangeMarker(kind, current).range(position));
        if (kind || current) {
          decorations.push(Decoration.line({ class: 'cm-diffLine ' + kind + (current ? ' current' : '') }).range(position));
        }
      }
      view.dispatch({ effects: setLayout.of({ decorations: Decoration.set(decorations, true), markers: RangeSet.of(markers, true) }), annotations: Transaction.addToHistory.of(false) });
      view.requestMeasure();
    },
    applyCharacters(lines) {
      const signature = JSON.stringify(lines);
      if (signature === characterSignature) return;
      characterSignature = signature;
      const decorations = [];
      for (const { number, parts, gaps = [] } of lines) {
        let offset = view.state.doc.line(number).from;
        for (const gap of gaps) decorations.push(Decoration.widget({ widget: new ChangeGap(options.side), side: 1 }).range(offset + gap));
        for (const part of parts) {
          if (part.marked && part.text.length) decorations.push(Decoration.mark({ class: 'cm-diffToken ' + (options.side === 0 ? 'removed' : 'added') }).range(offset, offset + part.text.length));
          offset += part.text.length;
        }
      }
      view.dispatch({ effects: setCharacters.of(Decoration.set(decorations, true)), annotations: Transaction.addToHistory.of(false) });
    }
  };
}

window.OpenAllComparisonEditor = { create, acceptsText: text => text.length <= 10000000 && !overLineLimit(text) };
