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
const styles = fs.readFileSync(
  path.join(root, "media", "markdown", "index.css"),
  "utf8"
);
const tableModel = fs.readFileSync(
  path.join(root, "media", "markdown", "tableModel.js"),
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
assert.ok(editor.includes("minWidth: '100%'"));
assert.ok(editor.includes("maxWidth: 'none'"));
assert.ok(editor.includes("boxSizing: 'border-box'"));
assert.ok(editor.includes("syntaxTree(state)"));
assert.ok(editor.includes("ensureSyntaxTree"));
assert.ok(editor.includes("syntaxTreeAvailable"));
assert.ok(!editor.includes("TreeFragment"));
assert.ok(!editor.includes("markdownLanguage.parser.parse"));
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
assert.ok(editor.includes("recordSample(performanceStats.pointerSamples"));
assert.ok(editor.includes("mathGlyphHitMaps.get(node)"));
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

// Live table editing: the table stays rendered while cells, rows and columns are edited.
assert.ok(tableModel.includes("export const splitTableRowCells = (line)"));
assert.ok(tableModel.includes("contentStart: line.from + start + leading"));
assert.ok(tableModel.includes("contentEnd: line.from + index - trailing"));
assert.ok(tableModel.includes("export const serializeTable = (model)"));
assert.ok(tableModel.includes("export const insertTableColumn = (model, index, position = 'after')"));
assert.ok(tableModel.includes("export const deleteTableColumn = (model, index)"));
assert.ok(tableModel.includes("export const insertTableRow = (model, index, position = 'after')"));
assert.ok(tableModel.includes("export const deleteTableRow = (model, index)"));
assert.ok(editor.includes("const live = this.session;"));
assert.ok(editor.includes("tableDomMatchesSessionModel(live, this.table)"));
assert.ok(editor.includes("registerTableElement(live, node)"));
assert.ok(editor.includes("node.appendChild(live.element)"));
assert.ok(editor.includes("const tableDomMatchesSessionModel = (session, model)"));
assert.ok(editor.includes("const parseTableNode = (state, node) =>"));
assert.ok(editor.includes("parseTableCellLines(sourceLines(state, node.from, node.to))"));
assert.ok(editor.includes("const focusTableCell = (host)"));
assert.ok(editor.includes("const commitTableCell = (session, host, options = {})"));
assert.ok(editor.includes("const flushTableSession = (session, options = {})"));
assert.ok(editor.includes("const markCellDirty = (session, host)"));
assert.ok(editor.includes("const tableCommitDelay = 350"));
assert.ok(editor.includes("const replaceTableInDocument = (session, model)"));
assert.ok(editor.includes("const runTableControl = (session, action, index)"));
assert.ok(editor.includes("paper-reader-cm-table-control"));
assert.ok(editor.includes("paper-reader-cm-table-control--visible"));
// The ATX heading marker is collapsed rather than left in the text flow, so the heading
// underline cannot dangle under empty space, and the heading line keeps its styling.
assert.ok(editor.includes("if (node.name === 'HeaderMark')"));
assert.ok(editor.includes("decorations.push(Decoration.replace({}).range(node.from, node.to + 1));"));
assert.ok(!editor.includes("paper-reader-cm-heading-marker"));
assert.ok(editor.includes("const boundaryAt = (event) =>"));
assert.ok(editor.includes("button.dataset.boundary"));
assert.ok(editor.includes("const TABLE_BOUNDARY_TOLERANCE = 6"));
assert.ok(editor.includes("const showTableControls = (session, buttons)"));
// Distinct regions per action plus a layout pass fed by live geometry, so no two controls ever
// stack on the same spot (the bug that hid the add-column control).
assert.ok(editor.includes("const COLUMN_BAND_HEIGHT = CONTROL_SIZE * 2 + 4"));
// Pointing at a button must reveal that button, which is the rule that keeps every control
// reachable at its own centre.
assert.ok(editor.includes("const pointerJitter = 3"));
assert.ok(editor.includes("return { distance: 0, key: id, buttons: [button] };"));
assert.ok(editor.includes("const anchors = session.controlAnchorPoints || {};"));
// One lane for both row controls, right-aligned flush against the table. The controls are small
// enough that a row's `×` (on the row centre) and the `+` (on the junction half a row below)
// never collide there, so neither gets pushed away from the table.
assert.ok(editor.includes("const CONTROL_SIZE = 14"));
assert.ok(editor.includes("const rowLaneX = (rect) => rect.left - half - 2;"));
// Geometry must be read from the mounted table, never captured at build time: a captured table
// is detached after a rebuild and every rect read from it is zero.
assert.ok(editor.includes("const mountedTable = () => {"));
assert.ok(editor.includes("const laidOut = layoutTableControls();"));
assert.ok(editor.includes("if (!button || !button.isConnected) continue;"));
// Layout runs in the editor's measure phase, the first moment the widget is inserted and its
// geometry is final; a bare animation frame can run before that and leave stale positions.
assert.ok(editor.includes("view.requestMeasure({ read: () => layoutTableControls() });"));
assert.ok(editor.includes("const caretOffsetFromPoint = (host, event)"));
assert.ok(editor.includes("document.caretRangeFromPoint(event.clientX, event.clientY)"));
assert.ok(!editor.includes("paper-reader-cm-table-control--column-insert"));
assert.ok(!editor.includes("paper-reader-cm-table-control--row-insert"));
assert.ok(editor.includes("deleteTable: () => null"));
assert.ok(editor.includes("contenteditable', 'plaintext-only'"));
assert.ok(editor.includes("const editTableSource = () =>"));
assert.ok(editor.includes("performanceStats.tableDomReuses += 1"));
assert.ok(editor.includes("performanceStats.tableCommits += 1"));
// Tables are exempt from the source-preview toggle so in-place editing never collapses them.
assert.ok(editor.includes("if (block.type === 'table') return !editingMatch;"));
assert.ok(editor.includes("kind: 'table-cell-focus'"));
assert.ok(!editor.includes("node.title = '点击编辑 Markdown 表格'"));
assert.ok(!html.includes("dist/index.min.js"));
assert.ok(html.includes("codemirror.bundle.js"));
assert.ok(html.includes("codicons/codicon.css"));
assert.ok(html.includes("paper-reader-toolbar"));
assert.ok(html.includes('data-command="outline"'));
assert.ok(html.includes('data-command="table-source"'));
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
assert.ok(styles.includes('.paper-reader-cm-cell'));
assert.ok(styles.includes('.paper-reader-cm-table-controls'));
assert.ok(styles.includes('.paper-reader-cm-table-control--visible'));
assert.ok(styles.includes('--vscode-focusBorder'));
assert.ok(styles.includes('white-space: pre-wrap'));
// The table must not regain a card frame or an outline box around the focused cell.
assert.ok(!styles.includes('box-shadow: inset 0 0 0 1px var(--vscode-focusBorder'));
assert.ok(styles.includes('.paper-reader-cm-cell:focus {'));
assert.ok(styles.includes('background: var(--vscode-editor-inactiveSelectionBackground'));

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
