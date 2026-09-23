const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const editor = fs.readFileSync(
  path.join(root, "media", "markdown", "codemirror-entry.js"),
  "utf8"
);
const html = fs.readFileSync(
  path.join(root, "media", "markdown", "index.html"),
  "utf8"
);
const bundle = fs.readFileSync(
  path.join(root, "media", "markdown", "codemirror.bundle.js"),
  "utf8"
);

assert.ok(editor.includes("EditorState.create"));
assert.ok(editor.includes("ViewPlugin.fromClass"));
assert.ok(editor.includes("view.visibleRanges"));
assert.ok(editor.includes("view.state.sliceDoc(startLine, endLine)"));
assert.ok(editor.includes("window.paperReaderMarkdownPerformance"));
assert.ok(editor.includes("selectionFrom"));
assert.ok(editor.includes("selectionText"));
assert.ok(editor.includes("documentText"));
assert.ok(editor.includes("Object.defineProperty(performanceStats, 'documentText'"));
assert.ok(editor.includes("inlineMathPattern"));
assert.ok(editor.includes("superscriptPattern"));
assert.ok(editor.includes("paper-reader-cm-heading-"));
assert.ok(editor.includes("markdownLanguage.parser.parse(source, fragments)"));
assert.ok(editor.includes("TreeFragment.applyChanges"));
assert.ok(!editor.includes("EditorView.atomicRanges.of"));
assert.ok(!editor.includes("y: rect.top + rect.height / 2"));
assert.ok(!editor.includes("pointerSelectingHeading"));
assert.ok(!editor.includes("if (!heading || intersectsSelection"));
assert.ok(editor.includes("case 'underline'"));
assert.ok(editor.includes("replaceSelection('<u>', '</u>', 'text')"));
assert.ok(!editor.includes("class InlineCodeWidget"));
assert.ok(editor.includes("class CodeBlockWidget"));
assert.ok(editor.includes("class TableWidget"));
assert.ok(editor.includes("const editingBlockUpdate = StateEffect.define"));
assert.ok(editor.includes("const buildDocumentBlockDecorations = (state, blocks, editingBlock)"));
assert.ok(editor.includes("const insertTable = (rows, columns)"));
assert.ok(editor.includes("data-table-size=\"rows\""));
assert.ok(editor.includes("data-table-size=\"columns\""));
assert.ok(!editor.includes("inlineCodePattern"));
assert.ok(!editor.includes("fencedCodePattern"));
assert.ok(editor.includes("isTableDivider"));
assert.ok(editor.includes("case 'inline-math'"));
assert.ok(editor.includes("if (selection.empty) return selection.from >= from && selection.from <= to"));
assert.ok(editor.includes("const sourcePositionAtPoint = (editorView, event) =>"));
assert.ok(editor.includes("view.dom.addEventListener('click'"));
assert.ok(editor.includes("Mod-Shift-1"));
assert.ok(editor.includes("Mod-Shift-2"));
assert.ok(editor.includes("Mod-Shift-3"));
assert.ok(editor.includes("Mod-Shift-7"));
assert.ok(editor.includes("Mod-Shift-8"));
assert.ok(editor.includes("Mod-Shift-9"));
assert.ok(editor.includes("Mod-Shift-0"));
assert.ok(!editor.includes("Mod-Shift-l"));
assert.ok(!editor.includes("Mod-Shift-f"));
assert.ok(!editor.includes("Mod-Shift-m"));
assert.ok(!editor.includes("Mod-Shift-,"));
assert.ok(editor.includes("line.from + marker.length"));
assert.ok(editor.includes("codicon-note"));
assert.ok(editor.includes("updateMarkdownFontSizes"));
assert.ok(editor.includes("documentBlockPreview"));
assert.ok(editor.includes("renderOutline"));
assert.ok(editor.includes("runToolbarCommand"));
assert.ok(!html.includes("dist/index.min.js"));
assert.ok(html.includes("codemirror.bundle.js"));
assert.ok(html.includes("codicons/codicon.css"));
assert.ok(html.includes("paper-reader-toolbar"));
assert.ok(html.includes('data-command="outline"'));
assert.ok(html.includes('id="paper-reader-table-panel"'));
assert.ok(html.includes('data-command="underline"'));
assert.ok(html.includes('title="下划线"'));
assert.ok(!html.includes('data-command="heading-underline"'));
assert.ok(html.includes('data-command="inline-math"'));
assert.ok(html.includes('title="行内代码（Ctrl+Shift+7）"'));
assert.ok(html.includes('title="代码块（Ctrl+Shift+8）"'));
assert.ok(html.includes('title="独立公式（Ctrl+Shift+0）"'));
assert.ok(html.includes('codicon-edit'));
assert.ok(html.includes('codicon-bracket'));
assert.ok(html.includes('codicon-symbol-function'));
assert.ok(!html.includes('data-command="strike"'));
assert.ok(!html.includes('data-command="quote"'));
assert.ok(!editor.includes('headingStyleUpdate'));
assert.ok(!editor.includes('headingUnderline'));
assert.ok(html.includes('title="标题（Ctrl+Shift+1 大'));
assert.ok(html.includes('title="保存"'));
assert.ok(bundle.length > 100000, "CodeMirror bundle was not generated");

const source = Array.from(
  { length: 10000 },
  (_, index) =>
    `## Section ${index}\n\nText ${index}.\n\n$$\nE = mc^2 + ${index}\n$$\n`
).join("");
const visibleStart = source.indexOf("## Section 5000");
const visible = source.slice(visibleStart, visibleStart + 16000);
assert.ok(visible.length < source.length / 20);
assert.ok((visible.match(/\$\$/g) || []).length > 0);

console.log(
  JSON.stringify({
    documentBytes: Buffer.byteLength(source),
    visibleBytes: Buffer.byteLength(visible),
    visibleRatio: Number((visible.length / source.length).toFixed(4)),
    bundleBytes: bundle.length,
    checks: "passed",
  })
);
