const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const extension = read("src/extension.ts");
const pdfMain = read("lib/main.js");
const pdfPreview = read("src/pdfPreview.ts");
const markdown = read("media/markdown/index.js");
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

console.log("Performance guard checks passed.");
