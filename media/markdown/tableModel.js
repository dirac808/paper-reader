// Pure Markdown table model helpers shared by the live-preview editor and the unit tests.
// These functions carry no DOM or CodeMirror dependency so every edit path stays testable.

export const splitTableRow = (text) => {
  let row = text.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
};

// Editable cell text is unescaped form. Edits are diffs against this text so an unchanged
// cell keeps its exact source bytes and a stable table cannot be re-escaped on every edit.
export const unescapeTableCell = (value) => value.replace(/\\\|/g, '|').replace(/\\\\/g, '\\');

// Splits a table line and keeps the exact source range of every cell's editable text.
// Table cells stay editable in place, so every edit has to map back to a character range.
export const splitTableRowCells = (line) => {
  const text = line.text;
  const cells = [];
  let start = text.startsWith('|') ? 1 : 0;
  for (let index = start; index <= text.length; index += 1) {
    if (index === text.length || (text[index] === '|' && text[index - 1] !== '\\')) {
      const raw = text.slice(start, index);
      if (index === text.length && !raw && cells.length > 0) break;
      const leading = raw.length - raw.trimStart().length;
      const trailing = raw.length - raw.trimEnd().length;
      cells.push({
        raw,
        text: unescapeTableCell(raw.trim()),
        contentStart: line.from + start + leading,
        contentEnd: line.from + index - trailing,
      });
      start = index + 1;
    }
  }
  return cells;
};

export const escapeTableCell = (value) => String(value ?? '')
  .replace(/\\/g, '\\\\')
  .replace(/\|/g, '\\|')
  .replace(/[\r\n\t]+/g, ' ')
  .trim();

export const tableAlignment = (cell) => {
  const value = cell.trim();
  return value.startsWith(':') && value.endsWith(':')
    ? 'center'
    : value.endsWith(':')
      ? 'right'
      : value.startsWith(':')
        ? 'left'
        : null;
};

export const isTableDivider = (text) => {
  const cells = splitTableRow(text);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
};

export const serializeTable = (model) => {
  const columns = Math.max(1, model.headers.length);
  const headers = Array.from({ length: columns }, (_value, index) =>
    escapeTableCell(model.headers[index]));
  const divider = Array.from({ length: columns }, (_value, index) => {
    const alignment = model.alignments?.[index] || null;
    if (alignment === 'center') return ':---:';
    if (alignment === 'right') return '---:';
    if (alignment === 'left') return ':---';
    return '---';
  });
  const rows = (model.rows || []).map((row) =>
    `| ${Array.from({ length: columns }, (_value, index) => escapeTableCell(row[index])).join(' | ')} |`);
  return [
    `| ${headers.join(' | ')} |`,
    `| ${divider.join(' | ')} |`,
    ...rows,
  ].join('\n');
};

export const normalizeTableModel = (model) => {
  const columns = Math.max(1, model.headers.length);
  const headers = Array.from({ length: columns }, (_value, index) => model.headers[index] ?? '');
  const alignments = Array.from({ length: columns }, (_value, index) => model.alignments?.[index] ?? null);
  const rows = (model.rows || []).map((row) =>
    Array.from({ length: columns }, (_value, index) => row[index] ?? ''));
  return { headers, alignments, rows };
};

export const insertTableColumn = (model, index, position = 'after') => {
  const next = normalizeTableModel(model);
  const columns = next.headers.length;
  const at = Math.max(0, Math.min(columns, position === 'before' ? index : index + 1));
  const append = (list) => {
    const copy = list.slice();
    copy.splice(at, 0, '');
    return copy;
  };
  return normalizeTableModel({
    headers: append(next.headers),
    alignments: append(next.alignments),
    rows: next.rows.map((row) => append(row)),
  });
};

export const deleteTableColumn = (model, index) => {
  const next = normalizeTableModel(model);
  if (next.headers.length <= 1) return null;
  const remove = (list) => list.filter((_value, position) => position !== index);
  return normalizeTableModel({
    headers: remove(next.headers),
    alignments: remove(next.alignments),
    rows: next.rows.map((row) => remove(row)),
  });
};

export const insertTableRow = (model, index, position = 'after') => {
  const next = normalizeTableModel(model);
  const at = Math.max(0, Math.min(next.rows.length, position === 'before' ? index : index + 1));
  const rows = next.rows.slice();
  rows.splice(at, 0, next.headers.map(() => ''));
  return { ...next, rows };
};

export const deleteTableRow = (model, index) => {
  const next = normalizeTableModel(model);
  if (next.rows.length <= 1) return null;
  return { ...next, rows: next.rows.filter((_value, position) => position !== index) };
};

export const tableEstimatedHeight = (model) =>
  Math.max(72, Math.min(520, ((model.rows?.length || 0) + 1) * 34 + 18));

// Parses a whole table from its source lines. `lines` entries are `{ text, from }` so cell
// ranges can be resolved without a CodeMirror state, which keeps this unit-testable.
export const parseTableCellLines = (lines) => {
  if (!lines || lines.length < 2) return null;
  let headerCells = splitTableRowCells(lines[0]);
  let dividerCells = splitTableRowCells(lines[1]);
  // `| a | b |` and `| a | b |  |` both end in a pipe. Only the divider row can tell them
  // apart, so an extra trailing cell is dropped when the divider has no cell for it.
  if (headerCells.length === dividerCells.length + 1 && dividerCells.length > 1) {
    headerCells = headerCells.slice(0, dividerCells.length);
  }
  if (headerCells.length < 2 || dividerCells.length !== headerCells.length ||
    !isTableDivider(lines[1].text)) return null;
  const bodyLines = [];
  for (const line of lines.slice(2)) {
    if (!line.text.trim() || !line.text.includes('|')) break;
    const cells = splitTableRowCells(line).slice(0, headerCells.length);
    if (cells.length !== headerCells.length) break;
    bodyLines.push({ line, cells });
  }
  return {
    headers: headerCells.map((cell) => cell.text),
    alignments: dividerCells.map((cell) => tableAlignment(cell.text)),
    rows: bodyLines.map((entry) => entry.cells.map((cell) => cell.text)),
    source: {
      headerCells,
      dividerCells,
      bodyCells: bodyLines.map((entry) => entry.cells),
      rowLines: [lines[0], ...bodyLines.map((entry) => entry.line)],
    },
  };
};
