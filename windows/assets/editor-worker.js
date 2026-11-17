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
    self.postMessage({ id, result });
  } catch (error) { self.postMessage({ id, error: error.message, offset: error.offset }); }
};
