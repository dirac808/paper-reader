import { EditorState, Prec, StateEffect, StateField } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  keymap,
  ViewPlugin,
  WidgetType,
} from '@codemirror/view';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  redo,
  undo,
} from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import {
  defaultHighlightStyle,
  ensureSyntaxTree,
  syntaxHighlighting,
  syntaxTree,
  syntaxTreeAvailable,
} from '@codemirror/language';
import { openSearchPanel, search, searchKeymap } from '@codemirror/search';
import katex from 'katex';

const handler = window.handler;
let cursorDiagnosticActive = false;
let cursorDiagnosticRecords = [];
const cursorDiagnosticLimit = 500;
const diagnosticSelection = () => {
  if (!view) return null;
  const selection = view.state.selection.main;
  return { from: selection.from, to: selection.to, head: selection.head, anchor: selection.anchor };
};
const diagnosticRecord = (record) => {
  if (!cursorDiagnosticActive) return;
  cursorDiagnosticRecords.push({
    time: Number(performance.now().toFixed(2)),
    ...record,
    selection: diagnosticSelection(),
  });
  if (cursorDiagnosticRecords.length > cursorDiagnosticLimit) {
    cursorDiagnosticRecords.splice(0, cursorDiagnosticRecords.length - cursorDiagnosticLimit);
  }
};
const mathGlyphHitMaps = new WeakMap();
const measureMathGlyphHitMap = (node, glyphs) => {
  const origin = node.getBoundingClientRect();
  const rects = (glyphs || []).filter((glyph) => glyph.source).flatMap((glyph) => {
    const range = document.createRange();
    range.setStart(glyph.node, glyph.offset);
    range.setEnd(glyph.node, glyph.offset + 1);
    const rect = range.getBoundingClientRect();
    if (!rect.width || !rect.height) return [];
    return [{
      source: glyph.source,
      rect: {
        left: rect.left - origin.left,
        right: rect.right - origin.left,
        top: rect.top - origin.top,
        bottom: rect.bottom - origin.top,
        width: rect.width,
        height: rect.height,
      },
    }];
  });
  return { rects, width: origin.width, height: origin.height };
};
const diagnosticElement = (node) => {
  if (!(node instanceof Element)) return null;
  const block = node.closest(
    '.paper-reader-cm-math, .paper-reader-cm-inline-math, .paper-reader-cm-image, ' +
    '.paper-reader-cm-table, .paper-reader-cm-code-block, .paper-reader-cm-script',
  );
  const rect = node.getBoundingClientRect();
  return {
    tag: node.tagName,
    className: typeof node.className === 'string' ? node.className.slice(0, 160) : '',
    text: (node.textContent || '').slice(0, 100),
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    block: block ? {
      className: typeof block.className === 'string' ? block.className : '',
      from: Number(block.dataset.from),
      to: Number(block.dataset.to),
      source: (block.dataset.source || '').slice(0, 240),
    } : null,
  };
};
const diagnosticEvent = (event, phase) => {
  if (!cursorDiagnosticActive) return;
  const target = event.target;
  const result = {
    kind: 'dom-event', phase, type: event.type, isTrusted: event.isTrusted,
    button: event.button, buttons: event.buttons,
    pointerType: event.pointerType || null,
    clientX: Number(event.clientX.toFixed(2)), clientY: Number(event.clientY.toFixed(2)),
    eventPhase: event.eventPhase,
    defaultPrevented: event.defaultPrevented,
    activeElement: diagnosticElement(document.activeElement),
    target: diagnosticElement(target),
    path: event.composedPath().slice(0, 8).map((item) =>
      item instanceof Element ? `${item.tagName.toLowerCase()}${item.id ? `#${item.id}` : ''}.${String(item.className || '').split(/\s+/).slice(0, 2).join('.')}` : item?.constructor?.name,
    ),
  };
  if (view && Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
    result.posAtCoords = view.posAtCoords({ x: event.clientX, y: event.clientY }, -1);
    result.sourcePositionAtPoint = sourcePositionAtPoint(view, event);
  }
  diagnosticRecord(result);
  if (phase === 'capture') {
    for (const delay of [0, 16, 80]) {
      setTimeout(() => diagnosticRecord({
        kind: 'after-event', eventType: event.type, delayMs: delay,
        point: { x: event.clientX, y: event.clientY },
        target: diagnosticElement(target),
        activeElement: diagnosticElement(document.activeElement),
        editingBlock: view?.state.field(documentBlockPreview).editingBlock || null,
      }), delay);
    }
  }
};
const performanceStats = {
  updates: 0,
  documentChanges: 0,
  visibleScanChars: 0,
  renderedWidgets: 0,
  blockScanMs: 0,
  maxBlockScanMs: 0,
  parseMs: 0,
  maxParseMs: 0,
  documentBlockTypes: {},
  selectionFrom: 0,
  selectionTo: 0,
  selectionText: '',
  lastUpdateMs: 0,
  maxUpdateMs: 0,
  parseSamples: [],
  blockScanSamples: [],
  updateSamples: [],
  pointerSamples: [],
  fullSourceScans: 0,
  mathMapBuilds: 0,
  mathMapCacheHits: 0,
  lastBlockScanRanges: [],
};
const recordSample = (samples, value) => {
  samples.push(Number(value.toFixed(2)));
  if (samples.length > 256) samples.shift();
};
const percentile = (samples, fraction) => {
  if (!samples.length) return 0;
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
};
Object.defineProperties(performanceStats, {
  latency: { get: () => ({
    parseP50: percentile(performanceStats.parseSamples, 0.5),
    parseP95: percentile(performanceStats.parseSamples, 0.95),
    blockScanP50: percentile(performanceStats.blockScanSamples, 0.5),
    blockScanP95: percentile(performanceStats.blockScanSamples, 0.95),
    updateP50: percentile(performanceStats.updateSamples, 0.5),
    updateP95: percentile(performanceStats.updateSamples, 0.95),
    pointerP95: percentile(performanceStats.pointerSamples, 0.95),
  }) },
});
window.paperReaderMarkdownPerformance = performanceStats;
Object.defineProperty(performanceStats, 'documentText', {
  get: () => view?.state.doc.toString() || '',
});
Object.defineProperty(performanceStats, 'documentBlocks', {
  get: () => view?.state.field(documentBlockPreview).blocks.map((block) => ({
    type: block.type,
    from: block.from,
    to: block.to,
  })) || [],
});
Object.defineProperty(performanceStats, 'editingBlock', {
  get: () => view?.state.field(documentBlockPreview).editingBlock || null,
});
Object.defineProperty(performanceStats, 'resetEditingBlock', {
  value: () => {
    if (!view) return;
    view.dispatch({
      selection: { anchor: 0 },
      effects: editingBlockUpdate.of(null),
    });
  },
});
Object.defineProperty(performanceStats, 'scrollToPosition', {
  value: (position) => {
    if (!view) return;
    view.dispatch({
      effects: EditorView.scrollIntoView(position, { y: 'center', x: 'center' }),
    });
    return new Promise((resolve) => {
      const settle = (attempt) => {
        if (!view || attempt > 24) {
          resolve();
          return;
        }
      const editorView = view;
      const coords = editorView.coordsAtPos(position);
      const scroller = editorView.scrollDOM;
      const rect = scroller.getBoundingClientRect();
      if (!coords) {
        requestAnimationFrame(() => settle(attempt + 1));
        return;
      }
      const verticalTarget = rect.top + scroller.clientHeight / 2;
      const verticalCenter = (coords.top + coords.bottom) / 2;
      const horizontalTarget = rect.left + scroller.clientWidth / 2;
      const horizontalCenter = (coords.left + coords.right) / 2;
      const deltaY = verticalCenter - verticalTarget;
      const deltaX = horizontalCenter - horizontalTarget;
      if (Math.abs(deltaY) > 2) scroller.scrollTop += deltaY;
      if (Math.abs(deltaX) > 2) scroller.scrollLeft += deltaX;
      // Widget measurements can change the target coordinates several frames
      // after it first enters the viewport. Keep settling briefly even when
      // the current frame already looks centered.
      if (attempt < 18 || Math.abs(deltaY) > 2 || Math.abs(deltaX) > 2) {
        requestAnimationFrame(() => settle(attempt + 1));
      } else {
        resolve();
      }
      };
      requestAnimationFrame(() => settle(0));
    });
  },
});
Object.defineProperty(performanceStats, 'pointForPosition', {
  value: (position) => {
    if (!view || !Number.isInteger(position) || position < 0 || position > view.state.doc.length) {
      return null;
    }
    const coords = view.coordsAtPos(position);
    if (!coords) return null;
    const y = (coords.top + coords.bottom) / 2;
    const left = Math.min(coords.left, coords.right);
    const right = Math.max(coords.left, coords.right);
    const center = (left + right) / 2;
    const candidates = [left, right, center];
    for (let distance = 0.25; distance <= 3; distance += 0.25) {
      candidates.push(left - distance, right + distance);
    }
    for (const x of candidates) {
      const resolved = sourcePositionAtPoint(view, { clientX: x, clientY: y });
      if (resolved === position) {
        return { x, y, expected: position, resolved, coords };
      }
    }
    return {
      x: center,
      y,
      expected: position,
      resolved: sourcePositionAtPoint(view, { clientX: center, clientY: y }),
      coords,
    };
  },
});
const noteUpdate = StateEffect.define();
const editingBlockUpdate = StateEffect.define();
const blockIndexRefresh = StateEffect.define();
const noteState = StateField.define({
  create: () => [],
  update(value, transaction) {
    let next = value;
    if (transaction.docChanged) {
      next = next.map((item) => ({
        ...item,
        from: transaction.changes.mapPos(item.from, 1),
        to: transaction.changes.mapPos(item.to, -1),
      }));
    }
    for (const effect of transaction.effects) {
      if (effect.is(noteUpdate)) next = effect.value || [];
    }
    return next;
  },
});

const normalizeDisplayMathDelimiters = (markdownText = '') =>
  String(markdownText)
    .replace(/\r\n|\r/g, '\n')
    .replace(
      /(^|\n)([ \t]*)\\\[\s*\n([\s\S]*?)\n[ \t]*\\\]([ \t]*(?=\n|$))/g,
      (_match, start, indent, body, suffix) =>
        `${start}${indent}$$\n${body.trim()}\n${indent}$$${suffix}`,
    )
    .replace(
      /(^|\n)([ \t]*)\\\[\s*([^\n]*?)\s*\\\]([ \t]*(?=\n|$))/g,
      (_match, start, indent, body, suffix) =>
        `${start}${indent}$$\n${body.trim()}\n${indent}$$${suffix}`,
    );

const computeMinimalTextChange = (current, next) => {
  if (current === next) return null;
  const sharedLimit = Math.min(current.length, next.length);
  let start = 0;
  while (start < sharedLimit && current.charCodeAt(start) === next.charCodeAt(start)) {
    start += 1;
  }
  let currentEnd = current.length;
  let nextEnd = next.length;
  while (
    currentEnd > start &&
    nextEnd > start &&
    current.charCodeAt(currentEnd - 1) === next.charCodeAt(nextEnd - 1)
  ) {
    currentEnd -= 1;
    nextEnd -= 1;
  }
  return {
    from: start,
    to: currentEnd,
    insert: next.slice(start, nextEnd),
  };
};

const selectedText = (view) => {
  const range = view.state.selection.main;
  if (range.empty) return '';
  return view.state.sliceDoc(range.from, range.to).trim();
};

const selectionAnchor = (view) => {
  const range = view.state.selection.main;
  const text = selectedText(view);
  if (range.empty || !text) return null;
  const source = view.state.doc.toString();
  return {
    selectedText: text,
    prefixText: source.slice(Math.max(0, range.from - 80), range.from),
    suffixText: source.slice(range.to, range.to + 80),
    textOffset: range.from,
  };
};

const mathPattern = /(?:^|\n)[ \t]*(\$\$|\\\[)[ \t]*\n?([\s\S]*?)(?:\n[ \t]*)?(\$\$|\\\])(?=\n|$)/g;
const imagePattern = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
const inlineMathPattern = /(^|[^\\$])\$(?!\$)([^\n$]+?)(?<!\\)\$(?!\$)/g;
const superscriptPattern = /<(sup|sub)>([^<\n]*)<\/(sup|sub)>/gi;
const imageSizeCache = new Map();
let imageBasePath = '';

const resolveImageSource = (source) => {
  if (!source || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(source)) return source;
  if (!imageBasePath) return source;
  try {
    return new URL(source, imageBasePath).toString();
  } catch {
    return source;
  }
};

const splitTableRow = (text) => {
  let row = text.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
};

const tableAlignment = (cell) => {
  const value = cell.trim();
  return value.startsWith(':') && value.endsWith(':')
    ? 'center'
    : value.endsWith(':')
      ? 'right'
      : value.startsWith(':')
        ? 'left'
        : null;
};

const isTableDivider = (text) => {
  const cells = splitTableRow(text);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
};

const syntaxNodesByName = (tree, from, to) => {
  const groups = new Map([
    ['FencedCode', []], ['Table', []], ['InlineCode', []],
    ['Blockquote', []], ['Image', []],
  ]);
  tree.iterate({ from, to, enter(node) {
    const group = groups.get(node.name);
    if (group) group.push({ name: node.name, from: node.from, to: node.to });
  } });
  return groups;
};

const rangeContains = (ranges, from, to = from) =>
  ranges.some((range) => from >= range.from && to <= range.to);

const findOverlappingBlock = (blocks, from, to = from) => {
  let low = 0;
  let high = blocks.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (blocks[middle].from <= to) low = middle + 1;
    else high = middle;
  }
  for (let index = low - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block.to < from) break;
    if (block.from <= to && block.to >= from) return block;
  }
  return null;
};

const isInsideAnyBlock = (blocks, from, to) => Boolean(findOverlappingBlock(blocks, from, to));

const sourceLines = (state, from, to) => {
  const first = state.doc.lineAt(from);
  const last = state.doc.lineAt(Math.max(from, to - 1));
  const lines = [];
  for (let number = first.number; number <= last.number; number += 1) {
    lines.push(state.doc.line(number));
  }
  return lines;
};

const parseTableNode = (state, node) => {
  const lines = sourceLines(state, node.from, node.to);
  if (lines.length < 2) return null;
  const headers = splitTableRow(lines[0].text);
  const divider = splitTableRow(lines[1].text);
  if (headers.length < 2 || divider.length !== headers.length ||
    !isTableDivider(lines[1].text)) return null;
  const rows = [];
  for (const line of lines.slice(2)) {
    if (!line.text.trim() || !line.text.includes('|')) break;
    const cells = splitTableRow(line.text);
    if (cells.length !== headers.length) break;
    rows.push(cells);
  }
  return {
    type: 'table',
    from: lines[0].from,
    to: lines[lines.length - 1].to,
    headers,
    alignments: divider.map(tableAlignment),
    rows,
  };
};

const parseFencedCodeNode = (state, node) => {
  const raw = state.doc.sliceString(node.from, node.to);
  const lines = raw.split('\n');
  const opening = lines.shift() || '';
  if (lines.length && /^(?:`{3,}|~{3,})/.test(lines[lines.length - 1])) lines.pop();
  const marker = /^(?:`{3,}|~{3,})([^\s]*)/.exec(opening);
  return {
    type: 'code',
    from: node.from,
    to: node.to,
    source: lines.join('\n'),
    language: marker?.[1] || '',
  };
};

const visibleDocumentText = (view) => {
  const ranges = view.visibleRanges;
  if (!ranges.length) return [];
  return ranges.map((range) => {
    const startLine = view.state.doc.lineAt(range.from).from;
    const endLine = view.state.doc.lineAt(range.to).to;
    return {
      from: startLine,
      to: endLine,
      text: view.state.sliceDoc(startLine, endLine),
    };
  });
};

const intersectsSelection = (view, from, to) => {
  const state = view.state || view;
  const selection = state.selection.main;
  if (selection.empty) return selection.from >= from && selection.from <= to;
  return selection.from < to && selection.to > from;
};

const widgetSourceRange = (node, editorView, from, to) => {
  const source = editorView.state.sliceDoc(from, to);
  let start = from;
  let end = to;
  if (node.classList.contains('paper-reader-cm-math')) {
    const opening = /^\s*(?:\$\$|\\\[)[ \t]*(?:\r?\n)?/.exec(source);
    const closing = /(?:\r?\n[ \t]*)?(?:\$\$|\\\])[ \t]*$/.exec(source);
    if (opening) start += opening[0].length;
    if (closing) end -= closing[0].length;
  } else if (node.classList.contains('paper-reader-cm-inline-math')) {
    if (source.startsWith('$')) start += 1;
    if (source.endsWith('$')) end -= 1;
  }
  while (start < end && /\s/.test(editorView.state.sliceDoc(start, start + 1))) {
    start += 1;
  }
  while (end > start && /\s/.test(editorView.state.sliceDoc(end - 1, end))) {
    end -= 1;
  }
  return { start: Math.min(start, to), end: Math.max(start, Math.min(end, to)) };
};

const mathSourceGlyphCache = new Map();
const mathSourceGlyphs = (source, displayMode) => {
  const key = `${displayMode ? 'display' : 'inline'}:${source}`;
  if (mathSourceGlyphCache.has(key)) {
    const cached = mathSourceGlyphCache.get(key);
    mathSourceGlyphCache.delete(key);
    mathSourceGlyphCache.set(key, cached);
    performanceStats.mathMapCacheHits += 1;
    return cached;
  }
  performanceStats.mathMapBuilds += 1;
  let parsed;
  try {
    parsed = katex.__parse(source, {
      displayMode,
      throwOnError: false,
      strict: 'ignore',
    });
  } catch {
    return null;
  }
  const sourceGlyphs = [];
  const seenStarts = new Set();
  let sourceCursor = 0;
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.text === 'string' && Number.isFinite(value.loc?.start) &&
      Number.isFinite(value.loc?.end)) {
      const start = value.loc.start;
      const end = value.loc.end;
      const raw = source.slice(start, end);
      const aliases = value.text === '\\ldots' ? ['\\ldots', '\\dots'] : [value.text];
      const commandStart = raw.startsWith('\\') && !seenStarts.has(start)
        ? start
        : aliases.map((alias) => source.indexOf(alias, sourceCursor))
          .filter((offset) => offset >= 0)
          .sort((left, right) => left - right)[0];
      if (commandStart !== undefined && value.text.startsWith('\\') && !seenStarts.has(commandStart)) {
        const command = aliases.find((alias) => source.startsWith(alias, commandStart));
        if (command) {
          seenStarts.add(commandStart);
          sourceGlyphs.push({ text: value.text, start: commandStart, end: commandStart + command.length });
          sourceCursor = commandStart + command.length;
        }
      } else if (!seenStarts.has(start) && raw.trim() === value.text) {
        seenStarts.add(start);
        sourceGlyphs.push({ text: value.text, start, end });
        sourceCursor = Math.max(sourceCursor, end);
      }
    }
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === 'object' && !child.lexer) visit(child);
    }
  };
  visit(parsed);
  sourceGlyphs.sort((left, right) => left.start - right.start || left.end - right.end);
  if (mathSourceGlyphCache.size >= 128) mathSourceGlyphCache.delete(mathSourceGlyphCache.keys().next().value);
  mathSourceGlyphCache.set(key, sourceGlyphs);
  return sourceGlyphs;
};

const mapMathGlyphsToSource = (node, sourceGlyphs) => {
  if (!sourceGlyphs) return null;
  const renderedText = {
    '\\vee': '∨',
    '\\ell': 'ℓ',
    '\\ldots': '…',
    '\\rangle': '⟩',
    '\\geq': '≥',
    '\\sum': '∑',
  };

  const rendered = [];
  const walker = document.createTreeWalker(
    node.querySelector('.katex-html'),
    NodeFilter.SHOW_TEXT,
  );
  let textNode;
  while ((textNode = walker.nextNode())) {
    for (let offset = 0; offset < textNode.data.length; offset += 1) {
      rendered.push({ node: textNode, offset, text: textNode.data[offset], source: null });
    }
  }
  const sourceCharacters = sourceGlyphs.flatMap((glyph) =>
    [...(renderedText[glyph.text] || glyph.text)].map((text) => ({
      text,
      source: { start: glyph.start, end: glyph.end },
    })));
  if (sourceCharacters.length * rendered.length > 2000000) {
    let renderedIndex = 0;
    for (const character of sourceCharacters) {
      while (renderedIndex < rendered.length && rendered[renderedIndex].text !== character.text) {
        renderedIndex += 1;
      }
      if (renderedIndex < rendered.length) {
        rendered[renderedIndex].source = character.source;
        renderedIndex += 1;
      }
    }
    return rendered;
  }
  const scores = Array.from(
    { length: sourceCharacters.length + 1 },
    () => new Uint16Array(rendered.length + 1),
  );
  for (let sourceIndex = sourceCharacters.length - 1; sourceIndex >= 0; sourceIndex -= 1) {
    for (let renderedIndex = rendered.length - 1; renderedIndex >= 0; renderedIndex -= 1) {
      scores[sourceIndex][renderedIndex] = sourceCharacters[sourceIndex].text === rendered[renderedIndex].text
        ? scores[sourceIndex + 1][renderedIndex + 1] + 1
        : Math.max(scores[sourceIndex + 1][renderedIndex], scores[sourceIndex][renderedIndex + 1]);
    }
  }
  let sourceIndex = 0;
  let renderedIndex = 0;
  while (sourceIndex < sourceCharacters.length && renderedIndex < rendered.length) {
    if (sourceCharacters[sourceIndex].text === rendered[renderedIndex].text) {
      rendered[renderedIndex].source = sourceCharacters[sourceIndex].source;
      sourceIndex += 1;
      renderedIndex += 1;
    } else if (scores[sourceIndex + 1][renderedIndex] >= scores[sourceIndex][renderedIndex + 1]) {
      sourceIndex += 1;
    } else {
      renderedIndex += 1;
    }
  }
  return rendered;
};

const nearestRenderedTextPosition = (rootNode, event) => {
  if (!rootNode) return null;
  let closest = null;
  const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    for (let offset = 0; offset < node.data.length; offset += 1) {
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + 1);
      const rect = range.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      const dx = event.clientX < rect.left
        ? rect.left - event.clientX
        : event.clientX > rect.right
          ? event.clientX - rect.right
          : 0;
      const dy = event.clientY < rect.top
        ? rect.top - event.clientY
        : event.clientY > rect.bottom
          ? event.clientY - rect.bottom
          : 0;
      const distance = dy * 1000 + dx;
      if (!closest || distance < closest.distance) {
        closest = { node, offset, rect, distance };
      }
    }
  }
  if (!closest) return null;
  return {
    ...closest,
    after: event.clientX >= closest.rect.left + closest.rect.width / 2,
  };
};

const sourcePositionAtPoint = (editorView, event) => {
  let range = document.caretRangeFromPoint?.(event.clientX, event.clientY);
  if (!range && document.caretPositionFromPoint) {
    const caret = document.caretPositionFromPoint(event.clientX, event.clientY);
    if (caret) {
      range = document.createRange();
      range.setStart(caret.offsetNode, caret.offset);
      range.collapse(true);
    }
  }
  if (range && editorView.contentDOM.contains(range.startContainer)) {
    try {
      return editorView.posAtDOM(range.startContainer, range.startOffset, -1);
    } catch {
      // Fall through to CodeMirror coordinate mapping.
    }
  }
  try {
    return editorView.posAtCoords({ x: event.clientX, y: event.clientY }, -1);
  } catch {
    return null;
  }
};

const mapTableCellClick = (node, editorView, event) => {
  const cell = event.target instanceof Element ? event.target.closest('th, td') : null;
  if (!cell || !node.contains(cell)) return null;
  const row = cell.parentElement;
  const rowElement = row?.closest('thead') ? 0 : [...(row?.parentElement?.children || [])].indexOf(row) + 2;
  const cellIndex = [...(row?.children || [])].indexOf(cell);
  const lines = sourceLines(editorView.state, Number(node.dataset.from), Number(node.dataset.to));
  const line = lines[rowElement];
  if (!line || cellIndex < 0) return null;
  const sourceLine = line.text;
  const separators = [];
  for (let index = 0; index < sourceLine.length; index += 1) {
    if (sourceLine[index] === '|' && (index === 0 || sourceLine[index - 1] !== '\\')) {
      separators.push(index);
    }
  }
  const start = separators[cellIndex] === undefined ? 0 : separators[cellIndex] + 1;
  const end = separators[cellIndex + 1] === undefined
    ? sourceLine.length
    : separators[cellIndex + 1];
  const rawCell = sourceLine.slice(start, end);
  const trimStart = rawCell.length - rawCell.trimStart().length;
  const rendered = nearestRenderedTextPosition(cell, event);
  if (!rendered) return line.from + start + trimStart;
  const visiblePrefix = cell.textContent.slice(0, rendered.offset);
  let sourcePrefix = 0;
  for (const character of visiblePrefix) {
    const found = rawCell.indexOf(character, sourcePrefix);
    if (found >= 0) sourcePrefix = found + 1;
  }
  const clicked = rawCell.indexOf(cell.textContent[rendered.offset], sourcePrefix);
  const charOffset = clicked >= 0 ? clicked : sourcePrefix;
  return line.from + start + Math.min(rawCell.length, charOffset + (rendered.after ? 1 : 0));
};

const activateRange = (node, from, to, event) => {
  const started = performance.now();
  const editorView = view || EditorView.findFromDOM(node);
  if (!editorView) return;
  const sourceRange = widgetSourceRange(node, editorView, from, to);
  const isMath = node.classList.contains('paper-reader-cm-math') ||
    node.classList.contains('paper-reader-cm-inline-math');
  const glyphs = isMath ? node.__paperReaderGlyphMap || null : null;
  let closestGlyph = null;
  if (isMath && glyphs) {
    const bounds = node.getBoundingClientRect();
    const hitMap = mathGlyphHitMaps.get(node);
    for (const glyph of hitMap?.rects || []) {
      const origin = bounds;
      const rect = {
        left: origin.left + glyph.rect.left,
        right: origin.left + glyph.rect.right,
        top: origin.top + glyph.rect.top,
        bottom: origin.top + glyph.rect.bottom,
        width: glyph.rect.width,
        height: glyph.rect.height,
      };
      const dx = event.clientX < rect.left
        ? rect.left - event.clientX
        : event.clientX > rect.right
          ? event.clientX - rect.right
        : 0;
      const dy = event.clientY < rect.top
        ? rect.top - event.clientY
        : event.clientY > rect.bottom
          ? event.clientY - rect.bottom
          : 0;
      const distance = dy * 1000 + dx;
      if (!closestGlyph || distance < closestGlyph.distance) {
        closestGlyph = { ...glyph, rect, distance };
      }
    }
  }
  let sourceOffset;
  if (closestGlyph) {
    sourceOffset = sourceRange.start + (event.clientX < closestGlyph.rect.left + closestGlyph.rect.width / 2
      ? closestGlyph.source.start
      : closestGlyph.source.end);
  } else if (node.classList.contains('paper-reader-cm-code-block')) {
    const code = node.querySelector('code');
    const raw = editorView.state.sliceDoc(from, to);
    const opening = /^[^\r\n]*(?:\r?\n)/.exec(raw)?.[0].length || 0;
    const rendered = nearestRenderedTextPosition(code, event);
    sourceOffset = from + opening + (rendered
      ? rendered.offset + (rendered.after ? 1 : 0)
      : 0);
  } else if (node.classList.contains('paper-reader-cm-table')) {
    sourceOffset = mapTableCellClick(node, editorView, event);
  }
  if (!Number.isFinite(sourceOffset)) {
    sourceOffset = editorView.posAtCoords({ x: event.clientX, y: event.clientY }, -1);
  }
  if (!Number.isFinite(sourceOffset)) {
    sourceOffset = Math.round(sourceRange.start + (sourceRange.end - sourceRange.start) * 0.5);
  }
  const anchor = Math.max(sourceRange.start, Math.min(sourceRange.end, sourceOffset));
  diagnosticRecord({
    kind: 'widget-hit-test',
    block: { type: node.className, from, to, source: (node.dataset.source || '').slice(0, 240) },
    point: { x: event.clientX, y: event.clientY },
    sourceRange,
    mappedOffset: sourceOffset,
    dispatchedAnchor: anchor,
    glyph: closestGlyph ? {
      text: closestGlyph.text,
      source: closestGlyph.source,
      rect: {
        x: closestGlyph.rect.x,
        y: closestGlyph.rect.y,
        width: closestGlyph.rect.width,
        height: closestGlyph.rect.height,
      },
    } : null,
    fallbackPosAtCoords: editorView.posAtCoords({ x: event.clientX, y: event.clientY }, -1),
  });
  editorView.dispatch({
    effects: editingBlockUpdate.of({ from, to }),
    selection: { anchor },
    scrollIntoView: true,
  });
  performanceStats.lastWidgetActivation = {
    from,
    to,
    anchor,
    sourceRange,
    clickedGlyph: closestGlyph?.text || null,
    clickedSource: closestGlyph?.source || null,
    sourceOffset,
    selectionFrom: editorView.state.selection.main.from,
  };
  diagnosticRecord({ kind: 'widget-dispatched', dispatchedAnchor: anchor });
  editorView.focus();
  const elapsed = performance.now() - started;
  recordSample(performanceStats.pointerSamples, elapsed);
  performanceStats.lastPointerMs = elapsed;
};

const bindWidgetActivation = (node, from, to) => {
  node.dataset.from = String(from);
  node.dataset.to = String(to);
};

class MathWidget extends WidgetType {
  constructor(source, from, to, displayMode = true) {
    super();
    this.source = source;
    this.from = from;
    this.to = to;
    this.displayMode = displayMode;
  }

  eq(other) {
    return other.source === this.source &&
      other.displayMode === this.displayMode &&
      other.from === this.from &&
      other.to === this.to;
  }

  get estimatedHeight() {
    if (!this.displayMode) return -1;
    const rows = (this.source.match(/\\\\/g) || []).length +
      (this.source.match(/\\begin\s*\{(?:array|aligned|split|gathered|cases)/g) || []).length;
    const sourceLines = this.source.split(/\r?\n/).length;
    return Math.max(72, Math.min(1400, 52 + rows * 24 + sourceLines * 18));
  }

  toDOM() {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = this.displayMode
      ? 'paper-reader-cm-math'
      : 'paper-reader-cm-inline-math';
    node.dataset.source = this.source;
    node.dataset.from = String(this.from);
    node.dataset.to = String(this.to);
    if (this.displayMode && /\\tag\*?\s*\{/.test(this.source)) {
      node.classList.add('paper-reader-cm-math--tagged');
    }
    node.title = 'Click to edit Markdown formula';
    node.setAttribute('aria-label', 'Edit formula source');
    try {
      node.innerHTML = katex.renderToString(this.source, {
        displayMode: this.displayMode,
        throwOnError: false,
        strict: 'ignore',
      });
    } catch {
      const fallback = document.createElement('code');
      fallback.textContent = this.source;
      node.appendChild(fallback);
    }
    if (node.querySelector('.katex-html')) {
      node.__paperReaderGlyphMap = mapMathGlyphsToSource(
        node,
        mathSourceGlyphs(this.source, this.displayMode),
      );
      const prepareHitMap = () => {
        if (node.isConnected && !mathGlyphHitMaps.has(node)) {
          mathGlyphHitMaps.set(
            node,
            measureMathGlyphHitMap(node, node.__paperReaderGlyphMap),
          );
        }
      };
      requestAnimationFrame(() => requestAnimationFrame(prepareHitMap));
    }
    bindWidgetActivation(node, this.from, this.to);
    return node;
  }

  ignoreEvent() {
    return true;
  }
}

class ScriptWidget extends WidgetType {
  constructor(kind, text, from, to) {
    super();
    this.kind = kind;
    this.text = text;
    this.from = from;
    this.to = to;
  }

  eq(other) {
    return other.kind === this.kind &&
      other.text === this.text &&
      other.from === this.from &&
      other.to === this.to;
  }

  toDOM() {
    const node = document.createElement(this.kind);
    node.className = 'paper-reader-cm-script';
    node.textContent = this.text;
    node.title = '点击编辑上标/下标源码';
    bindWidgetActivation(node, this.from, this.to);
    return node;
  }

  ignoreEvent() {
    return true;
  }
}

class CodeBlockWidget extends WidgetType {
  constructor(source, language, from, to) {
    super();
    this.source = source;
    this.language = language;
    this.from = from;
    this.to = to;
  }

  eq(other) {
    return other.source === this.source &&
      other.language === this.language &&
      other.from === this.from &&
      other.to === this.to;
  }

  get estimatedHeight() {
    return Math.max(48, Math.min(480, this.source.split('\n').length * 20 + 20));
  }

  toDOM() {
    const node = document.createElement('pre');
    node.className = 'paper-reader-cm-code-block';
    const code = document.createElement('code');
    if (this.language) code.className = `language-${this.language}`;
    code.textContent = this.source;
    node.appendChild(code);
    node.title = '点击编辑代码块';
    bindWidgetActivation(node, this.from, this.to);
    return node;
  }

  ignoreEvent() {
    return true;
  }
}

class TableWidget extends WidgetType {
  constructor(headers, alignments, rows, from, to) {
    super();
    this.headers = headers;
    this.alignments = alignments;
    this.rows = rows;
    this.from = from;
    this.to = to;
  }

  eq(other) {
    return other.from === this.from &&
      other.to === this.to &&
      JSON.stringify(other.headers) === JSON.stringify(this.headers) &&
      JSON.stringify(other.alignments) === JSON.stringify(this.alignments) &&
      JSON.stringify(other.rows) === JSON.stringify(this.rows);
  }

  get estimatedHeight() {
    return Math.max(72, Math.min(520, (this.rows.length + 1) * 34 + 18));
  }

  toDOM() {
    const node = document.createElement('div');
    node.className = 'paper-reader-cm-table';
    node.title = '点击编辑 Markdown 表格';
    const table = document.createElement('table');
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    this.headers.forEach((header, index) => {
      const cell = document.createElement('th');
      cell.textContent = header;
      if (this.alignments[index]) cell.style.textAlign = this.alignments[index];
      headRow.appendChild(cell);
    });
    head.appendChild(headRow);
    table.appendChild(head);
    const body = document.createElement('tbody');
    this.rows.forEach((row) => {
      const rowElement = document.createElement('tr');
      this.headers.forEach((_header, index) => {
        const cell = document.createElement('td');
        cell.textContent = row[index] || '';
        if (this.alignments[index]) cell.style.textAlign = this.alignments[index];
        rowElement.appendChild(cell);
      });
      body.appendChild(rowElement);
    });
    table.appendChild(body);
    node.appendChild(table);
    bindWidgetActivation(node, this.from, this.to);
    return node;
  }

  ignoreEvent() {
    return true;
  }
}

class ImageWidget extends WidgetType {
  constructor(alt, url, from, to) {
    super();
    this.alt = alt;
    this.url = url;
    this.source = resolveImageSource(url);
    this.from = from;
    this.to = to;
  }

  eq(other) {
    return other.url === this.url &&
      other.source === this.source &&
      other.alt === this.alt &&
      other.from === this.from &&
      other.to === this.to;
  }

  get estimatedHeight() {
    const dimensions = imageSizeCache.get(this.source);
    if (dimensions?.width && dimensions?.height) {
      const contentWidth = Math.max(320, root?.clientWidth ? root.clientWidth - 48 : 900);
      return Math.max(48, Math.min(1200, contentWidth * dimensions.height / dimensions.width));
    }
    return 180;
  }

  toDOM() {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'paper-reader-cm-image';
    node.title = 'Click to edit Markdown image';
    const image = document.createElement('img');
    image.alt = this.alt;
    image.src = this.source;
    node.dataset.source = this.url;
    node.dataset.resolvedSource = this.source;
    image.loading = 'eager';
    image.decoding = 'async';
    image.addEventListener('load', () => {
      if (image.naturalWidth && image.naturalHeight) {
        imageSizeCache.set(this.source, {
          width: image.naturalWidth,
          height: image.naturalHeight,
        });
      }
      view?.requestMeasure();
    }, { once: true });
    image.addEventListener('error', () => view?.requestMeasure(), { once: true });
    node.appendChild(image);
    bindWidgetActivation(node, this.from, this.to);
    return node;
  }

  ignoreEvent() {
    return true;
  }
}

class NoteAnchorWidget extends WidgetType {
  constructor(annotations, open) {
    super();
    this.annotations = annotations;
    this.open = open;
  }

  eq(other) {
    return (
      other.annotations.length === this.annotations.length &&
      other.annotations.every((item, index) => item.id === this.annotations[index].id)
    );
  }

  toDOM() {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'paper-reader-cm-note-anchor';
    const count = this.annotations.length;
    node.title = count === 1 ? 'Open note' : `Open ${count} notes`;
    node.setAttribute('aria-label', node.title);
    const icon = document.createElement('span');
    icon.className = 'codicon codicon-note';
    icon.setAttribute('aria-hidden', 'true');
    node.appendChild(icon);
    if (count > 1) {
      const badge = document.createElement('span');
      badge.className = 'paper-reader-cm-note-count';
      badge.textContent = String(count);
      node.appendChild(badge);
    }
    node.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.open(this.annotations.map((item) => item.id));
    });
    return node;
  }
}

const collectDocumentBlocks = (state, tree, options = {}) => {
  const started = performance.now();
  const ranges = options.ranges || [{ from: 0, to: state.doc.length }];
  performanceStats.lastBlockScanRanges = ranges.map((range) => ({ ...range }));
  if (ranges.length === 1 && ranges[0].from === 0 && ranges[0].to === state.doc.length) {
    performanceStats.fullSourceScans += 1;
  }
  const touchedOldRanges = [];
  options.changes?.iterChangedRanges((fromA, toA) => touchedOldRanges.push({ from: fromA, to: toA }));
  const blocks = options.previousBlocks
    ? options.previousBlocks
      .filter((block) => !touchedOldRanges.some((range) =>
        range.from < block.to && range.to > block.from ||
        range.from === range.to && range.from > block.from && range.from < block.to))
      .map((block) => ({
        ...block,
        from: options.changes.mapPos(block.from, 1),
        to: options.changes.mapPos(block.to, -1),
      }))
    : [];
  const syntax = ranges.map((range) => syntaxNodesByName(tree, range.from, range.to));
  const nodes = (name) => syntax.flatMap((groups) => groups.get(name));
  const codeNodes = nodes('FencedCode');
  const tableNodes = nodes('Table');
  const protectedRanges = [...nodes('InlineCode'), ...nodes('Blockquote'), ...tableNodes, ...codeNodes];

  for (const node of codeNodes) {
    blocks.push(parseFencedCodeNode(state, node));
  }
  for (const node of tableNodes) {
    const table = parseTableNode(state, node);
    if (table) blocks.push(table);
  }

  let match;
  for (const range of ranges) {
    const text = state.doc.sliceString(range.from, range.to);
    mathPattern.lastIndex = 0;
    while ((match = mathPattern.exec(text))) {
      const raw = match[0];
      const from = range.from + match.index + (raw.startsWith('\n') ? 1 : 0);
      const to = range.from + match.index + raw.length;
      const formula = match[2].trim();
      if (formula && !rangeContains(protectedRanges, from, to) && !isInsideAnyBlock(blocks, from, to)) {
        blocks.push({ type: 'math', from, to, source: formula });
      }
    }
  }
  for (const node of nodes('Image')) {
    const raw = state.doc.sliceString(node.from, node.to);
    imagePattern.lastIndex = 0;
    match = imagePattern.exec(raw);
    if (!match) continue;
    blocks.push({
      type: 'image',
      from: node.from,
      to: node.to,
      alt: match[1],
      url: match[2],
    });
  }
  blocks.sort((left, right) => left.from - right.from || left.to - right.to);
  for (const range of ranges) {
    const text = state.doc.sliceString(range.from, range.to);
    inlineMathPattern.lastIndex = 0;
    while ((match = inlineMathPattern.exec(text))) {
      const prefixLength = match[1].length;
      const from = range.from + match.index + prefixLength;
      const to = from + match[0].length - prefixLength;
      if (!rangeContains(protectedRanges, from, to) &&
        !isInsideAnyBlock(blocks, from, to)) {
        blocks.push({ type: 'inlineMath', from, to, source: match[2].trim() });
      }
    }
  }
  performanceStats.blockScanMs = performance.now() - started;
  recordSample(performanceStats.blockScanSamples, performanceStats.blockScanMs);
  performanceStats.maxBlockScanMs = Math.max(
    performanceStats.maxBlockScanMs,
    performanceStats.blockScanMs,
  );
  return blocks.sort((left, right) => left.from - right.from || left.to - right.to);
};

const changedDocumentRanges = (state, changes, previousBlocks, oldDoc) => {
  const rawRanges = [];
  changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    let from = state.doc.lineAt(fromB).from;
    let to = state.doc.lineAt(Math.min(state.doc.length, toB)).to;
    const affectedMath = previousBlocks.find((block) => {
      return block.type === 'math' && (
        fromA < block.to && toA > block.from ||
        fromA === toA && fromA > block.from && fromA < block.to
      );
    });
    if (affectedMath) {
      from = Math.min(from, changes.mapPos(affectedMath.from, 1));
      to = Math.max(to, changes.mapPos(affectedMath.to, -1));
    } else if (/\$\$|\\\[|\\\]/.test(
      `${oldDoc.sliceString(fromA, toA)}${state.doc.sliceString(fromB, toB)}`,
    )) {
      const startLine = state.doc.lineAt(from);
      for (let number = startLine.number; number >= Math.max(1, startLine.number - 200); number -= 1) {
        const line = state.doc.line(number);
        if (/^[ \t]*(?:\$\$|\\\[)[ \t]*$/.test(line.text)) {
          from = line.from;
          break;
        }
      }
      const endLine = state.doc.lineAt(to);
      for (let number = endLine.number; number <= Math.min(state.doc.lines, endLine.number + 200); number += 1) {
        const line = state.doc.line(number);
        if (/^[ \t]*(?:\$\$|\\\])[ \t]*$/.test(line.text)) {
          to = line.to;
          break;
        }
      }
    }
    rawRanges.push({ from: Math.max(0, from - 1), to: Math.min(state.doc.length, to + 1) });
  });
  rawRanges.sort((left, right) => left.from - right.from);
  const merged = [];
  for (const range of rawRanges) {
    const previous = merged[merged.length - 1];
    if (previous && range.from <= previous.to) previous.to = Math.max(previous.to, range.to);
    else merged.push({ ...range });
  }
  return merged;
};

const parseDocument = (state, budget = 8, upto = state.doc.length) => {
  const started = performance.now();
  const tree = ensureSyntaxTree(state, upto, budget) || syntaxTree(state);
  performanceStats.parseMs = performance.now() - started;
  performanceStats.maxParseMs = Math.max(performanceStats.maxParseMs, performanceStats.parseMs);
  recordSample(performanceStats.parseSamples, performanceStats.parseMs);
  return tree;
};

const documentBlockDecoration = (block) => {
  const widget = block.type === 'math'
    ? new MathWidget(block.source, block.from, block.to, true)
    : block.type === 'inlineMath'
      ? new MathWidget(block.source, block.from, block.to, false)
    : block.type === 'code'
      ? new CodeBlockWidget(block.source, block.language, block.from, block.to)
      : block.type === 'table'
        ? new TableWidget(
          block.headers,
          block.alignments,
          block.rows,
          block.from,
          block.to,
        )
        : new ImageWidget(block.alt, block.url, block.from, block.to);
  return Decoration.replace({
    widget,
    block: block.type !== 'inlineMath',
  }).range(block.from, block.to);
};

const shouldPreviewBlock = (state, block, editingBlock) =>
  !intersectsSelection(state, block.from, block.to) &&
  !(editingBlock && block.from === editingBlock.from && block.to === editingBlock.to);

const buildDocumentBlockDecorations = (state, blocks, editingBlock) => {
  const decorations = [];
  for (const block of blocks) {
    if (shouldPreviewBlock(state, block, editingBlock)) {
      decorations.push(documentBlockDecoration(block));
    }
  }
  performanceStats.documentBlocks = blocks.length;
  performanceStats.documentBlockTypes = blocks.reduce((counts, block) => ({
    ...counts,
    [block.type]: (counts[block.type] || 0) + 1,
  }), {});
  return Decoration.set(decorations, true);
};

const updateDocumentBlockDecorations = (state, blocks, editingBlock, previous, ranges) => {
  const relevant = ranges.filter((range) => range.to >= range.from);
  if (!relevant.length) return previous;
  const additions = [];
  for (const block of blocks) {
    if (relevant.some((range) => block.from <= range.to && block.to >= range.from) &&
      shouldPreviewBlock(state, block, editingBlock)) {
      additions.push(documentBlockDecoration(block));
    }
  }
  return previous.update({
    filter(from, to) {
      return !relevant.some((range) => from <= range.to && to >= range.from);
    },
    add: additions,
    sort: true,
  });
};

const documentBlockPreview = StateField.define({
  create(state) {
    const tree = parseDocument(state, 40);
    const blocks = syntaxTreeAvailable(state)
      ? collectDocumentBlocks(state, tree)
      : [];
    return {
      tree,
      blocks,
      editingBlock: null,
      decorations: buildDocumentBlockDecorations(state, blocks, null),
    };
  },
  update(value, transaction) {
    const hasEditEffect = transaction.effects.some((effect) => effect.is(editingBlockUpdate));
    const hasIndexRefresh = transaction.effects.some((effect) => effect.is(blockIndexRefresh));
    if (!transaction.docChanged && !hasEditEffect && !hasIndexRefresh) {
      if (!transaction.selection) return value;
      const oldSelection = transaction.startState.selection.main;
      const newSelection = transaction.state.selection.main;
      if (![oldSelection, newSelection].some((selection) =>
        findOverlappingBlock(value.blocks, selection.from, selection.to)) && !value.editingBlock) return value;
    }
    let { tree, blocks } = value;
    let refreshRanges = [];
    if (transaction.docChanged) {
      const affectedRanges = changedDocumentRanges(
        transaction.state,
        transaction.changes,
        blocks,
        transaction.startState.doc,
      );
      refreshRanges = affectedRanges;
      const parseTo = affectedRanges.reduce((to, range) => Math.max(to, range.to), 0);
      tree = parseDocument(transaction.state, 8, parseTo);
      blocks = collectDocumentBlocks(transaction.state, tree, {
        ranges: affectedRanges,
        previousBlocks: blocks,
        changes: transaction.changes,
      });
    } else if (hasIndexRefresh && syntaxTreeAvailable(transaction.state)) {
      tree = syntaxTree(transaction.state);
      blocks = collectDocumentBlocks(transaction.state, tree);
      refreshRanges = [{ from: 0, to: transaction.state.doc.length }];
    }
    let editingBlock = value.editingBlock;
    if (transaction.docChanged && editingBlock) {
      const from = transaction.changes.mapPos(editingBlock.from, 1);
      const to = transaction.changes.mapPos(editingBlock.to, -1);
      editingBlock = findOverlappingBlock(blocks, from, to);
      if (editingBlock && !(editingBlock.from <= from && editingBlock.to >= to)) editingBlock = null;
    }
    if (editingBlock && transaction.selection && !pointerGesture &&
      (transaction.state.selection.main.to < editingBlock.from ||
        transaction.state.selection.main.from > editingBlock.to)) {
      editingBlock = null;
    }
    for (const effect of transaction.effects) {
      if (effect.is(editingBlockUpdate)) {
        editingBlock = effect.value
          ? findOverlappingBlock(blocks, effect.value.from, effect.value.to)
          : null;
        if (editingBlock && (editingBlock.from !== effect.value.from || editingBlock.to !== effect.value.to)) {
          editingBlock = null;
        }
      }
    }
    if (!editingBlock && transaction.docChanged) {
      const selection = transaction.state.selection.main;
      editingBlock = findOverlappingBlock(blocks, selection.from, selection.to);
      if (editingBlock && !intersectsSelection(transaction.state, editingBlock.from, editingBlock.to)) {
        editingBlock = null;
      }
    }
    if (transaction.selection) {
      for (const selection of [
        transaction.startState.selection.main,
        transaction.state.selection.main,
      ]) {
        const block = findOverlappingBlock(blocks, selection.from, selection.to);
        if (block) refreshRanges.push({ from: block.from, to: block.to });
      }
    }
    if (hasEditEffect) {
      const effect = transaction.effects.find((item) => item.is(editingBlockUpdate));
      const block = effect?.value && findOverlappingBlock(blocks, effect.value.from, effect.value.to);
      if (block) refreshRanges.push({ from: block.from, to: block.to });
      if (value.editingBlock) refreshRanges.push({ from: value.editingBlock.from, to: value.editingBlock.to });
    }
    if (value.editingBlock && editingBlock !== value.editingBlock) {
      refreshRanges.push({ from: value.editingBlock.from, to: value.editingBlock.to });
    }
    if (transaction.docChanged || transaction.selection || hasEditEffect || hasIndexRefresh) {
      return {
        tree,
        blocks,
        editingBlock,
        decorations: updateDocumentBlockDecorations(
          transaction.state,
          blocks,
          editingBlock,
          transaction.docChanged ? value.decorations.map(transaction.changes) : value.decorations,
          refreshRanges,
        ),
      };
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(
    field,
    (value) => value.decorations,
  ),
});

const buildVisibleDecorations = (view) => {
  const started = performance.now();
  const decorations = [];
  performanceStats.selectionFrom = view.state.selection.main.from;
  performanceStats.selectionTo = view.state.selection.main.to;
  performanceStats.selectionText = view.state.sliceDoc(
    view.state.selection.main.from,
    view.state.selection.main.to,
  );
  const visibleRanges = visibleDocumentText(view);
  const documentBlocks = view.state.field(documentBlockPreview).blocks;
  const tree = view.state.field(documentBlockPreview).tree;
  const cursor = view.state.selection.main;
  const inlineAncestors = new Set(['InlineCode', 'Emphasis', 'StrongEmphasis', 'Link']);
  const hiddenSyntax = new Set(['CodeMark', 'EmphasisMark', 'LinkMark', 'URL']);
  const ancestorFor = (node) => {
    let current = tree.resolve(node.from, -1);
    while (current) {
      if (inlineAncestors.has(current.name) || /^ATXHeading[1-6]$/.test(current.name)) {
        return current;
      }
      current = current.parent;
    }
    return null;
  };
  const cursorInside = (node) => node && cursor.from >= node.from && cursor.to <= node.to;

  for (const range of visibleRanges) {
    const firstLine = view.state.doc.lineAt(range.from);
    const lastLine = view.state.doc.lineAt(range.to);
    for (let lineNumber = firstLine.number; lineNumber <= lastLine.number; lineNumber += 1) {
      const line = view.state.doc.line(lineNumber);
      decorations.push(Decoration.line({
        attributes: { 'data-paper-reader-line-from': String(line.from) },
      }).range(line.from));
    }
    tree.iterate({
      from: range.from,
      to: range.to,
      enter(node) {
        if (/^ATXHeading[1-6]$/.test(node.name)) {
          const line = view.state.doc.lineAt(node.from);
          const marker = /^(#{1,6})\s+/.exec(line.text);
          if (!marker) return;
          const level = marker[1].length;
          decorations.push(Decoration.line({
            class: `paper-reader-cm-heading-${level}`,
          }).range(line.from));
          return;
        }
        if (node.name === 'InlineCode') {
          decorations.push(Decoration.mark({
            class: 'paper-reader-cm-inline-code-source',
          }).range(node.from, node.to));
          return;
        }
        if (hiddenSyntax.has(node.name)) {
          const parent = ancestorFor(node);
          if (!cursorInside(parent)) {
            decorations.push(Decoration.mark({
              class: 'paper-reader-cm-mark-hidden',
            }).range(node.from, node.to));
          }
        }
      },
    });

    superscriptPattern.lastIndex = 0;
    let match;
    while ((match = superscriptPattern.exec(range.text))) {
      if (match[1].toLowerCase() !== match[3].toLowerCase()) continue;
      const from = range.from + match.index;
      const to = from + match[0].length;
      if (isInsideAnyBlock(documentBlocks, from, to)) continue;
      if (!cursorInside({ from, to })) {
        decorations.push(Decoration.replace({
          widget: new ScriptWidget(
            match[1].toLowerCase(),
            match[2],
            from,
            to,
          ),
        }).range(from, to));
      }
    }
  }

  const notes = view.state.field(noteState);
  const visibleStart = view.visibleRanges.length ? view.visibleRanges[0].from : 0;
  const visibleEnd = view.visibleRanges.length
    ? view.visibleRanges[view.visibleRanges.length - 1].to
    : 0;
  const groupedNotes = new Map();
  for (const annotation of notes) {
    const key = `${annotation.from}:${annotation.to}`;
    const group = groupedNotes.get(key) || {
      from: annotation.from,
      to: annotation.to,
      annotations: [],
    };
    group.annotations.push(annotation.annotation);
    groupedNotes.set(key, group);
  }
  for (const annotation of groupedNotes.values()) {
    if (annotation.to <= visibleStart || annotation.from >= visibleEnd) {
      continue;
    }
    decorations.push(
      Decoration.mark({ class: 'paper-reader-cm-note-highlight' }).range(
        annotation.from,
        annotation.to,
      ),
    );
    decorations.push(
      Decoration.widget({
        widget: new NoteAnchorWidget(annotation.annotations, (ids) =>
          handler.emit('openMarkdownAnnotationNote', ids),
        ),
        side: 1,
      }).range(annotation.to),
    );
  }
  performanceStats.visibleScanChars = visibleRanges.reduce(
    (total, range) => total + range.text.length,
    0,
  );
  performanceStats.renderedWidgets = decorations.length;
  performanceStats.lastUpdateMs = performance.now() - started;
  recordSample(performanceStats.updateSamples, performanceStats.lastUpdateMs);
  performanceStats.maxUpdateMs = Math.max(
    performanceStats.maxUpdateMs,
    performanceStats.lastUpdateMs,
  );
  return Decoration.set(decorations, true);
};

const livePreview = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.editorView = view;
      this.decorations = buildVisibleDecorations(view);
      this.parseFrame = 0;
      this.cancelParseSchedule = null;
      this.scheduleParseCompletion(view);
    }

    scheduleParseCompletion(view) {
      this.cancelParseSchedule?.();
      if (syntaxTreeAvailable(view.state)) return;
      const run = () => {
        this.cancelParseSchedule = null;
        if (this.destroyed || view !== this.editorView) return;
        ensureSyntaxTree(view.state, view.state.doc.length, 8);
        if (syntaxTreeAvailable(view.state)) {
          view.dispatch({ effects: blockIndexRefresh.of(null) });
        } else {
          this.scheduleParseCompletion(view);
        }
      };
      if (typeof requestIdleCallback === 'function') {
        const handle = requestIdleCallback(run, { timeout: 100 });
        this.cancelParseSchedule = () => cancelIdleCallback(handle);
      } else {
        const handle = setTimeout(run, 20);
        this.cancelParseSchedule = () => clearTimeout(handle);
      }
    }

    update(update) {
      this.editorView = update.view;
      performanceStats.updates += 1;
      if (update.docChanged) performanceStats.documentChanges += 1;
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        update.transactions.some((transaction) =>
          transaction.effects.some(
            (effect) => effect.is(noteUpdate),
          ),
        )
      ) {
        this.decorations = buildVisibleDecorations(update.view);
      }
      if (update.docChanged) this.scheduleParseCompletion(update.view);
    }

    destroy() {
      this.destroyed = true;
      this.cancelParseSchedule?.();
    }
  },
  { decorations: (value) => value.decorations },
);

const root = document.getElementById('paper-reader-editor');
const toolbar = document.getElementById('paper-reader-toolbar');
const outline = document.getElementById('paper-reader-outline');
const menu = document.getElementById('paper-reader-context-menu');
const fontPanel = document.getElementById('paper-reader-font-panel');
const tablePanel = document.getElementById('paper-reader-table-panel');
const defaultFontSizes = { body: 14, inlineMath: 15, displayMath: 18 };
let view;
let pointerGesture = null;
let pendingSelection = null;
let saveTimer = 0;
let outlineTimer = 0;
let fontSaveTimer = 0;
let fontSizes = { ...defaultFontSizes };
let opened = false;

const normalizeFontSizes = (value = {}) => {
  const normalize = (candidate, fallback) => {
    const number = Number(candidate);
    return Number.isFinite(number)
      ? Math.min(32, Math.max(10, Math.round(number)))
      : fallback;
  };
  return {
    body: normalize(value.body, defaultFontSizes.body),
    inlineMath: normalize(value.inlineMath, defaultFontSizes.inlineMath),
    displayMath: normalize(value.displayMath, defaultFontSizes.displayMath),
  };
};

const applyFontSizes = (value) => {
  fontSizes = normalizeFontSizes(value);
  document.documentElement.style.setProperty(
    '--paper-reader-body-font-size',
    `${fontSizes.body}px`,
  );
  document.documentElement.style.setProperty(
    '--paper-reader-inline-math-font-size',
    `${fontSizes.inlineMath}px`,
  );
  document.documentElement.style.setProperty(
    '--paper-reader-display-math-font-size',
    `${fontSizes.displayMath}px`,
  );
  fontPanel?.querySelectorAll('input[data-font-size]').forEach((input) => {
    input.value = String(fontSizes[input.dataset.fontSize]);
  });
  view?.requestMeasure();
};

const saveFontSizes = (immediate = false) => {
  window.clearTimeout(fontSaveTimer);
  const save = () => handler.emit('updateMarkdownFontSizes', fontSizes);
  if (immediate) save();
  else fontSaveTimer = window.setTimeout(save, 250);
};

const setFontPanelVisibility = (visible) => {
  if (!fontPanel) return;
  fontPanel.hidden = !visible;
  toolbar?.querySelector('[data-command="font-sizes"]')?.setAttribute(
    'aria-expanded',
    String(visible),
  );
};

const hideMenu = () => {
  if (menu) menu.hidden = true;
  pendingSelection = null;
};

const showMenu = (event) => {
  if (!view || !menu) return;
  const text = selectedText(view);
  if (!text) return;
  event.preventDefault();
  pendingSelection = {
    text,
    anchor: selectionAnchor(view),
  };
  menu.hidden = false;
  const margin = 4;
  const bounds = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(
    margin,
    Math.min(event.clientX, window.innerWidth - bounds.width - margin),
  )}px`;
  menu.style.top = `${Math.max(
    margin,
    Math.min(event.clientY, window.innerHeight - bounds.height - margin),
  )}px`;
};

const scheduleSave = () => {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    handler.emit('save', normalizeDisplayMathDelimiters(view.state.doc.toString()));
  }, 120);
};

const saveNow = () => {
  if (!view) return;
  window.clearTimeout(saveTimer);
  const content = normalizeDisplayMathDelimiters(view.state.doc.toString());
  handler.emit('doSave', content);
};

const replaceSelection = (prefix, suffix = prefix, placeholder = '') => {
  if (!view) return;
  const range = view.state.selection.main;
  const selected = view.state.sliceDoc(range.from, range.to) || placeholder;
  const insert = `${prefix}${selected}${suffix}`;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: {
      anchor: range.from + prefix.length,
      head: range.from + prefix.length + selected.length,
    },
    scrollIntoView: true,
  });
  view.focus();
};

const prefixSelectedLines = (prefixFactory) => {
  if (!view) return;
  const range = view.state.selection.main;
  const startLine = view.state.doc.lineAt(range.from);
  const endLine = view.state.doc.lineAt(range.to);
  const changes = [];
  for (let number = startLine.number; number <= endLine.number; number += 1) {
    const line = view.state.doc.line(number);
    changes.push({ from: line.from, insert: prefixFactory(number - startLine.number) });
  }
  view.dispatch({ changes, scrollIntoView: true });
  view.focus();
};

const insertBlock = (content, selectionStart, selectionLength = 0) => {
  if (!view) return;
  const range = view.state.selection.main;
  const before = range.from > 0 && view.state.sliceDoc(range.from - 1, range.from) !== '\n'
    ? '\n\n'
    : '';
  const after = range.to < view.state.doc.length &&
    view.state.sliceDoc(range.to, range.to + 1) !== '\n'
    ? '\n\n'
    : '\n';
  const insert = `${before}${content}${after}`;
  const offset = range.from + before.length + selectionStart;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: { anchor: offset, head: offset + selectionLength },
    scrollIntoView: true,
  });
  view.focus();
};

const insertTable = (rows, columns) => {
  const headers = Array.from(
    { length: columns },
    (_value, index) => `Column ${index + 1}`,
  );
  const divider = Array.from({ length: columns }, () => '---');
  const body = Array.from(
    { length: rows },
    () => Array.from({ length: columns }, () => 'Value'),
  );
  const content = [
    `| ${headers.join(' | ')} |`,
    `| ${divider.join(' | ')} |`,
    ...body.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
  insertBlock(content, 2, headers[0].length);
};

const setHeadingLevel = (level) => {
  if (!view) return;
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const current = /^(#{1,6})\s+/.exec(line.text);
  const marker = `${'#'.repeat(level)} `;
  const range = view.state.selection.main;
  const oldMarkerLength = current ? current[0].length : 0;
  const changes = {
    from: line.from,
    to: line.from + oldMarkerLength,
    insert: marker,
  };
  const changeSet = view.state.changes(changes);
  const selection = range.empty
    ? {
      anchor: line.from + marker.length + Math.max(
        0,
        Math.min(line.text.length - oldMarkerLength, range.head - line.from - oldMarkerLength),
      ),
    }
    : {
      anchor: changeSet.mapPos(range.from, 1),
      head: changeSet.mapPos(range.to, -1),
    };
  view.dispatch({
    changes,
    selection,
    scrollIntoView: true,
  });
  view.focus();
};

const cycleHeading = () => {
  if (!view) return;
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const current = /^(#{1,6})\s+/.exec(line.text);
  setHeadingLevel(current ? (current[1].length % 6) + 1 : 1);
};

const renderOutline = () => {
  if (!view || !outline || outline.hidden) return;
  const fragment = document.createDocumentFragment();
  for (let number = 1; number <= view.state.doc.lines; number += 1) {
    const line = view.state.doc.line(number);
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line.text);
    if (!match) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'paper-reader-outline-item';
    button.dataset.level = String(match[1].length);
    button.textContent = match[2].replace(/[*_`~\[\]]/g, '').trim();
    button.title = button.textContent;
    button.addEventListener('click', () => {
      view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
      view.focus();
    });
    fragment.appendChild(button);
  }
  outline.replaceChildren(fragment);
};

const scheduleOutline = () => {
  if (!outline || outline.hidden) return;
  window.clearTimeout(outlineTimer);
  outlineTimer = window.setTimeout(renderOutline, 180);
};

const runToolbarCommand = (command) => {
  if (!view) return;
  switch (command) {
    case 'outline': {
      outline.hidden = !outline.hidden;
      toolbar.querySelector('[data-command="outline"]')?.setAttribute(
        'aria-pressed',
        String(!outline.hidden),
      );
      renderOutline();
      view.requestMeasure();
      break;
    }
    case 'search':
      openSearchPanel(view);
      break;
    case 'undo': undo(view); break;
    case 'redo': redo(view); break;
    case 'heading': cycleHeading(); break;
    case 'underline': replaceSelection('<u>', '</u>', 'text'); break;
    case 'bold': replaceSelection('**', '**', 'text'); break;
    case 'italic': replaceSelection('*', '*', 'text'); break;
    case 'link': replaceSelection('[', '](https://)', 'text'); break;
    case 'unordered-list': prefixSelectedLines(() => '- '); break;
    case 'ordered-list': prefixSelectedLines((index) => `${index + 1}. `); break;
    case 'checklist': prefixSelectedLines(() => '- [ ] '); break;
    case 'inline-code': replaceSelection('`', '`', 'code'); break;
    case 'code-block': insertBlock('```\ncode\n```', 4, 4); break;
    case 'inline-math': replaceSelection('$', '$', 'x'); break;
    case 'table':
      if (tablePanel) {
        tablePanel.hidden = false;
        tablePanel.querySelector('input[data-table-size="rows"]')?.focus();
      }
      break;
    case 'math': insertBlock('$$\nformula\n$$', 3, 7); break;
    case 'image': replaceSelection('![', '](assets/image.png)', 'alt'); break;
    case 'font-sizes':
      setFontPanelVisibility(fontPanel?.hidden ?? true);
      break;
    case 'save': saveNow(); break;
    default: break;
  }
};

toolbar?.addEventListener('click', (event) => {
  const button = event.target instanceof Element
    ? event.target.closest('button[data-command]')
    : null;
  if (button) runToolbarCommand(button.dataset.command);
});

fontPanel?.addEventListener('input', (event) => {
  const input = event.target instanceof HTMLInputElement
    ? event.target.closest('input[data-font-size]')
    : null;
  if (!input || !input.value) return;
  const key = input.dataset.fontSize;
  applyFontSizes({ ...fontSizes, [key]: Number(input.value) });
  saveFontSizes();
});

fontPanel?.addEventListener('click', (event) => {
  const button = event.target instanceof Element
    ? event.target.closest('button[data-font-action]')
    : null;
  if (button?.dataset.fontAction === 'close') {
    setFontPanelVisibility(false);
  } else if (button?.dataset.fontAction === 'reset') {
    applyFontSizes(defaultFontSizes);
    saveFontSizes(true);
  }
});

tablePanel?.addEventListener('click', (event) => {
  const button = event.target instanceof Element
    ? event.target.closest('button[data-table-action]')
    : null;
  if (!button) return;
  if (button.dataset.tableAction === 'close') {
    tablePanel.hidden = true;
    view?.focus();
    return;
  }
  if (button.dataset.tableAction !== 'insert') return;
  const rows = Math.min(50, Math.max(1, Number(
    tablePanel.querySelector('input[data-table-size="rows"]')?.value || 3,
  )));
  const columns = Math.min(20, Math.max(1, Number(
    tablePanel.querySelector('input[data-table-size="columns"]')?.value || 3,
  )));
  insertTable(rows, columns);
  tablePanel.hidden = true;
});

const createView = (payload) => {
  applyFontSizes(payload.config?.fontSizes);
  const shortcut = (command) => () => {
    runToolbarCommand(command);
    return true;
  };
  const extensions = [
    history(),
    search({ top: true }),
    Prec.highest(keymap.of([
      { key: 'Mod-Shift-1', run: () => { setHeadingLevel(1); return true; } },
      { key: 'Mod-Shift-2', run: () => { setHeadingLevel(2); return true; } },
      { key: 'Mod-Shift-3', run: () => { setHeadingLevel(3); return true; } },
      { key: 'Mod-Shift-7', run: shortcut('inline-code') },
      { key: 'Mod-Shift-8', run: shortcut('code-block') },
      { key: 'Mod-Shift-9', run: shortcut('inline-math') },
      { key: 'Mod-Shift-0', run: shortcut('math') },
    ])),
    keymap.of([
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
      indentWithTab,
    ]),
    markdown({ base: markdownLanguage }),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    noteState,
    documentBlockPreview,
    livePreview,
    EditorView.lineWrapping,
    EditorView.updateListener.of((update) => {
      if (cursorDiagnosticActive && update.selectionSet) {
        diagnosticRecord({
          kind: 'selection-transaction',
          oldSelection: {
            from: update.startState.selection.main.from,
            to: update.startState.selection.main.to,
            head: update.startState.selection.main.head,
            anchor: update.startState.selection.main.anchor,
          },
          newSelection: {
            from: update.state.selection.main.from,
            to: update.state.selection.main.to,
            head: update.state.selection.main.head,
            anchor: update.state.selection.main.anchor,
          },
          docChanged: update.docChanged,
          editingBlock: update.state.field(documentBlockPreview).editingBlock,
        });
      }
      if (update.docChanged) {
        scheduleSave();
        scheduleOutline();
      }
    }),
    EditorView.theme({
      '&': { height: '100%', backgroundColor: 'var(--vscode-editor-background)' },
      '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--vscode-editor-font-family)' },
      '.cm-content': { padding: '18px 24px', minHeight: '100%' },
      '.cm-gutters': { backgroundColor: 'var(--vscode-editor-background)', border: 'none' },
      '.cm-line': { maxWidth: '1100px', margin: '0 auto' },
      '.cm-activeLine': { backgroundColor: 'transparent' },
      '.cm-selectionBackground, ::selection': { backgroundColor: 'var(--vscode-editor-selectionBackground)' },
    }),
  ];
  view = new EditorView({
    state: EditorState.create({ doc: normalizeDisplayMathDelimiters(payload.content || ''), extensions }),
    parent: root,
  });
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    window.addEventListener(type, (event) => diagnosticEvent(event, 'capture'), true);
    window.addEventListener(type, (event) => diagnosticEvent(event, 'bubble'), false);
  }
  const beginPointerGesture = (event, pointerId = event.pointerId ?? 'mouse') => {
    const target = event.target instanceof Element ? event.target : null;
    const widgetNode = target?.closest(
      '.paper-reader-cm-math, .paper-reader-cm-inline-math, ' +
      '.paper-reader-cm-image, .paper-reader-cm-table, ' +
      '.paper-reader-cm-code-block, .paper-reader-cm-script',
    );
    const isCompatibilityMouseEvent = event.type === 'mousedown' &&
      pointerGesture && pointerGesture.pointerId !== 'mouse' &&
      Math.abs(event.clientX - pointerGesture.x) <= 1 &&
      Math.abs(event.clientY - pointerGesture.y) <= 1;
    if (!isCompatibilityMouseEvent) {
      pointerGesture = {
        x: event.clientX,
        y: event.clientY,
        dragged: false,
        pointerId,
        // CodeMirror may change decorations during mousedown, before click fires.
        sourcePosition: !widgetNode && event.target instanceof Node && view.contentDOM.contains(event.target)
          ? sourcePositionAtPoint(view, event)
          : null,
        widgetNode,
      };
    }
    if (event.button !== 0) return;
    if (event.type === 'mousedown' && Number.isInteger(pointerGesture.sourcePosition) &&
      !pointerGesture.widgetNode) {
      event.preventDefault();
    }
    const node = pointerGesture.widgetNode;
    if (!node || !view.dom.contains(node)) return;
    const from = Number(node.dataset.from);
    const to = Number(node.dataset.to);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return;
    event.preventDefault();
    event.stopPropagation();
  };
  const updatePointerGesture = (event, pointerId = event.pointerId ?? 'mouse') => {
    if (!pointerGesture || pointerGesture.pointerId !== pointerId) return;
    if (!pointerGesture.dragged &&
      (Math.abs(event.clientX - pointerGesture.x) > 3 ||
        Math.abs(event.clientY - pointerGesture.y) > 3)) {
      pointerGesture.dragged = true;
    }
    if (!pointerGesture.dragged || !Number.isInteger(pointerGesture.sourcePosition)) return;
    const head = sourcePositionAtPoint(view, event);
    if (!Number.isInteger(head)) return;
    pointerGesture.selectionHead = head;
    view.dispatch({
      selection: { anchor: pointerGesture.sourcePosition, head },
      scrollIntoView: false,
    });
  };
  const finishPointerGesture = (event) => {
    if (!pointerGesture?.dragged) {
      const gesture = pointerGesture;
      setTimeout(() => {
        if (pointerGesture === gesture) pointerGesture = null;
      }, 500);
      return;
    }
    if (Number.isInteger(pointerGesture.sourcePosition) && event) {
      const head = sourcePositionAtPoint(view, event);
      if (Number.isInteger(head)) {
        pointerGesture.selectionHead = head;
        view.dispatch({
          selection: { anchor: pointerGesture.sourcePosition, head },
          scrollIntoView: false,
        });
      }
    }
    setTimeout(() => {
      pointerGesture = null;
      const editingBlock = view?.state.field(documentBlockPreview).editingBlock;
      const selection = view?.state.selection.main;
      if (editingBlock && selection &&
        (selection.to < editingBlock.from || selection.from > editingBlock.to)) {
        view.dispatch({ effects: editingBlockUpdate.of(null) });
      }
    }, 0);
  };
  view.dom.addEventListener('pointerdown', (event) => beginPointerGesture(event), true);
  view.dom.addEventListener('mousedown', (event) => beginPointerGesture(event, 'mouse'), true);
  view.dom.addEventListener('pointermove', (event) => updatePointerGesture(event), true);
  view.dom.addEventListener('mousemove', (event) => updatePointerGesture(event, 'mouse'), true);
  view.dom.addEventListener('pointerup', finishPointerGesture, true);
  view.dom.addEventListener('mouseup', finishPointerGesture, true);
  view.dom.addEventListener('pointercancel', () => { pointerGesture = null; }, true);
  view.dom.addEventListener('click', (event) => {
    if (event.button !== 0 || !(event.target instanceof Element)) return;
    // A source mousedown can be retargeted to a freshly mounted preview widget
    // before click dispatch. The frozen source position owns that gesture.
    if (Number.isInteger(pointerGesture?.sourcePosition)) return;
    const node = pointerGesture?.widgetNode || null;
    if (!node || !view.dom.contains(node)) return;
    const from = Number(node.dataset.from);
    const to = Number(node.dataset.to);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    pointerGesture = null;
    activateRange(node, from, to, event);
  }, true);
  view.dom.addEventListener('click', (event) => {
    const dragged = pointerGesture?.dragged || false;
    const pointerPosition = pointerGesture?.sourcePosition;
    pointerGesture = null;
    if (dragged || (!Number.isInteger(pointerPosition) && !view.contentDOM.contains(event.target))) {
      return;
    }
    const started = performance.now();
    const position = Number.isInteger(pointerPosition)
      ? pointerPosition
      : sourcePositionAtPoint(view, event);
    if (position === null) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    view.dispatch({ selection: { anchor: position }, scrollIntoView: false });
    view.focus();
    const elapsed = performance.now() - started;
    recordSample(performanceStats.pointerSamples, elapsed);
    performanceStats.lastPointerMs = elapsed;
  }, true);
  view.dom.addEventListener('contextmenu', showMenu);
  document.addEventListener('click', (event) => {
    if (!menu?.contains(event.target)) hideMenu();
    const target = event.target instanceof Element ? event.target : null;
    if (
      !fontPanel?.hidden &&
      !fontPanel?.contains(target) &&
      !target?.closest('[data-command="font-sizes"]')
    ) {
      setFontPanelVisibility(false);
    }
  });
  opened = true;
};

const sendSelectionToCodex = () => {
  if (!pendingSelection?.text) return;
  handler.emit('sendSelectionToCodex', pendingSelection.text);
  hideMenu();
};

const addSelectionToNotes = () => {
  if (!pendingSelection?.anchor) return;
  handler.emit('addSelectionToNotes', pendingSelection.anchor);
  hideMenu();
};

document.querySelector('[data-action="sendSelectionToCodex"]')?.addEventListener('click', sendSelectionToCodex);
document.querySelector('[data-action="addSelectionToNotes"]')?.addEventListener('click', addSelectionToNotes);

handler.on('open', (payload) => {
  imageBasePath = String(payload?.documentBasePath || document.baseURI || '');
  if (!opened) createView(payload);
  handler.emit('loadMarkdownAnnotations');
});
handler.on('cursorDiagnosticStart', () => {
  cursorDiagnosticRecords = [];
  cursorDiagnosticActive = true;
  diagnosticRecord({
    kind: 'started', userAgent: navigator.userAgent,
    docLength: view?.state.doc.length,
    selection: diagnosticSelection(),
  });
  handler.emit('cursorDiagnosticStarted');
});
handler.on('cursorDiagnosticStop', () => {
  if (!cursorDiagnosticActive) return;
  diagnosticRecord({ kind: 'stopped', selection: diagnosticSelection() });
  cursorDiagnosticActive = false;
  handler.emit('cursorDiagnosticLog', cursorDiagnosticRecords);
  cursorDiagnosticRecords = [];
});
handler.on('update', (content) => {
  if (!view || view.state.doc.toString() === content) return;
  const next = normalizeDisplayMathDelimiters(content);
  const change = computeMinimalTextChange(view.state.doc.toString(), next);
  if (!change) return;
  const changeSet = view.state.changes(change);
  view.dispatch({
    changes: change,
    selection: view.state.selection.map(changeSet),
  });
});
handler.on('markdownAnnotations', (annotations) => {
  if (!view) return;
  const source = view.state.doc.toString();
  const mapped = (annotations || []).flatMap((annotation) => {
    const text = String(annotation.selectedText || '').trim();
    const storedOffset = Number(annotation.textOffset);
    const from = Number.isInteger(storedOffset) &&
      storedOffset >= 0 && source.slice(storedOffset, storedOffset + text.length) === text
      ? storedOffset
      : source.indexOf(text);
    return from < 0 || !text ? [] : [{ annotation, from, to: from + text.length }];
  });
  view.dispatch({ effects: noteUpdate.of(mapped) });
});
handler.on('markdownFontSizes', applyFontSizes);
handler.on('gotoBlock', (fragment) => {
  if (!view || !fragment) return;
  const index = view.state.doc.toString().indexOf(fragment);
  if (index >= 0) view.dispatch({ selection: { anchor: index }, scrollIntoView: true });
});
handler.emit('init');
