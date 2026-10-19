// Inline marks inside one table cell.
//
// A cell is a single line of Markdown text: no block syntax, no line breaks. Only inline marks are
// relevant, and only these four kinds: emphasis, strong emphasis, inline code and inline math.
//
// Parsing is deliberately shallow. A strong run's inner text is taken literally rather than parsed
// again, because the renderer maps every character back to a source offset and nesting would make
// that mapping ambiguous for little gain in a table cell.
//
// `\\(...\\)` is accepted alongside `$...$` for math, because MinerU emits that form and rewriting
// the document just to display a formula would be surprising.

const MARK_DELIMITERS = ['*', '_', '`', '$'];

const isEscaped = (source, index) => {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) {
    slashes += 1;
  }
  return slashes % 2 === 1;
};

const isWordChar = (char) => !!char && /[0-9A-Za-z\u4e00-\u9fff]/.test(char);

// A run of the same delimiter character, used for code spans where the opening and closing runs
// must be the same length.
const runLengthAt = (source, index) => {
  let length = 0;
  while (source[index + length] === source[index]) length += 1;
  return length;
};

const findRunEnd = (source, from, marker, length) => {
  let cursor = from;
  while (cursor < source.length) {
    if (source.startsWith(marker, cursor) && !isEscaped(source, cursor)) {
      // A longer run of the same character is not a closer for this run.
      if (marker[0] === '`' && source[cursor + length] === '`') {
        cursor += runLengthAt(source, cursor);
        continue;
      }
      return cursor;
    }
    cursor += 1;
  }
  return -1;
};

const findUnescaped = (source, marker, from) => {
  let cursor = from;
  while (cursor < source.length) {
    const found = source.indexOf(marker, cursor);
    if (found === -1) return -1;
    if (!isEscaped(source, found)) return found;
    cursor = found + marker.length;
  }
  return -1;
};

const hasLineBreak = (value) => value.includes('\n') || value.includes('\r');

export const parseInlineMarks = (value) => {
  const source = String(value ?? '');
  const tokens = [];
  let plainFrom = 0;
  let cursor = 0;

  const pushPlain = (until) => {
    if (until > plainFrom) {
      tokens.push({ kind: 'text', from: plainFrom, to: until, text: source.slice(plainFrom, until) });
    }
  };
  const pushMarked = (kind, from, to, innerFrom, innerTo) => {
    tokens.push({
      kind,
      from,
      to,
      innerFrom,
      innerTo,
      text: source.slice(innerFrom, innerTo),
    });
  };

  while (cursor < source.length) {
    const char = source[cursor];

    // Inline code first: everything inside a backtick run is literal.
    if (char === '`' && !isEscaped(source, cursor)) {
      const length = runLengthAt(source, cursor);
      const close = findRunEnd(source, cursor + length, '`', length);
      if (close !== -1) {
        pushPlain(cursor);
        pushMarked('code', cursor, close + length, cursor + length, close);
        cursor = close + length;
        plainFrom = cursor;
        continue;
      }
    }

    // \\( ... \\)
    if (char === '\\' && source[cursor + 1] === '(' && !isEscaped(source, cursor)) {
      const close = findUnescaped(source, '\\)', cursor + 2);
      const content = close === -1 ? '' : source.slice(cursor + 2, close);
      if (close !== -1 && content.trim() && !hasLineBreak(content)) {
        pushPlain(cursor);
        tokens.push({ kind: 'math', from: cursor, to: close + 2, content: content.trim(), delimiter: '\\(' });
        cursor = close + 2;
        plainFrom = cursor;
        continue;
      }
    }

    // $ ... $ (never $$, which is display math and cannot appear inside a cell)
    if (char === '$' && !isEscaped(source, cursor) && source[cursor + 1] !== '$') {
      const close = findUnescaped(source, '$', cursor + 1);
      const content = close === -1 ? '' : source.slice(cursor + 1, close);
      if (close !== -1 && source[close + 1] !== '$' && content.trim() && !hasLineBreak(content)) {
        pushPlain(cursor);
        tokens.push({ kind: 'math', from: cursor, to: close + 1, content: content.trim(), delimiter: '$' });
        cursor = close + 1;
        plainFrom = cursor;
        continue;
      }
    }

    // ** strong ** or __ strong __
    if ((char === '*' || char === '_') && !isEscaped(source, cursor) && source[cursor + 1] === char) {
      // `__` only opens a strong run on a word boundary, so `some__name` stays literal.
      const wordBoundary = char !== '_' || !isWordChar(source[cursor - 1]);
      const opensOnText = !/\s/.test(source[cursor + 2] || '');
      const marker = char + char;
      const close = wordBoundary && opensOnText ? findRunEnd(source, cursor + 2, marker, 2) : -1;
      const inner = close === -1 ? '' : source.slice(cursor + 2, close);
      if (close !== -1 && inner && !/\s$/.test(inner) && !hasLineBreak(inner)) {
        pushPlain(cursor);
        pushMarked('strong', cursor, close + 2, cursor + 2, close);
        cursor = close + 2;
        plainFrom = cursor;
        continue;
      }
    }

    // * em * or _ em _
    if ((char === '*' || char === '_') && !isEscaped(source, cursor) &&
      source[cursor + 1] !== char && !/\s/.test(source[cursor + 1] || '')) {
      const wordBoundary = char !== '_' ||
        (!isWordChar(source[cursor - 1]) && !isWordChar(source[cursor + 1]));
      const close = wordBoundary ? findRunEnd(source, cursor + 1, char, 1) : -1;
      const inner = close === -1 ? '' : source.slice(cursor + 1, close);
      const closesOnWord = close !== -1 && !isWordChar(source[close + 1]);
      if (close !== -1 && closesOnWord && inner && !/\s$/.test(inner) && !hasLineBreak(inner)) {
        pushPlain(cursor);
        pushMarked('em', cursor, close + 1, cursor + 1, close);
        cursor = close + 1;
        plainFrom = cursor;
        continue;
      }
    }

    cursor += 1;
  }

  pushPlain(source.length);
  return tokens;
};

// True when the cell needs the rendered view: at least one token carries a mark.
export const hasInlineMarks = (value) =>
  parseInlineMarks(value).some((token) => token.kind !== 'text');

export const INLINE_MARK_DELIMITERS = MARK_DELIMITERS;

