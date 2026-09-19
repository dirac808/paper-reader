const ignoredTextSelector = [
  ".paper-reader-md-note-anchor",
  ".paper-reader-md-note-layer",
  ".vditor-ir__marker",
  ".vditor-ir__preview",
  ".vditor-toolbar",
  ".vditor-hint",
  "script",
  "style",
].join(", ");

const normalizeWhitespace = (text = "") =>
  String(text).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();

export const createAnnotationTextIndex = (root) => {
  const entries = [];
  let text = "";
  if (!root) return { entries, text };

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!node.textContent || !parent || parent.closest(ignoredTextSelector)) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let node = walker.nextNode();
  while (node) {
    const value = node.textContent || "";
    const start = text.length;
    text += value;
    entries.push({ node, start, end: text.length });
    node = walker.nextNode();
  }
  return { entries, text };
};

const boundaryOffset = (entries, node, offset) => {
  const entry = entries.find((candidate) => candidate.node === node);
  if (!entry) return undefined;
  return entry.start + Math.max(0, Math.min(offset, entry.end - entry.start));
};

const scoreCandidate = (fullText, start, end, annotation) => {
  const prefix = normalizeWhitespace(annotation?.prefixText);
  const suffix = normalizeWhitespace(annotation?.suffixText);
  const before = normalizeWhitespace(
    fullText.slice(Math.max(0, start - Math.max(240, prefix.length * 3)), start),
  );
  const after = normalizeWhitespace(
    fullText.slice(end, end + Math.max(240, suffix.length * 3)),
  );
  let score = 0;
  if (prefix && before.endsWith(prefix)) score += prefix.length;
  if (suffix && after.startsWith(suffix)) score += suffix.length;
  return score;
};

const normalizedTextWithOffsets = (source) => {
  let text = "";
  const starts = [];
  const ends = [];
  let pendingWhitespace = -1;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (/\s|\u00a0/.test(character)) {
      if (text && !text.endsWith(" ") && pendingWhitespace < 0) {
        pendingWhitespace = index;
      }
      continue;
    }
    if (pendingWhitespace >= 0) {
      text += " ";
      starts.push(pendingWhitespace);
      ends.push(index);
      pendingWhitespace = -1;
    }
    text += character;
    starts.push(index);
    ends.push(index + 1);
  }
  return { text, starts, ends };
};

export const findAnnotationTextRange = (fullText, annotation) => {
  const selectedText = String(annotation?.selectedText || "");
  if (!selectedText) return null;

  const storedOffset = Number(annotation?.textOffset);
  if (
    Number.isInteger(storedOffset) &&
    storedOffset >= 0 &&
    fullText.slice(storedOffset, storedOffset + selectedText.length) === selectedText
  ) {
    return { start: storedOffset, end: storedOffset + selectedText.length };
  }

  let best = null;
  let index = fullText.indexOf(selectedText);
  while (index >= 0) {
    const candidate = {
      start: index,
      end: index + selectedText.length,
      score: scoreCandidate(fullText, index, index + selectedText.length, annotation),
    };
    if (!best || candidate.score > best.score) best = candidate;
    index = fullText.indexOf(selectedText, index + Math.max(1, selectedText.length));
  }
  if (best) return { start: best.start, end: best.end };

  const normalizedSelection = normalizeWhitespace(selectedText);
  if (!normalizedSelection) return null;
  const normalized = normalizedTextWithOffsets(fullText);
  index = normalized.text.indexOf(normalizedSelection);
  while (index >= 0) {
    const start = normalized.starts[index];
    const end = normalized.ends[index + normalizedSelection.length - 1];
    const candidate = {
      start,
      end,
      score: scoreCandidate(fullText, start, end, annotation),
    };
    if (!best || candidate.score > best.score) best = candidate;
    index = normalized.text.indexOf(
      normalizedSelection,
      index + Math.max(1, normalizedSelection.length),
    );
  }
  return best ? { start: best.start, end: best.end } : null;
};

export const createSelectionAnnotation = (selection, root, contextSize = 80) => {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed || !root) {
    return null;
  }
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
    return null;
  }

  const index = createAnnotationTextIndex(root);
  let start = boundaryOffset(index.entries, range.startContainer, range.startOffset);
  let end = boundaryOffset(index.entries, range.endContainer, range.endOffset);

  if (start === undefined || end === undefined) {
    const fallback = findAnnotationTextRange(index.text, {
      selectedText: selection.toString(),
    });
    if (!fallback) return null;
    start = fallback.start;
    end = fallback.end;
  }

  const rawSelection = index.text.slice(start, end);
  const leadingWhitespace = rawSelection.length - rawSelection.trimStart().length;
  const trailingWhitespace = rawSelection.length - rawSelection.trimEnd().length;
  start += leadingWhitespace;
  end -= trailingWhitespace;
  if (end <= start) return null;

  return {
    selectedText: index.text.slice(start, end),
    prefixText: index.text.slice(Math.max(0, start - contextSize), start),
    suffixText: index.text.slice(end, end + contextSize),
    textOffset: start,
  };
};

const entryForOffset = (entries, offset, preferPrevious = false) => {
  let low = 0;
  let high = entries.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const entry = entries[middle];
    if (offset < entry.start || (offset === entry.start && preferPrevious && middle > 0)) {
      high = middle - 1;
    } else if (offset > entry.end || (offset === entry.end && !preferPrevious && middle < entries.length - 1)) {
      low = middle + 1;
    } else {
      return entry;
    }
  }
  return null;
};

export const createAnnotationDomRange = (entries, start, end) => {
  if (end <= start) return null;
  const startEntry = entryForOffset(entries, start, false);
  const endEntry = entryForOffset(entries, end, true);
  if (!startEntry || !endEntry) return null;
  const range = document.createRange();
  range.setStart(startEntry.node, Math.min(start - startEntry.start, startEntry.end - startEntry.start));
  range.setEnd(endEntry.node, Math.min(end - endEntry.start, endEntry.end - endEntry.start));
  return range;
};
