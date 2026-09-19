const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const editor = fs.readFileSync(
  path.join(root, 'media', 'markdown', 'codemirror-entry.js'),
  'utf8',
);
const html = fs.readFileSync(
  path.join(root, 'media', 'markdown', 'index.html'),
  'utf8',
);
const bundle = fs.readFileSync(
  path.join(root, 'media', 'markdown', 'codemirror.bundle.js'),
  'utf8',
);

assert.ok(editor.includes('EditorState.create'));
assert.ok(editor.includes('ViewPlugin.fromClass'));
assert.ok(editor.includes('view.visibleRanges'));
assert.ok(editor.includes('view.state.sliceDoc(startLine, endLine)'));
assert.ok(editor.includes('window.paperReaderMarkdownPerformance'));
assert.ok(!html.includes('dist/index.min.js'));
assert.ok(html.includes('codemirror.bundle.js'));
assert.ok(bundle.length > 100000, 'CodeMirror bundle was not generated');

const source = Array.from({ length: 10000 }, (_, index) =>
  `## Section ${index}\n\nText ${index}.\n\n$$\nE = mc^2 + ${index}\n$$\n`,
).join('');
const visibleStart = source.indexOf('## Section 5000');
const visible = source.slice(visibleStart, visibleStart + 16000);
assert.ok(visible.length < source.length / 20);
assert.ok((visible.match(/\$\$/g) || []).length > 0);

console.log(
  JSON.stringify({
    documentBytes: Buffer.byteLength(source),
    visibleBytes: Buffer.byteLength(visible),
    visibleRatio: Number((visible.length / source.length).toFixed(4)),
    bundleBytes: bundle.length,
    checks: 'passed',
  }),
);
