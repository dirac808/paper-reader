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
import {
  deleteTableColumn,
  deleteTableRow,
  insertTableColumn,
  insertTableRow,
  isTableDivider,
  normalizeTableModel,
  parseTableCellLines,
  serializeTable,
  splitTableRowCells,
  tableAlignment,
  tableEstimatedHeight,
  unescapeTableCell,
} from './tableModel.js';

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
  tableBuilds: 0,
  tableDomReuses: 0,
  tableCommits: 0,
  tableStructureEdits: 0,
  tableBuildMs: 0,
  lastTableCommitMs: 0,
  maxTableCommitMs: 0,
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

// Live Markdown table editing state.
// `tableSession` keeps the mounted table DOM alive across transactions so cell edits,
// selection changes and structural edits never have to rebuild the table view.
let tableSession = null;
const tableElements = new Map();
const tableCommitDelay = 350;
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

// Range-exact lookup used by the explicit source command, which is allowed to target a table.
const findBlockAt = (blocks, from, to) =>
  blocks.find((block) => block.from === from && block.to === to) || null;

// Source-edit mode only ever applies to non-table blocks. Tables are edited in place, so
// the cursor moving into a table must not switch it back to Markdown source.
const findEditableBlock = (blocks, from, to = from) => {
  const block = findOverlappingBlock(blocks, from, to);
  return block && block.type !== 'table' ? block : null;
};

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
  const parsed = parseTableCellLines(sourceLines(state, node.from, node.to));
  if (!parsed) return null;
  return { type: 'table', from: node.from, to: node.to, ...parsed };
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
    const tableHost = event.target instanceof Element
      ? event.target.closest('.paper-reader-cm-cell')
      : null;
    if (tableHost) {
      // The caret lives in the cell, not in the editor. The editor selection is recorded
      // for diagnostics only: moving it here would snap the caret to the cell's start and
      // break click placement and drag selection inside the cell.
      const block = editorView.state.field(documentBlockPreview).blocks.find(
        (entry) => entry.type === 'table' && entry.from === from && entry.to === to,
      );
      const sourceCell = cellSourceRange(
        block || {},
        Number(tableHost.dataset.rowIndex),
        Number(tableHost.dataset.columnIndex),
      );
      const cellAnchor = sourceCell
        ? sourceCell.contentStart
        : mapTableCellClick(node, editorView, event);
      // The host editor focuses itself while handling the same click, so the cell has to
      // reclaim focus. It happens after the gesture settles, and it never touches the caret.
      focusTableCell(tableHost);
      performanceStats.lastWidgetActivation = {
        from,
        to,
        anchor: cellAnchor,
        sourceRange,
        tableCell: {
          row: Number(tableHost.dataset.rowIndex),
          column: Number(tableHost.dataset.columnIndex),
        },
        selectionFrom: editorView.state.selection.main.from,
      };
      diagnosticRecord({ kind: 'table-cell-focus', dispatchedAnchor: cellAnchor });
      recordSample(performanceStats.pointerSamples, performance.now() - started);
      performanceStats.lastPointerMs = performance.now() - started;
      return;
    }
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
  constructor(table, from, to, session) {
    super();
    this.table = table;
    this.from = from;
    this.to = to;
    this.session = session;
  }

  eq(other) {
    // Reusing the live DOM is what keeps the caret and focus alive across transactions.
    // Two widgets for the same live table session are always considered equal so the
    // editor moves the existing element instead of rebuilding it.
    if (other.session && other.session === this.session && other.session.live) return true;
    return other.from === this.from && other.to === this.to &&
      other.table.from === this.table.from && other.table.to === this.table.to &&
      JSON.stringify(other.table.rows) === JSON.stringify(this.table.rows) &&
      JSON.stringify(other.table.headers) === JSON.stringify(this.table.headers);
  }

  get estimatedHeight() {
    return tableEstimatedHeight(this.table);
  }

  toDOM() {
    const started = performance.now();
    const node = document.createElement('div');
    node.className = 'paper-reader-cm-table';
    // Deliberately no `title`: a native tooltip would follow the pointer across the whole table
    // and cover the cells, and the rendered table already makes in-place editing obvious.
    const live = this.session;
    // The cell DOM is the expensive part and the only thing holding focus and the caret,
    // so it is moved into the fresh wrapper instead of being rebuilt.
    if (live && live.live && live.element && tableDomMatchesSessionModel(live, this.table)) {
      registerTableElement(live, node);
      node.appendChild(live.element);
      tableSession = live;
      bindWidgetActivation(node, this.from, this.to);
      // The reused wrapper is a different root from the one that was tracked before, so the
      // pointer tracking has to move with it. Without this, a rebuilt table keeps a listener
      // that resolves zones against the table it replaced, and no control can be revealed.
      if (typeof live.bindControlTracking === 'function') {
        live.bindControlTracking(node);
      }
      observeTableGeometry(node, live);
      const relayout = live.layoutTableControls;
      if (relayout) {
        const requestMeasure = live.requestLayoutMeasure;
        if (typeof requestMeasure === 'function') requestMeasure();
        else if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => relayout());
      }
      recordTableBuild(false, performance.now() - started);
      restoreTableFocus(live);
      return node;
    }
    const table = buildTableElement(this.table, this.session, this.from, this.to);
    if (this.session) {
      this.session.element = table;
      this.session.node = node;
      this.session.from = this.from;
      this.session.to = this.to;
      this.session.model = this.table;
      this.session.live = true;
      tableSession = this.session;
    }
    registerTableElement(this.session, node);
    node.appendChild(table);
    // Only now can cell rects be measured.
    mountTableElement(table, this.session);
    bindWidgetActivation(node, this.from, this.to);
    observeTableGeometry(node, this.session);
    if (typeof this.session.bindControlTracking === 'function') {
      this.session.bindControlTracking(node);
    }
    // Positions can only be measured once the element is in the document, which happens just
    // after `toDOM` returns. A measure pass is the reliable moment: a bare animation frame can
    // run before the editor has re-inserted the widget, leaving the controls where the previous
    // layout put them (measurably ~20px out).
    const layout = this.session.layoutTableControls;
    if (layout) {
      const requestMeasure = this.session.requestLayoutMeasure;
      if (typeof requestMeasure === 'function') requestMeasure();
      else if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => layout());
    }
    recordTableBuild(true, performance.now() - started);
    return node;
  }

  ignoreEvent() {
    return true;
  }
}

// Cells are real contenteditable children. CodeMirror forces the widget root to
// contenteditable=false, which is why the editable host has to be a nested element.
const buildTableElement = (model, session, from, to) => {
  const table = document.createElement('table');
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  model.headers.forEach((header, index) => {
    const cell = document.createElement('th');
    cell.appendChild(buildCellContent(header, 0, index));
    if (model.alignments[index]) cell.style.textAlign = model.alignments[index];
    headRow.appendChild(cell);
  });
  head.appendChild(headRow);
  table.appendChild(head);
  const body = document.createElement('tbody');
  model.rows.forEach((row, rowIndex) => {
    const rowElement = document.createElement('tr');
    model.headers.forEach((_header, index) => {
      const cell = document.createElement('td');
      cell.appendChild(buildCellContent(row[index] || '', rowIndex + 1, index));
      if (model.alignments[index]) cell.style.textAlign = model.alignments[index];
      rowElement.appendChild(cell);
    });
    body.appendChild(rowElement);
  });
  table.appendChild(body);
  // Handlers are deliberately NOT attached here. Everything that binds to this table measures
  // cell rects, and at this point it is still detached, so every measurement would be zero and
  // no control could ever be revealed. Whoever puts the table in the document calls
  // `attachTableHandlers` afterwards, which is the first moment the geometry is real.
  return table;
};

// The one place a table becomes measurable: call this only when `table` is in the document.
const mountTableElement = (table, session) => {
  attachTableHandlers(table, session);
  bindFramePress();
  return table;
};

// The widget reserves a margin around the table for the boundary controls, and a tall row leaves
// bare <td>/<th> space beside a short cell. Both belong to the table the reader is looking at, so
// neither may reach the editor: the editor moves its own selection to the press point and the
// table then drops out of the view and comes back as Markdown source. The editable host and the
// controls keep their own handling — the host is where the browser focuses and places the caret,
// and the controls run their own activation.
// The widget reserves a margin around the table for the boundary controls. It belongs to the
// widget, not to the document, so a press there must not reach the editor: the editor moves its
// own selection to the press point, and the table then drops out of the view and comes back as
// Markdown source. The editable host keeps its own handling — that is where the browser focuses
// and places the caret — and so do the controls.
const bindFramePress = () => {
  if (bindFramePress.bound) return;
  bindFramePress.bound = true;
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
    window.addEventListener(type, (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (!target.closest('.paper-reader-cm-table')) return;
      if (target.closest('.paper-reader-cm-cell') || target.closest('.paper-reader-cm-table-control')) return;
      event.preventDefault();
      event.stopPropagation();
    }, true);
  }
};

// A row is as tall as its tallest cell, so a short cell leaves dead space beside its taller
// neighbour: it looks like part of the cell but belongs to the bare table cell, so a press there
// misses the host. Stretching each host to its row's height gives the cell the whole box the
// reader sees. The min-height is cleared before measuring, or the row would grow to include the
// height the previous pass wrote and each pass would inflate the table further.
const stretchTableCells = (table) => {
  const rows = [...table.querySelectorAll('tr')];
  const hosts = [];
  for (const row of rows) {
    const rowHosts = [...row.querySelectorAll('.paper-reader-cm-cell')];
    for (const host of rowHosts) {
      host.style.minHeight = '';
      hosts.push(host);
    }
  }
  // Reading every row height only after clearing them all keeps the measurements independent.
  for (const row of rows) {
    const height = Math.round(row.getBoundingClientRect().height);
    if (!height) continue;
    for (const host of row.querySelectorAll('.paper-reader-cm-cell')) {
      host.style.minHeight = `${height}px`;
    }
  }
};

// Positions are derived from live geometry, so they have to be refreshed whenever that geometry
// changes. A pointer pass covers scrolling and resizing while the pointer is over the table;
// this covers the rest — a document update or a re-render that changes row heights — which
// would otherwise leave the controls where the previous layout put them.
const observeTableGeometry = (node, session) => {
  if (typeof ResizeObserver !== 'function') return;
  if (session.geometryObserver) session.geometryObserver.disconnect();
  const observer = new ResizeObserver(() => {
    if (typeof session.layoutTableControls === 'function') session.layoutTableControls();
  });
  observer.observe(node);
  session.geometryObserver = observer;
};

const buildCellContent = (text, rowIndex, columnIndex) => {
  const host = document.createElement('div');
  host.className = 'paper-reader-cm-cell';
  host.setAttribute('contenteditable', 'plaintext-only');
  host.spellcheck = false;
  host.dataset.rowIndex = String(rowIndex);
  host.dataset.columnIndex = String(columnIndex);
  host.textContent = text;
  return host;
};

const tableCellHosts = (table) => [...(table?.querySelectorAll('.paper-reader-cm-cell') || [])];

const cellHostAt = (table, rowIndex, columnIndex) =>
  table?.querySelector(
    `.paper-reader-cm-cell[data-row-index="${rowIndex}"][data-column-index="${columnIndex}"]`,
  ) || null;

const findCellHost = (target) => (target instanceof Element ? target.closest('.paper-reader-cm-cell') : null);

const offsetWithinCell = (host, node, offset) => {
  if (!host.contains(node)) return null;
  let total = 0;
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  let current;
  while ((current = walker.nextNode())) {
    if (current === node) return total + offset;
    total += current.data.length;
  }
  return total;
};

const caretOffsetInCell = (host) => {
  const selection = document.getSelection();
  if (!selection || !selection.anchorNode) return null;
  return offsetWithinCell(host, selection.anchorNode, selection.anchorOffset);
};

const setCaretInCell = (host, offset) => {
  const text = host.textContent || '';
  const target = Math.max(0, Math.min(text.length, Number.isFinite(offset) ? offset : text.length));
  let remaining = target;
  let node = null;
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  while ((node = walker.nextNode())) {
    if (remaining <= node.data.length) break;
    remaining -= node.data.length;
  }
  const selection = document.getSelection();
  if (!selection) return;
  const range = document.createRange();
  if (node) range.setStart(node, Math.min(remaining, node.data.length));
  else range.setStart(host, 0);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
};

// Character offset inside a cell for a pointer position. Needed because CodeMirror cancels
// the default widget mousedown, so the browser never places the caret by itself.
const caretOffsetFromPoint = (host, event) => {
  if (!Number.isFinite(event?.clientX) || !Number.isFinite(event?.clientY)) return null;
  let range = null;
  if (typeof document.caretRangeFromPoint === 'function') {
    range = document.caretRangeFromPoint(event.clientX, event.clientY);
  } else if (typeof document.caretPositionFromPoint === 'function') {
    const position = document.caretPositionFromPoint(event.clientX, event.clientY);
    if (position) {
      range = document.createRange();
      range.setStart(position.offsetNode, position.offset);
      range.collapse(true);
    }
  }
  if (!range || !host.contains(range.startContainer)) return null;
  const offset = offsetWithinCell(host, range.startContainer, range.startOffset);
  if (offset !== null) return offset;
  // A row is as tall as its tallest cell, so clicking in the blank space below a short cell
  // resolves to the cell element itself rather than to a text position. Clamp to the nearest
  // end of its text instead of refusing to move the caret at all.
  const text = host.textContent || '';
  if (range.startContainer === host) {
    // Ask the DOM which side of the cell's text the hit landed on rather than guessing from the
    // child index: a cell whose content is a single text node has no element children at all.
    const probe = document.createRange();
    probe.selectNodeContents(host);
    probe.setEnd(range.startContainer, range.startOffset);
    const consumed = probe.toString().length;
    return consumed <= 0 ? 0 : text.length;
  }
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  const first = walker.nextNode();
  if (!first) return text.length;
  return first.compareDocumentPosition(range.startContainer) === Node.DOCUMENT_POSITION_PRECEDING
    ? text.length
    : 0;
};

const cellSourceRange = (model, rowIndex, columnIndex) => {
  const source = model?.source;
  if (!source) return null;
  if (rowIndex === 0) return source.headerCells?.[columnIndex] || null;
  return source.bodyCells?.[rowIndex - 1]?.[columnIndex] || null;
};

// The document is the source of truth; the DOM is allowed to run ahead while the user
// types, and is reconciled with a single minimal transaction once typing settles.
const commitTableCell = (session, host, options = {}) => {
  const editorView = view || (host && EditorView.findFromDOM(host));
  if (!editorView || !session) return false;
  const rowIndex = Number(host?.dataset.rowIndex);
  const columnIndex = Number(host?.dataset.columnIndex);
  if (!Number.isFinite(rowIndex) || !Number.isFinite(columnIndex)) return false;
  const blocks = editorView.state.field(documentBlockPreview).blocks;
  const block = blocks.find((entry) => entry.type === 'table' && entry.from === session.from) ||
    blocks.find((entry) => entry.type === 'table' && entry.from <= session.to && entry.to >= session.from);
  if (!block) return false;
  const source = cellSourceRange(block, rowIndex, columnIndex);
  if (!source) return false;
  const domText = String(host.textContent ?? '').replace(/[\r\n\t]+/g, ' ').trim();
  const sourceText = source.text;
  const caret = caretOffsetInCell(host);
  if (domText === sourceText) {
    if (options.force && host.textContent !== sourceText) host.textContent = sourceText;
    return false;
  }
  let prefix = 0;
  const limit = Math.min(domText.length, sourceText.length);
  while (prefix < limit && domText[prefix] === sourceText[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < limit - prefix &&
    domText[domText.length - 1 - suffix] === sourceText[sourceText.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const removed = sourceText.length - prefix - suffix;
  const insert = domText.slice(prefix, domText.length - suffix);
  const started = performance.now();
  editorView.dispatch({
    changes: {
      from: source.contentStart + prefix,
      to: source.contentEnd - suffix,
      insert,
    },
  });
  performanceStats.tableCommits += 1;
  performanceStats.lastTableCommitMs = Number((performance.now() - started).toFixed(2));
  performanceStats.maxTableCommitMs = Math.max(
    performanceStats.maxTableCommitMs,
    performanceStats.lastTableCommitMs,
  );
  const delta = insert.length - removed;
  if (Number.isFinite(caret)) setCaretInCell(host, caret + delta);
  session.dirty = false;
  session.pending = null;
  return true;
};

const flushTableSession = (session, options = {}) => {
  if (!session?.pending) return false;
  const { host, caret } = session.pending;
  session.pending = null;
  if (!host || !host.isConnected) return false;
  const committed = commitTableCell(session, host, options);
  if (Number.isFinite(caret)) setCaretInCell(host, caret);
  return committed;
};

const markCellDirty = (session, host) => {
  if (!session || !host) return;
  session.dirty = true;
  session.pending = { host, caret: caretOffsetInCell(host) };
  window.clearTimeout(session.commitTimer);
  // While the user keeps typing the DOM owns the caret; the document catches up once
  // typing settles so a burst of input costs exactly one transaction.
  session.commitTimer = window.setTimeout(() => {
    session.commitTimer = 0;
    flushTableSession(session);
  }, tableCommitDelay);
};

const replaceTableInDocument = (session, model) => {
  const editorView = view;
  if (!editorView || !session) return false;
  const blocks = editorView.state.field(documentBlockPreview).blocks;
  const block = blocks.find((entry) => entry.type === 'table' && entry.from === session.from) ||
    blocks.find((entry) => entry.type === 'table' && entry.from <= session.to && entry.to >= session.from);
  if (!block) return false;
  window.clearTimeout(session.commitTimer);
  session.commitTimer = 0;
  session.pending = null;
  session.dirty = false;
  const content = serializeTable(model);
  // Row/column changes alter the table's shape, so the mounted DOM has to be rebuilt.
  // This has to happen here rather than in `toDOM`: while the session is live the widget
  // compares equal, so CodeMirror reuses the cached DOM and never calls `toDOM` again.
  // No cell is focused during a structural edit, so replacing the table costs no caret.
  rebuildSessionTable(session, model, block.from, block.from + content.length);
  session.structure += 1;
  session.model = model;
  session.from = block.from;
  session.to = block.from + content.length;
  performanceStats.tableStructureEdits += 1;
  editorView.dispatch({
    changes: { from: block.from, to: block.to, insert: content },
  });
  return true;
};

// Rebuilds the mounted table for the current session. Reads the live wrapper from the DOM
// instead of trusting a cached reference, so a stale session can never leave the view
// showing the previous shape.
const rebuildSessionTable = (session, model, from, to) => {
  const mounted = document.querySelector('.paper-reader-cm-table');
  if (!mounted) return null;
  const previous = mounted.querySelector('table');
  const rebuilt = buildTableElement(model, session, from, to);
  if (previous) mounted.replaceChild(rebuilt, previous);
  else mounted.appendChild(rebuilt);
  // The table is live now, so the reveal zones can finally measure real cell rects.
  mountTableElement(rebuilt, session);
  session.element = rebuilt;
  session.node = mounted;
  tableElements.set(mounted, session);
  recordTableBuild(true, 0);
  return rebuilt;
};

const tableModelOf = (block) => normalizeTableModel({
  headers: block.headers,
  alignments: block.alignments,
  rows: block.rows,
});

const attachTableHandlers = (table, session) => {
  attachTableControls(table, session);
  // Re-binding the controls is safe and required after a rebuild, but these cell handlers must
  // be attached exactly once per element.
  if (table.dataset.paperReaderHandlers === 'bound') return;
  table.dataset.paperReaderHandlers = 'bound';
  table.addEventListener('focusin', () => {
    if (session) session.focused = true;
  });
  table.addEventListener('focusout', (event) => {
    if (!session) return;
    session.focused = false;
    const host = findCellHost(event.target);
    if (host && !table.contains(event.relatedTarget)) flushTableSession(session);
  });
  table.addEventListener('mousedown', (event) => {
    // CodeMirror preventDefaults widget mousedowns, which cancels the browser's own caret
    // placement. Resolve the offset from the click point so click and drag behave natively.
    const host = findCellHost(event.target);
    if (!host || event.button !== 0) return;
    const offset = caretOffsetFromPoint(host, event);
    if (host !== document.activeElement) host.focus();
    if (Number.isFinite(offset)) {
      // Focusing a contenteditable resets its selection, and the host editor also focuses
      // itself during this same gesture, so the caret is applied on the next frame. That
      // re-apply must never fire once the gesture has become a drag: collapsing a selection
      // the user just made is worse than leaving the caret where the browser put it.
      setCaretInCell(host, offset);
      if (typeof requestAnimationFrame === 'function') {
        host.dataset.pendingCaret = String(offset);
        requestAnimationFrame(() => {
          const pending = host.dataset.pendingCaret;
          delete host.dataset.pendingCaret;
          if (!host.isConnected || pending === undefined || document.activeElement !== host) return;
          const selection = document.getSelection();
          // A non-collapsed selection means the gesture turned into a drag; leave it alone.
          if (selection && !selection.isCollapsed && host.contains(selection.anchorNode)) return;
          setCaretInCell(host, Number(pending));
        });
      }
    }
  }, true);
  table.addEventListener('input', (event) => {
    const host = findCellHost(event.target);
    if (!host || event.isComposing) return;
    markCellDirty(session, host);
  });
  table.addEventListener('beforeinput', (event) => {
    if (event.inputType?.startsWith('insert') && /[\r\n\t]/.test(event.data || '')) {
      // Cell content is single-line Markdown; line breaks would break the table syntax.
      event.preventDefault();
      const host = findCellHost(event.target);
      if (host && event.data) document.execCommand('insertText', false, event.data.replace(/[\r\n\t]+/g, ' '));
    }
  });
  table.addEventListener('keydown', (event) => {
    const host = findCellHost(event.target);
    if (!host || !session) return;
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      const rowIndex = Number(host.dataset.rowIndex);
      const columnIndex = Number(host.dataset.columnIndex);
      flushTableSession(session);
      if (event.key === 'Enter') {
        moveTableCellFocus(session, rowIndex + 1, columnIndex, rowIndex + 1 > tableModelRowCount(session));
      } else {
        const backwards = event.shiftKey;
        const columns = Math.max(1, tableModelColumnCount(session));
        const flat = rowIndex * columns + columnIndex + (backwards ? -1 : 1);
        moveTableCellFocus(session, Math.floor(flat / columns), flat % columns, false, true);
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      window.clearTimeout(session.commitTimer);
      session.commitTimer = 0;
      session.pending = null;
      session.dirty = false;
      const block = view.state.field(documentBlockPreview).blocks
        .find((entry) => entry.type === 'table' && entry.from === session.from);
      host.textContent = cellSourceRange(
        block || {},
        Number(host.dataset.rowIndex),
        Number(host.dataset.columnIndex),
      )?.text ?? host.textContent;
      host.blur();
      view.focus();
    }
  });
};

const tableModelRowCount = (session) => (session?.model?.rows?.length ?? 0) + 1;

const tableModelColumnCount = (session) => Math.max(1, session?.model?.headers?.length ?? 1);

const moveTableCellFocus = (session, rowIndex, columnIndex, addRow, wrap = false) => {
  if (!session?.element) return;
  const rows = tableModelRowCount(session);
  const columns = tableModelColumnCount(session);
  let row = rowIndex;
  let column = columnIndex;
  if (wrap) {
    if (row < 0) {
      row = rows - 1;
      column = columns - 1;
    } else if (row >= rows) {
      row = 0;
      column = 0;
    }
  }
  if (addRow && row >= rows) {
    const model = insertTableRow(session.model, session.model.rows.length - 1, 'after');
    if (replaceTableInDocument(session, model)) {
      const host = cellHostAt(session.element, row, Math.min(column, columns - 1));
      if (host) {
        host.focus();
        setCaretInCell(host, (host.textContent || '').length);
      }
      return;
    }
  }
  const host = cellHostAt(
    session.element,
    Math.max(0, Math.min(row, rows - 1)),
    Math.max(0, Math.min(column, columns - 1)),
  );
  if (!host) return;
  host.focus();
  setCaretInCell(host, 0);
};

const registerTableElement = (session, node) => {
  if (!session) return;
  session.node = node;
  tableElements.set(node, session);
};

// CodeMirror preventDefaults widget mousedowns, so the editable cell has to be focused
// explicitly, and re-focused once after the gesture so the editor cannot reclaim focus.
const focusTableCell = (host) => {
  if (!host || !host.isConnected) return;
  host.focus();
  requestAnimationFrame(() => {
    if (host.isConnected && document.activeElement !== host) host.focus();
  });
};

const restoreTableFocus = (session) => {
  if (!session?.pendingFocus || !session.element) return;
  const { rowIndex, columnIndex, caret } = session.pendingFocus;
  session.pendingFocus = null;
  const host = cellHostAt(session.element, rowIndex, columnIndex);
  if (!host) return;
  requestAnimationFrame(() => {
    if (!host.isConnected) return;
    host.focus();
    setCaretInCell(host, Number.isFinite(caret) ? caret : (host.textContent || '').length);
  });
};

const sessionForTableElement = (node) => (node ? tableElements.get(node) : null);

const recordTableBuild = (built, elapsed) => {
  if (built) {
    performanceStats.tableBuilds += 1;
  } else {
    performanceStats.tableDomReuses += 1;
  }
  performanceStats.tableBuildMs = Number(elapsed.toFixed(2));
};

// True when the mounted cells already show exactly the model's text. This is what makes it
// safe to keep the live DOM across transactions: an in-place cell edit leaves the DOM and
// the model in agreement, while any other edit (another editor, a structural change, an
// external update) falls back to a rebuild.
const tableDomMatchesSessionModel = (session, model) => {
  if (!session?.element) return false;
  const pads = [model.headers, ...model.rows];
  const rows = session.element.querySelectorAll('tr');
  if (rows.length !== pads.length) return false;
  for (let rowIndex = 0; rowIndex < pads.length; rowIndex += 1) {
    const hosts = rows[rowIndex].querySelectorAll('.paper-reader-cm-cell');
    if (hosts.length !== pads[rowIndex].length) return false;
    for (let columnIndex = 0; columnIndex < pads[rowIndex].length; columnIndex += 1) {
      if (String(hosts[columnIndex].textContent) !== String(pads[rowIndex][columnIndex] ?? '')) {
        return false;
      }
    }
  }
  return true;
};

// Structural controls are hidden by default. They appear only when the pointer comes close
// to a row or column edge, so they never sit on top of the table content uninvited.
const TABLE_CONTROL_ACTIONS = {
  insertRow: (model, index) => insertTableRow(model, index, 'after'),
  appendRow: (model) => insertTableRow(model, Math.max(0, model.rows.length - 1), 'after'),
  deleteRow: (model, index) => deleteTableRow(model, index),
  insertColumn: (model, index) => insertTableColumn(model, index, 'after'),
  appendColumn: (model) => insertTableColumn(model, Math.max(0, model.headers.length - 1), 'after'),
  deleteColumn: (model, index) => deleteTableColumn(model, index),
  deleteTable: () => null,
};

const buildTableControlButton = (action, index, glyph, title) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'paper-reader-cm-table-control';
  button.dataset.tableAction = action;
  button.dataset.tableIndex = String(index);
  button.title = title;
  button.setAttribute('aria-label', title);
  button.tabIndex = 0;
  button.textContent = glyph;
  return button;
};

const showTableControls = (session, buttons) => {
  if (!session?.controls) return;
  const next = Array.isArray(buttons) ? buttons.filter(Boolean) : [];
  // Clear from the DOM instead of a cached reference: the table DOM is rebuilt on
  // structural edits, which would otherwise leave the previous buttons painted.
  document.querySelectorAll('.paper-reader-cm-table-control--visible').forEach((visible) => {
    if (!next.includes(visible)) visible.classList.remove('paper-reader-cm-table-control--visible');
  });
  next.forEach((button) => button.classList.add('paper-reader-cm-table-control--visible'));
  // The session list is what the "pointer is travelling to a revealed control" check reads,
  // so it must never describe buttons that are no longer on screen.
  session.visibleControls = next;
};

// A control is revealed from a small distance away. The two zones a row (or column) splits
// into do not overlap: `×` owns the middle of the row/column it removes, `+` owns the rest,
// which is the junction towards the next one.
const TABLE_BOUNDARY_TOLERANCE = 6;
const TABLE_JUNCTION_TOLERANCE = 13;
const TABLE_CENTRE_TOLERANCE = 26;

// Column controls live in a band the widget reserves above the header, in two rows: delete on
// top, insert underneath. Row controls live in a single lane in the left gutter, flush against
// the table. A control is deliberately small: at this size the row's `×` (on the row's centre)
// and the `+` (on the junction 18px below) share one lane without ever overlapping, which is
// what lets both hug the table instead of being spread across two lanes.
const CONTROL_SIZE = 14;
// How far the pointer may stray from a control and still reveal it. Rows are spread down the
// left gutter and columns across the band above the header, so the two use separate reaches.
const ROW_ZONE_REACH = 12;
const COLUMN_ZONE_REACH = 13;
const COLUMN_CONTROL_SIZE = CONTROL_SIZE;
// Two stacked controls plus the gaps that keep the `×` flush with the table's top edge.
const COLUMN_BAND_HEIGHT = CONTROL_SIZE * 2 + 4;

const attachTableControls = (table, session) => {
  // Re-binding is allowed: a structural edit rebuilds the table while it is still detached, so
  // the cells captured here have zero rects until it lands in the document. Whoever mounts the
  // table calls this again, and the stale layer is discarded rather than left behind.
  if (session.controlLayer && session.controlLayer.parentNode) {
    session.controlLayer.parentNode.removeChild(session.controlLayer);
  }
  const layer = document.createElement('div');
  layer.className = 'paper-reader-cm-table-controls';
  layer.setAttribute('aria-hidden', 'true');
  session.controlLayer = layer;

  // One canonical registry per session. Every binding pass writes into it rather than keeping a
  // private map, so whoever resolves a zone always sees the buttons of the layer that is on
  // screen — even after a rebuild has replaced both the <table> and its controls layer.
  const controls = session.controls || new Map();
  controls.clear();
  session.controls = controls;
  // Where each control was placed, in viewport coordinates. The reveal zones are derived from
  // these anchors, so a zone can never drift off the control it is meant to reveal.
  session.controlAnchorPoints = {};
  const add = (action, index, glyph, title, lane, key) => {
    const button = buildTableControlButton(action, index, glyph, title);
    button.dataset.lane = String(lane);
    if (key) button.dataset.boundary = key;
    layer.appendChild(button);
    controls.set(`${action}:${index}`, button);
    return button;
  };

  // Geometry is read from the mounted table on every pass rather than captured here: a widget
  // rebuild replaces the <table> element, and a closure holding the replaced one silently
  // measures an empty detached tree (every rect zero), which disables every reveal zone.
  // Geometry is read from the table that is actually connected to the document. A widget
  // rebuild can leave `session.node` pointing at a detached wrapper, and measuring that gives
  // zero-sized cells, which silently disables every reveal zone.
  // Row geometry comes from the <tr> itself, never from one of its cells: a row is as tall as
  // its tallest cell, so anchoring to the first cell puts the controls in the wrong place as
  // soon as any other column wraps onto a second line.
  const mountedTable = () => {
    const candidates = [
      ...document.querySelectorAll('.paper-reader-cm-table table'),
      session.node?.querySelector?.('table'),
      table,
    ];
    for (const candidate of candidates) {
      if (candidate && candidate.isConnected) return candidate;
    }
    return table;
  };
  const liveHeaderCells = () => [...mountedTable().querySelectorAll('thead th .paper-reader-cm-cell')];
  const liveBodyRows = () => [...mountedTable().querySelectorAll('tbody tr')];
  const tableRows = () => liveBodyRows().length;

  // Build one control per zone, derived from the table that is on screen right now.
  const columns = Math.max(1, liveHeaderCells().length);
  liveHeaderCells().forEach((_cell, columnIndex) => {
    // Both of a column's controls are revealed together, so they share the column's zone key.
    const columnKey = `column-${columnIndex}`;
    add('deleteColumn', columnIndex, '×', `Delete column ${columnIndex + 1}`, 2, columnKey);
    // The last column has no junction to its right: the append control owns that one.
    if (columnIndex < columns - 1) {
      add('insertColumn', columnIndex, '+', `Insert column right of column ${columnIndex + 1}`, 0, columnKey);
    }
  });
  add('appendColumn', columns - 1, '+', 'Add column at the end', 6, `column-${columns - 1}`);
  liveBodyRows().forEach((_row, rowIndex) => {
    const junctionKey = `row-junction-${rowIndex}`;
    add('deleteRow', rowIndex, '×', `Delete row ${rowIndex + 1}`, 3, `row-${rowIndex}`);
    add('insertRow', rowIndex, '+', `Insert row below row ${rowIndex + 1}`, 1, junctionKey);
    if (rowIndex === tableRows() - 1) {
      add('deleteTable', 0, '×', 'Delete table', 4, 'deleteTable:0');
      add('appendRow', rowIndex, '+', 'Add row at the end', 5, junctionKey);
    }
  });

  // Placement mirrors what each control means, and every control gets its own lane so no two
  // ever share a spot:
  //   gutter left of the table  -> row insert `+` at the junction between two rows (inner
  //                                lane, hugging the table) and row delete `×` beside the row
  //                                it removes (outer lane, on the row's centre line)
  //   band above the header     -> column insert `+` at the junction between two columns, and
  //                                column delete `×` above the column it removes
  //   table end                 -> append row / append column / delete table
  // Offsets are re-derived from live cell rects on every pass, so scrolling, resizing and a
  // rebuilt widget can never leave the buttons stacked at the widget origin.
  const layoutTableControls = () => {
    const headerCells = liveHeaderCells();
    const bodyRows = liveBodyRows();
    if (!headerCells.length || !bodyRows.length) return false;
    // Cells are stretched to their row's height here, where the geometry is real. Done before
    // anything is measured, so the controls are placed against the final layout.
    stretchTableCells(mountedTable());
    const layerRect = layer.getBoundingClientRect();
    const frame = !layerRect.width && !layerRect.height
      ? (session.node?.getBoundingClientRect?.() || layerRect)
      : layerRect;
    if (!frame.width && !frame.height) return false;
    const half = COLUMN_CONTROL_SIZE / 2;
    // Places a button so that its centre lands on (`centreX`, `centreY`), and records that
    // anchor for the reveal zones to be built from.
    const place = (button, centreX, centreY, key) => {
      if (!button) return;
      button.style.left = `${Math.round(centreX - half - frame.left)}px`;
      button.style.top = `${Math.round(centreY - half - frame.top)}px`;
      if (key) session.controlAnchorPoints[key] = { x: centreX, y: centreY };
    };
    // One lane for both row controls, right-aligned flush against the table's left edge. `×`
    // sits on its row's centre line and `+` on the junction below it; a control is small enough
    // that the two never collide there, so neither has to be pushed away from the table.
    const rowLaneX = (rect) => rect.left - half - 2;

    // Both column controls share ONE lane, two pixels above the table's top border — the same
    // way both row controls share one lane beside the table's left edge. Stacking them in two
    // lanes is what pushed one of them a whole control's height away from the table, so neither
    // ever read as attached. They fit in one lane because they sit at different x: `×` over its
    // column's centre, `+` out at that column's right boundary, which are at least half a column
    // apart.
    const tableTop = headerCells[0].getBoundingClientRect().top;
    const controlBandY = tableTop - half - 2;

    headerCells.forEach((cell, columnIndex) => {
      const rect = cell.getBoundingClientRect();
      // `×` removes this column, so it sits above the column's own centre: that is the spot a
      // reader points at when they mean "this column".
      place(controls.get(`deleteColumn:${columnIndex}`), (rect.left + rect.right) / 2, controlBandY, `deleteColumn:${columnIndex}`);
      // `+` sits on the junction to the right of this column, hugging the table's edge.
      if (columnIndex < headerCells.length - 1) {
        place(controls.get(`insertColumn:${columnIndex}`), rect.right + half, controlBandY, `insertColumn:${columnIndex}`);
      }
    });
    const lastHeader = headerCells[headerCells.length - 1].getBoundingClientRect();
    // No column exists to the right, so the append control is parked just outside the table.
    place(controls.get(`appendColumn:${headerCells.length - 1}`), lastHeader.right + half, controlBandY, `appendColumn:${headerCells.length - 1}`);

    bodyRows.forEach((row, rowIndex) => {
      const rect = row.getBoundingClientRect();
      // `×` removes this row, so it sits on the row's own centre line.
      place(controls.get(`deleteRow:${rowIndex}`), rowLaneX(rect), (rect.top + rect.bottom) / 2, `deleteRow:${rowIndex}`);
      // `+` sits on the junction below this row, i.e. between it and the next row. It is nudged
      // a couple of pixels further down so it does not touch the next row's `×` in the shared
      // lane: the two are only half a row apart by construction.
      place(controls.get(`insertRow:${rowIndex}`), rowLaneX(rect), rect.bottom + 2, `insertRow:${rowIndex}`);
      if (rowIndex === bodyRows.length - 1) {
        // Nothing exists below the last row, so the junction lane is free there.
        place(controls.get(`appendRow:${rowIndex}`), rowLaneX(rect), rect.bottom + COLUMN_BAND_HEIGHT + 2, `appendRow:${rowIndex}`);
        place(controls.get('deleteTable:0'), rect.right + CONTROL_SIZE + 6, rect.top, 'deleteTable:0');
      }
    });

    session.controlLayoutOrigin = frame.left + frame.top;
    return true;
  };
  // The widget may still be detached here, so this first attempt can find zero geometry.
  // `toDOM` re-runs it once the element is in the document, and every pointer pass re-runs it,
  // so scrolling and rebuilding can never leave the buttons stacked at the widget origin.
  layoutTableControls();
  session.layoutTableControls = layoutTableControls;
  // The widget asks the editor to measure before laying the controls out, so positions land in
  // the same pass that establishes the table's final geometry.
  session.requestLayoutMeasure = () => {
    if (view && typeof view.requestMeasure === 'function') {
      view.requestMeasure({ read: () => layoutTableControls() });
      return;
    }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => layoutTableControls());
  };

  session.visibleControls = [];

  // The control the pointer belongs to. Pointing at a button always reveals that button; away
  // from any button the nearest control wins, measured along the axis that separates it from its
  // neighbours (rows down the left gutter, columns across the band above the header). Every
  // control records where it was placed, so a control can never fall outside its own reach —
  // which is what used to make a button impossible to hit at its own centre.
  const pointerJitter = 3;
  const boundaryAt = (event) => {
    const anchors = session.controlAnchorPoints || {};
    const headerCells = liveHeaderCells();
    const connected = [];
    for (const [id, anchor] of Object.entries(anchors)) {
      const button = controls.get(id);
      if (!button || !button.isConnected) continue;
      // Pointing at a button always reveals that button. That is the one rule a user can rely
      // on, and it is what keeps the controls at the table's far end reachable: distance along
      // the row lane says nothing about them.
      const rect = button.getBoundingClientRect();
      if (event.clientX >= rect.left - pointerJitter && event.clientX <= rect.right + pointerJitter &&
        event.clientY >= rect.top - pointerJitter && event.clientY <= rect.bottom + pointerJitter) {
        return { distance: 0, key: id, buttons: [button] };
      }
      connected.push({ id, anchor });
    }
    // Otherwise the nearest control wins, measured along the axis that separates it from its
    // neighbours: rows are spread down the left gutter, columns across the band above the
    // header. Column zones stop at the header, or a wide column would claim the whole body.
    const headerBottom = headerCells.length
      ? Math.max(...headerCells.map((cell) => cell.getBoundingClientRect().bottom))
      : 0;
    let best = null;
    for (const { id, anchor } of connected) {
      const isRow = id.indexOf('Row') >= 0;
      if (!isRow && event.clientY > headerBottom) continue;
      const delta = isRow ? event.clientY - anchor.y : event.clientX - anchor.x;
      const distance = Math.abs(delta);
      if (distance > (isRow ? ROW_ZONE_REACH : COLUMN_ZONE_REACH)) continue;
      const real = Math.hypot(event.clientX - anchor.x, event.clientY - anchor.y);
      if (best && real >= best.distance) continue;
      best = { distance: real, key: id, buttons: [controls.get(id)] };
    }
    return best;
  };
  const resolveControlsAt = (event) => {
    // Re-derive the positions before every hit test: the table moves with the editor scroll,
    // and this also recovers the layout when the first attempt ran before the widget mounted.
    // A layout that cannot be measured (detached layer, empty table) must reveal nothing —
    // otherwise the zones are computed against stale geometry and paint buttons out of place.
    const laidOut = layoutTableControls();
    if (!laidOut) return [];
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return [];
    const best = boundaryAt(event);
    if (!best) return [];
    return best.buttons;
  };
  session.resolveControlsAt = resolveControlsAt;

  // While a control is already on screen the pointer is allowed to travel to it. Without this
  // the button vanishes in the last few pixels of the approach, because the pointer has left
  // the narrow band that revealed it, and the press lands on the table instead.
  const holdRevealedControls = (event) => {
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return false;
    for (const button of session.visibleControls || []) {
      if (!button.isConnected) continue;
      const rect = button.getBoundingClientRect();
      const pad = TABLE_BOUNDARY_TOLERANCE;
      if (event.clientX >= rect.left - pad && event.clientX <= rect.right + pad &&
        event.clientY >= rect.top - pad && event.clientY <= rect.bottom + pad) {
        return true;
      }
    }
    return false;
  };

  const updateFromEvent = (event) => {
    if (holdRevealedControls(event)) return;
    showTableControls(session, resolveControlsAt(event));
  };

  // The listener belongs on the widget root, not on <table>: the controls live in the gutters
  // the root reserves outside the table, so table-level events never fire on the way to them
  // and the revealed control would vanish before it could be pressed. The root only exists
  // once the widget is built, so `toDOM` calls back into this.
  session.bindControlTracking = (root) => {
    root.addEventListener('mousemove', (event) => {
      // One frame in flight at a time, always resolving the newest pointer position. A stale
      // frame must not run after a newer one, or it would reveal the wrong boundary.
      if (session.controlFrame) cancelAnimationFrame(session.controlFrame);
      const point = {
        clientX: event.clientX,
        clientY: event.clientY,
        target: event.target,
      };
      session.controlFrame = requestAnimationFrame(() => {
        session.controlFrame = 0;
        updateFromEvent(point);
      });
    });
    root.addEventListener('mouseleave', () => {
      if (session.controlFrame) {
        cancelAnimationFrame(session.controlFrame);
        session.controlFrame = 0;
      }
      showTableControls(session, []);
    });
  };

  // The action runs on mousedown, not click: CodeMirror re-renders the widget while the
  // pointer is down, which detaches this button before a click could ever be delivered.
  const activate = (button) => {
    const result = runTableControl(session, button.dataset.tableAction, Number(button.dataset.tableIndex));
    performanceStats.lastTableControlResult = {
      action: button.dataset.tableAction,
      index: Number(button.dataset.tableIndex),
      result,
      source: 'control',
    };
  };
  // Capture phase matters: the host editor runs widget mousedown handling on the content
  // element and stops propagation, so a bubble listener on the layer would never fire.
  // This is a safety net only; activation is bound on the widget root, because CodeMirror
  // can keep showing a table whose own controls layer is no longer the live one.
  layer.addEventListener('mousedown', (event) => {
    const button = event.target instanceof Element
      ? event.target.closest('button[data-table-action]')
      : null;
    event.preventDefault();
    event.stopPropagation();
    if (!button) return;
    activate(button);
  }, true);
  layer.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const button = event.target instanceof Element
      ? event.target.closest('button[data-table-action]')
      : null;
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    activate(button);
  });
  table.appendChild(layer);
  return { layer, activate };
};

// Control activation is bound on the document in the capture phase. Table widgets are
// rebuilt while the pointer is down, which can detach the button before a click, and the
// host editor stops propagation on the content element; document capture sees every
// control press no matter which table DOM is currently mounted.
// Control activation is bound on the document in the capture phase. Table widgets are
// rebuilt while the pointer is down, which can detach the button before a click, and the
// host editor stops propagation on the content element; document capture sees every
// control press no matter which table DOM is currently mounted. `pointerdown` is used
// because it arrives before any widget re-render can swallow the press.
const bindTableControlActivation = (editorView) => {
  const activateFromEvent = (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return false;
    const button = target.closest('button[data-table-action]');
    if (!button || !editorView.dom.contains(button)) return false;
    const session = tableSession;
    if (!session) return false;
    event.preventDefault();
    event.stopPropagation();
    try {
      const result = runTableControl(session, button.dataset.tableAction, Number(button.dataset.tableIndex));
      performanceStats.lastTableControlResult = {
        action: button.dataset.tableAction,
        index: Number(button.dataset.tableIndex),
        result,
        source: 'document',
      };
    } catch (error) {
      performanceStats.lastTableControlResult = {
        action: button.dataset.tableAction,
        source: 'error',
        message: String(error && error.message || error),
      };
    }
    return true;
  };
  editorView.dom.ownerDocument.addEventListener('pointerdown', activateFromEvent, true);
  editorView.dom.ownerDocument.addEventListener('mousedown', activateFromEvent, true);
  editorView.dom.ownerDocument.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest('button[data-table-action]');
    if (!button || !editorView.dom.contains(button) || !tableSession) return;
    event.preventDefault();
    event.stopPropagation();
    runTableControl(tableSession, button.dataset.tableAction, Number(button.dataset.tableIndex));
  }, true);
};

const runTableControl = (session, action, index) => {
  const editorView = view;
  if (!editorView || !session) return false;
  flushTableSession(session);
  const blocks = editorView.state.field(documentBlockPreview).blocks;
  const block = blocks.find((entry) => entry.type === 'table' && entry.from === session.from) ||
    blocks.find((entry) => entry.type === 'table' && entry.from <= session.to && entry.to >= session.from);
  if (!block) return false;
  const model = tableModelOf(block);
  const transform = TABLE_CONTROL_ACTIONS[action];
  if (!transform) return false;
  try {
    if (action === 'deleteTable') {
      const after = editorView.state.doc.lineAt(Math.min(editorView.state.doc.length, block.to)).to;
      const trailing = editorView.state.sliceDoc(after, Math.min(editorView.state.doc.length, after + 2)) === '\n\n'
        ? 2
        : editorView.state.sliceDoc(after, Math.min(editorView.state.doc.length, after + 1)) === '\n'
          ? 1
          : 0;
      tableSession = null;
      editorView.dispatch({
        changes: { from: block.from, to: after + trailing, insert: '' },
      });
      return true;
    }
    const next = transform(model, index);
    if (!next) return false;
    return replaceTableInDocument(session, next);
  } catch (error) {
    performanceStats.lastTableControlError = String(error && error.message || error);
    return false;
  }
};

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

const documentBlockDecoration = (block, session = null) => {
  const widget = block.type === 'math'
    ? new MathWidget(block.source, block.from, block.to, true)
    : block.type === 'inlineMath'
      ? new MathWidget(block.source, block.from, block.to, false)
    : block.type === 'code'
      ? new CodeBlockWidget(block.source, block.language, block.from, block.to)
      : block.type === 'table'
        ? new TableWidget(block, block.from, block.to, session)
        : new ImageWidget(block.alt, block.url, block.from, block.to);
  return Decoration.replace({
    widget,
    block: block.type !== 'inlineMath',
  }).range(block.from, block.to);
};

// Tables stay in table view no matter where the cursor or the selection is, so in-place
// editing never collapses the table back into Markdown source. The only way to see a
// table's Markdown is the explicit "edit table source" command, which sets the table as
// the editing block on purpose.
const shouldPreviewBlock = (state, block, editingBlock) => {
  const editingMatch = Boolean(editingBlock &&
    block.from === editingBlock.from && block.to === editingBlock.to);
  if (block.type === 'table') return !editingMatch;
  return !intersectsSelection(state, block.from, block.to) && !editingMatch;
};

const resolveBlockSession = (block) => {
  const live = tableSession;
  if (live && live.live && live.element &&
    block.from <= live.to && block.to >= live.from) {
    live.from = block.from;
    live.to = block.to;
    live.model = block;
    return live;
  }
  return {
    id: (tableSession?.id || 0) + 1,
    live: false,
    element: null,
    node: null,
    model: block,
    structure: 0,
    from: block.from,
    to: block.to,
    dirty: false,
    pending: null,
    pendingFocus: null,
    commitTimer: 0,
    focused: false,
  };
};

const collectBlockWidgets = (state, blocks, editingBlock, filter) => {
  const widgets = [];
  for (const block of blocks) {
    if (!filter(block) || !shouldPreviewBlock(state, block, editingBlock)) continue;
    const session = block.type === 'table' ? resolveBlockSession(block) : null;
    widgets.push(documentBlockDecoration(block, session));
  }
  return widgets;
};

const buildDocumentBlockDecorations = (state, blocks, editingBlock) => {
  const widgets = collectBlockWidgets(state, blocks, editingBlock, () => true);
  performanceStats.documentBlocks = blocks.length;
  performanceStats.documentBlockTypes = blocks.reduce((counts, block) => ({
    ...counts,
    [block.type]: (counts[block.type] || 0) + 1,
  }), {});
  return Decoration.set(widgets, true);
};

const updateDocumentBlockDecorations = (state, blocks, editingBlock, previous, ranges) => {
  const relevant = ranges.filter((range) => range.to >= range.from);
  if (!relevant.length) return previous;
  const additions = collectBlockWidgets(
    state,
    blocks,
    editingBlock,
    (block) => relevant.some((range) => block.from <= range.to && block.to >= range.from),
  );
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
      editingBlock = findEditableBlock(blocks, from, to);
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
          ? findBlockAt(blocks, effect.value.from, effect.value.to)
          : null;
        if (editingBlock && (editingBlock.from !== effect.value.from || editingBlock.to !== effect.value.to)) {
          editingBlock = null;
        }
      }
    }
    if (!editingBlock && transaction.docChanged) {
      const selection = transaction.state.selection.main;
      editingBlock = findEditableBlock(blocks, selection.from, selection.to);
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
  const strongDelimiterPattern = /\*\*(?=\S)([\s\S]*?\S)\*\*/g;
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
        // The ATX marker is collapsed rather than merely hidden: leaving its width in place
        // would draw the heading underline under empty space.
        if (node.name === 'HeaderMark') {
          const line = view.state.doc.lineAt(node.from);
          if (/^(#{1,6})\s/.test(line.text)) {
            decorations.push(Decoration.replace({}).range(node.from, node.to + 1));
          }
          return false;
        }
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
          if (parent?.name === 'StrongEmphasis') return;
          if (node.name === 'EmphasisMark' && (
            view.state.sliceDoc(node.from, node.to) === '**' ||
            view.state.sliceDoc(Math.max(0, node.from - 1), node.from) === '*' ||
            view.state.sliceDoc(node.to, Math.min(view.state.doc.length, node.to + 1)) === '*'
          )) return;
          if (!cursorInside(parent)) {
            decorations.push(Decoration.mark({
              class: 'paper-reader-cm-mark-hidden',
            }).range(node.from, node.to));
          }
        }
      },
    });

    strongDelimiterPattern.lastIndex = 0;
    let strongMatch;
    while ((strongMatch = strongDelimiterPattern.exec(range.text))) {
      const from = range.from + strongMatch.index;
      const to = from + strongMatch[0].length;
      if (isInsideAnyBlock(documentBlocks, from, to)) continue;
      const startNode = tree.resolve(from + 1, -1);
      let inlineCode = false;
      for (let current = startNode; current; current = current.parent) {
        if (current.name === 'InlineCode') {
          inlineCode = true;
          break;
        }
      }
      if (inlineCode) continue;
      decorations.push(Decoration.mark({
        class: 'paper-reader-cm-mark-hidden',
      }).range(from, from + 2));
      decorations.push(Decoration.mark({
        class: 'paper-reader-cm-mark-hidden',
      }).range(to - 2, to));
    }

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
    flushTableSession(tableSession);
    handler.emit('save', normalizeDisplayMathDelimiters(view.state.doc.toString()));
  }, 120);
};

const saveNow = () => {
  if (!view) return;
  window.clearTimeout(saveTimer);
  flushTableSession(tableSession);
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

const clearEmptyHeading = () => {
  if (!view) return false;
  const selection = view.state.selection.main;
  if (!selection.empty) return false;
  const line = view.state.doc.lineAt(selection.head);
  if (!/^#{1,6}[ \t]+$/.test(line.text) || selection.head !== line.to) return false;
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: '' },
    selection: { anchor: line.from },
  });
  return true;
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
    case 'table-source':
      editTableSource();
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
  window.paperReaderMarkdownVersion = payload.extensionVersion || 'unknown';
  document.documentElement.dataset.paperReaderVersion = window.paperReaderMarkdownVersion;
  applyFontSizes(payload.config?.fontSizes);
  const shortcut = (command) => () => {
    runToolbarCommand(command);
    return true;
  };
  const extensions = [
    history(),
    search({ top: true }),
    Prec.highest(keymap.of([
      { key: 'Backspace', run: clearEmptyHeading },
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
      // Keep the reported selection current for every transaction. Visible-decoration
      // passes also record it, but they do not run for every selection change, so
      // diagnostics and tests must not depend on when that pass last happened.
      const main = update.state.selection.main;
      performanceStats.selectionFrom = main.from;
      performanceStats.selectionTo = main.to;
      performanceStats.selectionText = update.state.sliceDoc(main.from, main.to);
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
      '.cm-content': {
        padding: '18px 24px',
        minHeight: '100%',
        width: '100%',
        minWidth: '100%',
        boxSizing: 'border-box',
      },
      '.cm-gutters': { backgroundColor: 'var(--vscode-editor-background)', border: 'none' },
      '.cm-line': {
        width: '100%',
        minWidth: '100%',
        maxWidth: 'none',
        margin: '0',
        boxSizing: 'border-box',
      },
      '.cm-activeLine': { backgroundColor: 'transparent' },
      '.cm-selectionBackground, ::selection': { backgroundColor: 'var(--vscode-editor-selectionBackground)' },
    }),
  ];
  view = new EditorView({
    state: EditorState.create({ doc: normalizeDisplayMathDelimiters(payload.content || ''), extensions }),
    parent: root,
  });
  bindTableControlActivation(view);
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
    const tableCell = event.target instanceof Element
      ? event.target.closest('.paper-reader-cm-cell')
      : null;
    if (tableCell) {
      // Leave the cell mousedown alone so the browser can place and drag the caret inside
      // the cell. The activation handler only takes over the editor selection.
      return;
    }
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
  if (!view) return;
  // Pending cell text is only in the DOM; flush it before comparing with the host copy
  // so an in-flight update can never drop the user's typing.
  flushTableSession(tableSession);
  if (view.state.doc.toString() === content) return;
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

const tableBlockForSelection = (editorView) => {
  if (!editorView) return null;
  const selection = editorView.state.selection.main;
  const blocks = editorView.state.field(documentBlockPreview).blocks;
  return blocks.find((block) => block.type === 'table' &&
    block.from <= selection.from && block.to >= selection.to) ||
    blocks.find((block) => block.type === 'table' &&
      block.from <= selection.head && block.to >= selection.head) ||
    null;
};

// Explicit escape hatch: Markdown source for a table is still reachable, it is just no
// longer a side effect of clicking or selecting inside the table.
const editTableSource = () => {
  if (!view) return false;
  const block = tableBlockForSelection(view);
  if (!block) return false;
  flushTableSession(tableSession, { force: true });
  tableSession = null;
  view.dispatch({
    effects: editingBlockUpdate.of({ from: block.from, to: block.to }),
    selection: { anchor: block.from },
    scrollIntoView: true,
  });
  view.focus();
  return true;
};

// Read-only hooks used by the browser regression suite for live table editing.
Object.defineProperties(performanceStats, {
  tableRows: {
    get: () => {
      const session = tableSession;
      const block = view && session
        ? view.state.field(documentBlockPreview).blocks.find((entry) =>
          entry.type === 'table' && entry.from <= session.to && entry.to >= session.from)
        : null;
      return block ? [block.headers, ...block.rows] : [];
    },
  },
  tableCells: {
    get: () => {
      const host = document.querySelector('.paper-reader-cm-table');
      if (!host) return [];
      return [...host.querySelectorAll('tr')].map((row) =>
        [...row.querySelectorAll('.paper-reader-cm-cell')].map((cell) => cell.textContent));
    },
  },
  tableControlCount: {
    get: () => document.querySelectorAll('.paper-reader-cm-table-controls [data-table-action]').length,
  },
  tableSessionState: {
    get: () => (tableSession ? {
      id: tableSession.id,
      from: tableSession.from,
      to: tableSession.to,
      structure: tableSession.structure,
      dirty: tableSession.dirty,
      live: tableSession.live,
    } : null),
  },
  flushTableCells: {
    value: () => flushTableSession(tableSession, { force: true }),
  },
  tableCellAt: {
    value: (rowIndex, columnIndex) =>
      cellHostAt(document.querySelector('.paper-reader-cm-table'), rowIndex, columnIndex),
  },
  editTableSource: {
    value: () => editTableSource(),
  },
  tableBlockForSelectionNow: {
    value: () => {
      const block = tableBlockForSelection(view);
      return block ? { from: block.from, to: block.to } : null;
    },
  },
  tableControls: {
    get: () => [...document.querySelectorAll('.paper-reader-cm-table-controls [data-table-action]')]
      .map((button) => ({
        action: button.dataset.tableAction,
        index: button.dataset.tableIndex,
        text: button.textContent,
        visible: button.getBoundingClientRect().width > 0,
        registered: typeof TABLE_CONTROL_ACTIONS[button.dataset.tableAction] === 'function',
      })),
  },
  runTableControl: {
    value: (action, index) => {
      const result = runTableControl(tableSession, action, Number(index || 0));
      performanceStats.lastTableControlResult = { action, index: Number(index || 0), result };
      return result;
    },
  },
  lastTableControl: {
    get: () => performanceStats.lastTableControlResult || null,
  },
  visibleTableControl: {
    get: () => {
      const button = document.querySelector('.paper-reader-cm-table-control--visible');
      return button ? button.dataset.tableAction : null;
    },
  },
  visibleTableControls: {
    get: () => [...document.querySelectorAll('.paper-reader-cm-table-control--visible')]
      .map((button) => `${button.dataset.tableAction}:${button.dataset.tableIndex}`),
  },
  tableControlRects: {
    get: () => [...document.querySelectorAll('.paper-reader-cm-table-control')].map((button) => {
      const rect = button.getBoundingClientRect();
      return {
        id: `${button.dataset.tableAction}:${button.dataset.tableIndex}`,
        boundary: button.dataset.boundary || null,
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    }),
  },
  hideTableControls: {
    value: () => showTableControls(tableSession, []),
  },
  resolveTableControlAt: {
    value: (x, y) => {
      const session = tableSession;
      if (!session?.resolveControlsAt) return null;
      const target = document.elementFromPoint(x, y);
      const resolved = session.resolveControlsAt({ clientX: x, clientY: y, target })
        .map((button) => `${button.dataset.tableAction}:${button.dataset.tableIndex}`);
      return resolved;
    },
  },
  boundaryPoints: {
    // One probe per zone, at the exact spot the zone is defined around: a row's centre line
    // (delete row), the junction below a row (insert row), a column's centre (delete column)
    // and the junction right of a column (insert column). Each carries the action it must
    // resolve to, so tests can assert placement and meaning together.
    value: () => {
      const session = tableSession;
      if (!session) return [];
      const table = document.querySelector('.paper-reader-cm-table table') || session.element;
      if (!table) return [];
      const headers = [...table.querySelectorAll('thead th .paper-reader-cm-cell')];
      const rows = [...table.querySelectorAll('tbody tr')];
      const points = [];
      rows.forEach((row, index) => {
        const rect = row.getBoundingClientRect();
        const middleX = Math.round((rect.left + rect.right) / 2);
        points.push({ key: `row-${index}`, expect: 'deleteRow', x: middleX, y: Math.round((rect.top + rect.bottom) / 2) });
        points.push({ key: `row-junction-${index}`, expect: 'insertRow', x: middleX, y: Math.round(rect.bottom) });
      });
      headers.forEach((cell, index) => {
        const rect = cell.getBoundingClientRect();
        // Probe each control at the exact point it was placed at, so the assertion is about
        // where the button really is rather than where the geometry suggests it should be.
        const anchors = session.controlAnchorPoints || {};
        const probeY = Math.round(rect.top + Math.min(6, rect.height / 2));
        const deleteAnchor = anchors[`deleteColumn:${index}`];
        points.push({
          key: `column-${index}`,
          expect: 'deleteColumn',
          x: Math.round(deleteAnchor ? deleteAnchor.x : (rect.left + rect.right) / 2),
          y: deleteAnchor ? Math.round(deleteAnchor.y) : probeY,
        });
        const insertAnchor = anchors[`insertColumn:${index}`] || anchors[`appendColumn:${index}`];
        if (index < headers.length - 1 && insertAnchor) {
          points.push({
            key: `col-junction-${index}`,
            expect: 'insertColumn',
            x: Math.round(insertAnchor.x),
            y: Math.round(insertAnchor.y),
          });
        }
      });
      return points;
    },
  },
});

handler.emit('init');
