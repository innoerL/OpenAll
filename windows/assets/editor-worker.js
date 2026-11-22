importScripts('editor-core.js');
self.onmessage = ({ data }) => {
  const { id, action, text, query, caseSensitive } = data;
  try {
    let result;
    if (action === 'metadata') { const parsed = OpenAllEditorCore.parseJSON(text); result = { regions: parsed.regions, lineCount: parsed.lineCount }; }
    else if (action === 'search') result = OpenAllEditorCore.findMatches(text, query, caseSensitive);
    else if (action === 'configFormat') result = OpenAllEditorCore.formatConfiguration(text);
    else if (action === 'sqlFormat') result = { text: OpenAllEditorCore.formatSQL(text) };
    else result = { text: OpenAllEditorCore.formatJSON(text, action) };
    if (action === 'sqlFormat' || action === 'configFormat') {
      // 在后台按行位置与原文比较，避免把两份完整行数组传回界面。
      const original = text.split('\n'), formatted = result.text.split('\n');
      let changed = Math.max(0, original.length - formatted.length);
      for (let i = 0; i < formatted.length; i++) if (formatted[i] !== original[i]) changed++;
      result.changedLines = changed;
    }
    self.postMessage({ id, result });
  } catch (error) { self.postMessage({ id, error: error.message, offset: error.offset }); }
};
