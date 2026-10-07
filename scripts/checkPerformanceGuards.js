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
const tableModel = read("media/markdown/tableModel.js");
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
assert.ok(markdownEditor.includes("minWidth: '100%'"));
assert.ok(markdownEditor.includes("maxWidth: 'none'"));
assert.ok(markdownEditor.includes("boxSizing: 'border-box'"));
assert.ok(markdownEditor.includes("EditorState"));
assert.ok(markdownEditor.includes("Decoration.replace"));
assert.ok(
  markdownEditor.includes(
    "if (selection.empty) return selection.from >= from && selection.from <= to"
  )
);
assert.ok(markdownEditor.includes("const sourcePositionAtPoint = (editorView, event) =>"));
assert.ok(markdownEditor.includes("view.dom.addEventListener('click'"));
assert.ok(markdownEditor.includes("recordSample(performanceStats.pointerSamples"));
assert.ok(markdownEditor.includes("mathGlyphHitMaps.get(node)"));
assert.ok(markdownEditor.includes("mathSourceGlyphCache"));
assert.ok(markdownEditor.includes("requestAnimationFrame(() => requestAnimationFrame(prepareHitMap))"));
assert.ok(
  !markdownEditor.includes("doc.toString()") ||
    markdownEditor.includes("selectionAnchor")
);
assert.ok(markdownEditor.includes("documentBlockPreview"));
assert.ok(markdownEditor.includes("collectDocumentBlocks"));
assert.ok(
  !/documentBlockPreview[\s\S]{0,900}viewportChanged/.test(markdownEditor)
);
assert.ok(
  markdownEditor.includes("const documentBlockPreview = StateField.define")
);
assert.ok(
  markdownEditor.includes("provide: (field) => EditorView.decorations.from")
);
assert.ok(markdownHtml.includes('data-command="search"'));
assert.ok(markdownEditor.includes("openSearchPanel"));
assert.ok(markdownEditor.includes("searchKeymap"));
assert.ok(markdownEditor.includes("paper-reader-cm-math--tagged"));
assert.ok(markdownEditor.includes("class TableWidget"));
assert.ok(markdownStyles.includes("paper-reader-cm-table"));
assert.ok(markdownEditor.includes("syntaxTree(state)"));
assert.ok(markdownEditor.includes("ensureSyntaxTree"));
assert.ok(markdownEditor.includes("syntaxTreeAvailable"));
assert.ok(!markdownEditor.includes("TreeFragment"));
assert.ok(!markdownEditor.includes("markdownLanguage.parser.parse"));
assert.ok(!markdownEditor.includes("EditorView.atomicRanges.of"));
assert.ok(!markdownEditor.includes("y: rect.top + rect.height / 2"));
assert.ok(!markdownEditor.includes("pointerSelectingHeading"));
assert.ok(!markdownEditor.includes("if (!heading || intersectsSelection"));
assert.ok(markdownStyles.includes("paper-reader-cm-heading-marker"));
assert.ok(!markdownStyles.includes("padding-top: 20px !important"));
assert.ok(!markdownStyles.includes("margin-top: 20px !important"));
assert.ok(markdownStyles.includes("--paper-reader-display-math-font-size"));
assert.ok(markdownStyles.includes("text-decoration-line: underline"));
assert.ok(markdownStyles.includes("text-underline-offset: 4px"));
assert.ok(markdownStyles.includes("paper-reader-cm-heading-text"));
assert.ok(!markdownStyles.includes("paper-reader-cm-heading-underline"));
assert.ok(markdownHtml.includes('data-command="font-sizes"'));
assert.ok(markdownHtml.includes('data-command="underline"'));
assert.ok(markdownHtml.includes('title="下划线"'));
assert.ok(!markdownHtml.includes('data-command="heading-underline"'));
assert.ok(markdownHtml.includes('title="标题（Ctrl+Shift+1 大'));
assert.ok(markdownEditor.includes("updateMarkdownFontSizes"));
assert.ok(markdownProvider.includes("markdown.displayMathFontSize"));
assert.ok(markdownEditor.includes("codicon-note"));
assert.ok(markdownProvider.includes("export async function openMarkdownNote"));
assert.ok(markdownProvider.includes("MARKDOWN_VIEW_TYPE,"));
assert.ok(pdfPreview.includes("openMarkdownNote(annotation.exportedPath)"));
assert.ok(!markdownProvider.includes("showTextDocument(noteDocument"));
assert.ok(markdownStyles.includes("z-index: 2147483647"));
assert.ok(!markdownHtml.includes('data-action="aiPolish"'));
assert.ok(!markdownHtml.includes('data-action="exportPdf"'));

// Live table editing guards.
assert.ok(tableModel.includes("export const splitTableRowCells = (line)"));
assert.ok(tableModel.includes("export const serializeTable = (model)"));
assert.ok(tableModel.includes("export const insertTableColumn = (model, index, position = 'after')"));
assert.ok(tableModel.includes("export const deleteTableColumn = (model, index)"));
assert.ok(tableModel.includes("export const insertTableRow = (model, index, position = 'after')"));
assert.ok(tableModel.includes("export const deleteTableRow = (model, index)"));
assert.ok(markdownEditor.includes("const live = this.session;"));
assert.ok(markdownEditor.includes("tableDomMatchesSessionModel(live, this.table)"));
assert.ok(markdownEditor.includes("node.appendChild(live.element)"));
assert.ok(markdownEditor.includes("const tableDomMatchesSessionModel = (session, model)"));
assert.ok(markdownEditor.includes("const commitTableCell = (session, host, options = {})"));
assert.ok(markdownEditor.includes("const flushTableSession = (session, options = {})"));
assert.ok(markdownEditor.includes("const markCellDirty = (session, host)"));
assert.ok(markdownEditor.includes("const tableCommitDelay = 350"));
assert.ok(markdownEditor.includes("const replaceTableInDocument = (session, model)"));
assert.ok(markdownEditor.includes("const runTableControl = (session, action, index)"));
assert.ok(markdownEditor.includes("const editTableSource = () =>"));
assert.ok(markdownEditor.includes("contenteditable', 'plaintext-only'"));
assert.ok(markdownEditor.includes("if (block.type === 'table') return !editingMatch;"));
assert.ok(markdownEditor.includes("performanceStats.tableDomReuses += 1"));
assert.ok(markdownEditor.includes("performanceStats.tableCommits += 1"));
assert.ok(!markdownEditor.includes("点击编辑 Markdown 表格"));
assert.ok(markdownStyles.includes(".paper-reader-cm-cell"));
assert.ok(markdownStyles.includes(".paper-reader-cm-table-controls"));
assert.ok(markdownStyles.includes(".paper-reader-cm-table-control--visible"));
// The ATX heading marker is collapsed rather than left in the text flow, so the heading
// underline cannot dangle under empty space, and the heading line keeps its styling.
assert.ok(markdownEditor.includes("if (node.name === 'HeaderMark')"));
assert.ok(markdownEditor.includes("decorations.push(Decoration.replace({}).range(node.from, node.to + 1));"));
assert.ok(!markdownEditor.includes("paper-reader-cm-heading-marker"));
assert.ok(markdownEditor.includes("const boundaryAt = (event) =>"));
assert.ok(markdownEditor.includes("const TABLE_BOUNDARY_TOLERANCE = 6"));
// Table controls must occupy distinct regions: a reserved band for the column controls, one
// lane for the row controls, and a layout pass that re-derives positions from live cell rects.
assert.ok(markdownEditor.includes("const COLUMN_BAND_HEIGHT = CONTROL_SIZE * 2 + 4"));
// Pointing at a button must reveal that button, which is the rule that keeps every control
// reachable at its own centre.
assert.ok(markdownEditor.includes("const pointerJitter = 3"));
assert.ok(markdownEditor.includes("return { distance: 0, key: id, buttons: [button] };"));
assert.ok(markdownEditor.includes("const anchors = session.controlAnchorPoints || {};"));
// One lane for both row controls, right-aligned flush against the table. The controls are small
// enough that a row's `×` (on the row centre) and the `+` (on the junction half a row below)
// never collide there, so neither gets pushed away from the table.
assert.ok(markdownEditor.includes("const CONTROL_SIZE = 14"));
assert.ok(markdownEditor.includes("const rowLaneX = (rect) => rect.left - half - 2;"));
// Geometry must be read from the mounted table, never captured at build time: a captured table
// is detached after a rebuild and every rect read from it is zero.
assert.ok(markdownEditor.includes("const mountedTable = () => {"));
assert.ok(markdownEditor.includes("const laidOut = layoutTableControls();"));
assert.ok(markdownEditor.includes("if (!button || !button.isConnected) continue;"));
// Handlers bind only once the table is mounted, which is the first moment rects are real.
assert.ok(markdownEditor.includes("const mountTableElement = (table, session) => {"));
assert.ok(!markdownEditor.includes("table.appendChild(body);\n  attachTableHandlers(table, session);"));
assert.ok(markdownEditor.includes("layoutTableControls();"));
// Layout runs in the editor's measure phase, the first moment the widget is inserted and its
// geometry is final; a bare animation frame can run before that and leave stale positions.
assert.ok(markdownEditor.includes("view.requestMeasure({ read: () => layoutTableControls() });"));
assert.ok(markdownEditor.includes("const caretOffsetFromPoint = (host, event)"));
assert.ok(!markdownEditor.includes("paper-reader-cm-table-control--column-insert"));
assert.ok(markdownHtml.includes('data-command="table-source"'));

console.log("Performance guard checks passed.");
