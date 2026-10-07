const assert = require("assert");
const fs = require("fs");
const path = require("path");

const modelPath = path.resolve(__dirname, "..", "media", "markdown", "tableModel.js");
const source = fs.readFileSync(modelPath, "utf8").replace(/^export /gm, "");
const module_ = { exports: {} };
new Function("module", "exports", `${source}
module.exports = {
  splitTableRowCells,
  serializeTable,
  normalizeTableModel,
  insertTableColumn,
  deleteTableColumn,
  insertTableRow,
  deleteTableRow,
  parseTableCellLines,
  escapeTableCell,
};`)(module_, module_.exports);
const model = module_.exports;

const lines = (text) => {
  const result = [];
  let from = 0;
  for (const line of text.split("\n")) {
    result.push({ text: line, from });
    from += line.length + 1;
  }
  return result;
};

// Every structural edit re-serializes the table, so parse -> serialize -> parse has to be
// stable. Double escaping or a dropped column here corrupts the user's table.
const roundTrip = (table, label) => {
  const text = model.serializeTable(table);
  const parsed = model.parseTableCellLines(lines(text));
  assert.ok(parsed, `${label}: serialized table did not re-parse: ${JSON.stringify(text)}`);
  assert.deepStrictEqual(parsed.headers, table.headers, `${label}: headers drifted: ${text}`);
  assert.deepStrictEqual(parsed.rows, table.rows, `${label}: rows drifted: ${text}`);
  assert.strictEqual(parsed.headers.length, table.headers.length,
    `${label}: columns drifted: ${text}`);
  return parsed;
};

const plain = model.parseTableCellLines(lines("| A | B |\n| --- | --- |\n| 1 | 2 |"));
assert.deepStrictEqual(plain.headers, ["A", "B"]);
assert.deepStrictEqual(plain.rows, [["1", "2"]]);

// Cell source ranges drive every in-place edit, so they have to point at the exact text.
assert.strictEqual(plain.source.headerCells[1].text, "B");
assert.strictEqual(plain.source.bodyCells[0][0].text, "1");
assert.strictEqual(plain.source.bodyCells[0][0].contentStart, 26);

roundTrip({ headers: ["A", "B"], alignments: [null, null], rows: [["1", "2"]] }, "plain");

// Empty cells are the regression case: inserting a column or a row creates them.
roundTrip(
  model.insertTableColumn({ headers: ["A", "B"], alignments: [null, null], rows: [["1", "2"]] }, 1, "after"),
  "inserted column"
);
roundTrip(
  model.insertTableRow({ headers: ["A", "B"], alignments: [null, null], rows: [["1", "2"]] }, 1, "after"),
  "inserted row"
);
roundTrip(
  model.insertTableRow({ headers: ["A", "B"], alignments: [null, null], rows: [["1", "2"]] }, 0, "before"),
  "inserted row at top"
);

// A sequence of structural edits must not drift the shape.
let edited = { headers: ["A", "B"], alignments: [null, null], rows: [["1", "2"], ["3", "4"]] };
edited = model.insertTableColumn(edited, 0, "after");
edited = model.insertTableColumn(edited, 2, "after");
edited = model.insertTableRow(edited, 2, "after");
edited = model.deleteTableColumn(edited, 1);
edited = model.deleteTableRow(edited, 0);
const afterEdits = roundTrip(edited, "after structural edits");
assert.strictEqual(afterEdits.headers.length, 3, "structural edits drifted the column count");

// Escaped pipes and backslashes must survive without double escaping on each edit.
roundTrip(
  { headers: ["a|b", "c\\d"], alignments: [null, null], rows: [["x|y", "z"]] },
  "escaped cells"
);

const aligned = model.parseTableCellLines(lines("| A | B | C |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |"));
assert.deepStrictEqual(aligned.alignments, ["left", "center", "right"]);
roundTrip(aligned, "aligned");

// Tables without leading/trailing pipes are valid Markdown too.
const noTrailing = model.parseTableCellLines(lines("A | B\n--- | ---\n1 | 2"));
assert.deepStrictEqual(noTrailing.headers, ["A", "B"]);
assert.deepStrictEqual(noTrailing.rows, [["1", "2"]]);

// Empty cells written as `|  |` keep the declared column count.
const spaced = model.parseTableCellLines(lines("| A | B |  |  |\n| --- | --- | --- | --- |\n| 1 | 2 |  |  |"));
assert.strictEqual(spaced.headers.length, 4, "spaced trailing pipes lost a column");

// Guards against invalid tables.
assert.strictEqual(model.deleteTableColumn({ headers: ["A"], alignments: [null], rows: [["1"]] }, 0), null);
assert.strictEqual(model.deleteTableRow({ headers: ["A", "B"], alignments: [null, null], rows: [["1", "2"]] }, 0), null);
assert.strictEqual(model.parseTableCellLines(lines("| A |\n| --- |")), null);

console.log("Table model unit tests passed.");
