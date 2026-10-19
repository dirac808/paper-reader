// Inline marks inside one table cell.
//
// A cell is a single line of Markdown text: no block syntax, no line breaks. Only inline marks are
// relevant, and only these four kinds: emphasis, strong emphasis, inline code and inline math.
//
// Tokens carry absolute source offsets. Emphasis and strong emphasis keep their inner tokens, so
// `**\(n\)**` renders as bold math instead of literal backslashes, and every leaf still maps back
// to the characters it came from — the caret depends on that when a cell switches to its source.
//
// `\\(...\\)` is accepted alongside `$...$` for math, because MinerU emits that form and rewriting
// the document just to display a formula would be surprising.

const MAX_NESTING = 6;

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
const runLengthAt = (source, index, limit) => {
  let length = 0;
  while (index + length < limit && source[index + length] === source[index]) length += 1;
  return length;
};

const findRunEnd = (source, from, limit, marker, length) => {
  let cursor = from;
  while (cursor < limit) {
    if (source.startsWith(marker, cursor) && !isEscaped(source, cursor)) {
      // A longer run of the same character is not a closer for this run.
      if (marker[0] === '`' && source[cursor + length] === '`') {
        cursor += runLengthAt(source, cursor, limit);
        continue;
      }
      return cursor;
    }
    cursor += 1;
  }
  return -1;
};

const findUnescaped = (source, marker, from, limit) => {
  let cursor = from;
  while (cursor < limit) {
    const found = source.indexOf(marker, cursor);
    if (found === -1 || found >= limit) return -1;
    if (!isEscaped(source, found)) return found;
    cursor = found + marker.length;
  }
  return -1;
};

const hasLineBreak = (value) => value.includes('\n') || value.includes('\r');

const parseRange = (source, from, to, depth) => {
  const tokens = [];
  let plainFrom = from;
  let cursor = from;

  const pushPlain = (until) => {
    if (until > plainFrom) {
      tokens.push({ kind: 'text', from: plainFrom, to: until, text: source.slice(plainFrom, until) });
    }
  };
  const pushMarked = (kind, start, end, innerFrom, innerTo) => {
    const token = {
      kind,
      from: start,
      to: end,
      innerFrom,
      innerTo,
      text: source.slice(innerFrom, innerTo),
    };
    // Emphasis and strong keep their inner tokens so math or code inside them still render. The
    // depth guard stops pathological input from recursing without bound.
    if (depth < MAX_NESTING) token.children = parseRange(source, innerFrom, innerTo, depth + 1);
    tokens.push(token);
  };
  const canNest = depth < MAX_NESTING;

  while (cursor < to) {
    const char = source[cursor];

    // Inline code first: everything inside a backtick run is literal.
    if (char === '`' && !isEscaped(source, cursor)) {
      const length = runLengthAt(source, cursor, to);
      const close = findRunEnd(source, cursor + length, to, '`', length);
      if (close !== -1) {
        pushPlain(cursor);
        tokens.push({
          kind: 'code',
          from: cursor,
          to: close + length,
          innerFrom: cursor + length,
          innerTo: close,
          text: source.slice(cursor + length, close),
        });
        cursor = close + length;
        plainFrom = cursor;
        continue;
      }
    }

    // \\( ... \\)
    if (char === '\\' && source[cursor + 1] === '(' && !isEscaped(source, cursor)) {
      const close = findUnescaped(source, '\\)', cursor + 2, to);
      const content = close === -1 ? '' : source.slice(cursor + 2, close);
      if (close !== -1 && content.trim() && !hasLineBreak(content)) {
        pushPlain(cursor);
        tokens.push({
          kind: 'math',
          from: cursor,
          to: close + 2,
          content: content.trim(),
          delimiter: '\\(',
        });
        cursor = close + 2;
        plainFrom = cursor;
        continue;
      }
    }

    // $ ... $ (never $$, which is display math and cannot appear inside a cell)
    if (char === '$' && !isEscaped(source, cursor) && source[cursor + 1] !== '$') {
      const close = findUnescaped(source, '$', cursor + 1, to);
      const content = close === -1 ? '' : source.slice(cursor + 1, close);
      if (close !== -1 && source[close + 1] !== '$' && content.trim() && !hasLineBreak(content)) {
        pushPlain(cursor);
        tokens.push({
          kind: 'math',
          from: cursor,
          to: close + 1,
          content: content.trim(),
          delimiter: '$',
        });
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
      const close = wordBoundary && opensOnText
        ? findRunEnd(source, cursor + 2, to, marker, 2)
        : -1;
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
      const close = wordBoundary ? findRunEnd(source, cursor + 1, to, char, 1) : -1;
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

  pushPlain(to);
  return tokens;
};

export const parseInlineMarks = (value) => {
  const source = String(value ?? '');
  return parseRange(source, 0, source.length, 0);
};

// True when the cell needs the rendered view: at least one token carries a mark.
export const hasInlineMarks = (value) =>
  parseInlineMarks(value).some((token) => token.kind !== 'text');

export const INLINE_MARK_DELIMITERS = ['*', '_', '`', '$'];
