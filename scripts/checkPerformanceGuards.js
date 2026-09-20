const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const extension = read("src/extension.ts");
const pdfMain = read("lib/main.js");
const pdfPreview = read("src/pdfPreview.ts");
const markdown = read("media/markdown/index.js");
const markdownHtml = read("media/markdown/index.html");
const markdownEditor = read("media/markdown/codemirror-entry.js");
const markdownStyles = read("media/markdown/index.css");
const markdownProvider = read("src/markdownWysiwygProvider.ts");
const notes = read("src/notesPanel.ts");

assert.ok(!extension.includes("retainContextWhenHidden: true"));
assert.ok(
  !pdfMain.includes(
    "setInterval(function () {\n      postMessage({ command: 'loadPdfAnnotations' })"
  )
);
assert.ok(!notes.includes("viewportMargin: Infinity"));
assert.strictEqual(
  (pdfPreview.match(/'build', 'pdf\.worker\.js'/g) || []).length,
  2
);
assert.ok(pdfPreview.includes("worker-src blob:"));
assert.ok(pdfMain.includes("PDFViewerApplicationOptions.set('workerSrc'"));
assert.ok(
  pdfMain.includes("PDFViewerApplicationOptions.set('isEvalSupported', false)")
);
assert.ok(pdfMain.includes("PDFViewerApplication.open(config.path, loadOpts)"));
assert.ok(!pdfMain.includes("PDFViewerApplication.open(config.path).then"));
assert.ok(markdown.includes("scheduleDocumentSave(handler, content)"));
assert.ok(markdownProvider.includes("computeMinimalTextChange"));
assert.ok(markdownHtml.includes("codemirror.bundle.js"));
assert.ok(!markdownHtml.includes("dist/index.min.js"));
assert.ok(markdownEditor.includes("view.visibleRanges"));
assert.ok(markdownEditor.includes("EditorState"));
assert.ok(markdownEditor.includes("Decoration.replace"));
assert.ok(!markdownEditor.includes("doc.toString()") || markdownEditor.includes("selectionAnchor"));
assert.ok(markdownEditor.includes("documentBlockPreview"));
assert.ok(markdownEditor.includes("collectDocumentBlocks"));
assert.ok(!/documentBlockPreview[\s\S]{0,900}viewportChanged/.test(markdownEditor));
assert.ok(markdownEditor.includes("const documentBlockPreview = StateField.define"));
assert.ok(markdownEditor.includes("provide: (field) => EditorView.decorations.from"));
assert.ok(markdownHtml.includes('data-command="search"'));
assert.ok(markdownEditor.includes("openSearchPanel"));
assert.ok(markdownEditor.includes("searchKeymap"));
assert.ok(markdownEditor.includes("paper-reader-cm-math--tagged"));
assert.ok(markdownStyles.includes("font-size: 1.3em"));

console.log("Performance guard checks passed.");
