import { EditorState, StateEffect, StateField } from '@codemirror/state';
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
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { openSearchPanel, search, searchKeymap } from '@codemirror/search';
import katex from 'katex';

const handler = window.handler;
const performanceStats = {
  updates: 0,
  documentChanges: 0,
  visibleScanChars: 0,
  renderedWidgets: 0,
  lastUpdateMs: 0,
  maxUpdateMs: 0,
};
window.paperReaderMarkdownPerformance = performanceStats;
const noteUpdate = StateEffect.define();
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
  return selection.from <= to && selection.to >= from;
};

const activateRange = (node, from, to) => {
  const editorView = EditorView.findFromDOM(node);
  editorView.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
  editorView.focus();
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
    return other.source === this.source && other.displayMode === this.displayMode;
  }

  get estimatedHeight() {
    return this.displayMode ? 72 : -1;
  }

  toDOM() {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = this.displayMode
      ? 'paper-reader-cm-math'
      : 'paper-reader-cm-inline-math';
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
    node.addEventListener('click', () => activateRange(node, this.from, this.to));
    return node;
  }

  ignoreEvent(event) {
    return event.type !== 'click';
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
    return other.kind === this.kind && other.text === this.text;
  }

  toDOM() {
    const node = document.createElement(this.kind);
    node.className = 'paper-reader-cm-script';
    node.textContent = this.text;
    node.title = 'Click to edit Markdown source';
    node.addEventListener('click', () => activateRange(node, this.from, this.to));
    return node;
  }

  ignoreEvent(event) {
    return event.type !== 'click';
  }
}

class ImageWidget extends WidgetType {
  constructor(alt, url, from, to) {
    super();
    this.alt = alt;
    this.url = url;
    this.from = from;
    this.to = to;
  }

  eq(other) {
    return other.url === this.url && other.alt === this.alt;
  }

  get estimatedHeight() {
    return 360;
  }

  toDOM() {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'paper-reader-cm-image';
    node.title = 'Click to edit Markdown image';
    const image = document.createElement('img');
    image.alt = this.alt;
    image.src = this.url;
    image.loading = 'lazy';
    image.decoding = 'async';
    node.appendChild(image);
    node.addEventListener('click', () => activateRange(node, this.from, this.to));
    return node;
  }

  ignoreEvent(event) {
    return event.type !== 'click';
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
    icon.className = 'codicon codicon-notebook';
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

const collectDocumentBlocks = (state) => {
  const source = state.doc.toString();
  const blocks = [];
  mathPattern.lastIndex = 0;
  let match;
  while ((match = mathPattern.exec(source))) {
    const raw = match[0];
    const from = match.index + (raw.startsWith('\n') ? 1 : 0);
    const to = match.index + raw.length;
    const formula = match[2].trim();
    if (formula) blocks.push({ type: 'math', from, to, source: formula });
  }
  imagePattern.lastIndex = 0;
  while ((match = imagePattern.exec(source))) {
    blocks.push({
      type: 'image',
      from: match.index,
      to: match.index + match[0].length,
      alt: match[1],
      url: match[2],
    });
  }
  return blocks.sort((left, right) => left.from - right.from || left.to - right.to);
};

const buildDocumentBlockDecorations = (state, blocks) => {
  const decorations = [];
  for (const block of blocks) {
    if (intersectsSelection(state, block.from, block.to)) continue;
    const widget = block.type === 'math'
      ? new MathWidget(block.source, block.from, block.to, true)
      : new ImageWidget(block.alt, block.url, block.from, block.to);
    decorations.push(
      Decoration.replace({ widget, block: true }).range(block.from, block.to),
    );
  }
  performanceStats.documentBlocks = blocks.length;
  return Decoration.set(decorations, true);
};

const documentBlockPreview = StateField.define({
  create(state) {
    const blocks = collectDocumentBlocks(state);
    return { blocks, decorations: buildDocumentBlockDecorations(state, blocks) };
  },
  update(value, transaction) {
    const blocks = transaction.docChanged
      ? collectDocumentBlocks(transaction.state)
      : value.blocks;
    if (transaction.docChanged || transaction.selection) {
      return {
        blocks,
        decorations: buildDocumentBlockDecorations(transaction.state, blocks),
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
  const visibleRanges = visibleDocumentText(view);
  for (const range of visibleRanges) {
    let match;
    inlineMathPattern.lastIndex = 0;
    while ((match = inlineMathPattern.exec(range.text))) {
      const prefixLength = match[1].length;
      const from = range.from + match.index + prefixLength;
      const to = from + match[0].length - prefixLength;
      if (intersectsSelection(view, from, to)) continue;
      decorations.push(
        Decoration.replace({
          widget: new MathWidget(match[2].trim(), from, to, false),
        }).range(from, to),
      );
    }

    superscriptPattern.lastIndex = 0;
    while ((match = superscriptPattern.exec(range.text))) {
      if (match[1].toLowerCase() !== match[3].toLowerCase()) continue;
      const from = range.from + match.index;
      const to = from + match[0].length;
      if (intersectsSelection(view, from, to)) continue;
      decorations.push(
        Decoration.replace({
          widget: new ScriptWidget(
            match[1].toLowerCase(),
            match[2],
            from,
            to,
          ),
        }).range(from, to),
      );
    }

    for (let lineNumber = view.state.doc.lineAt(range.from).number;
      lineNumber <= view.state.doc.lineAt(range.to).number;
      lineNumber += 1) {
      const line = view.state.doc.line(lineNumber);
      const heading = /^(#{1,6})\s+/.exec(line.text);
      if (!heading || intersectsSelection(view, line.from, line.to)) continue;
      decorations.push(
        Decoration.line({ class: `paper-reader-cm-heading-${heading[1].length}` }).range(
          line.from,
        ),
      );
      decorations.push(
        Decoration.replace({}).range(line.from, line.from + heading[0].length),
      );
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
  performanceStats.maxUpdateMs = Math.max(
    performanceStats.maxUpdateMs,
    performanceStats.lastUpdateMs,
  );
  return Decoration.set(decorations, true);
};

const livePreview = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = buildVisibleDecorations(view);
    }

    update(update) {
      performanceStats.updates += 1;
      if (update.docChanged) performanceStats.documentChanges += 1;
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        update.transactions.some((transaction) =>
          transaction.effects.some((effect) => effect.is(noteUpdate)),
        )
      ) {
        this.decorations = buildVisibleDecorations(update.view);
      }
    }
  },
  { decorations: (value) => value.decorations },
);

const root = document.getElementById('paper-reader-editor');
const toolbar = document.getElementById('paper-reader-toolbar');
const outline = document.getElementById('paper-reader-outline');
const menu = document.getElementById('paper-reader-context-menu');
let view;
let pendingSelection = null;
let saveTimer = 0;
let outlineTimer = 0;
let opened = false;

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

const cycleHeading = () => {
  if (!view) return;
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const current = /^(#{1,6})\s+/.exec(line.text);
  const level = current ? (current[1].length % 6) + 1 : 1;
  const marker = `${'#'.repeat(level)} `;
  view.dispatch({
    changes: {
      from: line.from,
      to: line.from + (current ? current[0].length : 0),
      insert: marker,
    },
    scrollIntoView: true,
  });
  view.focus();
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
    case 'bold': replaceSelection('**', '**', 'text'); break;
    case 'italic': replaceSelection('*', '*', 'text'); break;
    case 'strike': replaceSelection('~~', '~~', 'text'); break;
    case 'link': replaceSelection('[', '](https://)', 'text'); break;
    case 'unordered-list': prefixSelectedLines(() => '- '); break;
    case 'ordered-list': prefixSelectedLines((index) => `${index + 1}. `); break;
    case 'checklist': prefixSelectedLines(() => '- [ ] '); break;
    case 'quote': prefixSelectedLines(() => '> '); break;
    case 'inline-code': replaceSelection('`', '`', 'code'); break;
    case 'code-block': insertBlock('```\ncode\n```', 4, 4); break;
    case 'table':
      insertBlock('| Column 1 | Column 2 |\n| --- | --- |\n| Value | Value |', 2, 8);
      break;
    case 'math': insertBlock('$$\nformula\n$$', 3, 7); break;
    case 'image': replaceSelection('![', '](assets/image.png)', 'alt'); break;
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

const createView = (payload) => {
  const extensions = [
    history(),
    search({ top: true }),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
    markdown({ base: markdownLanguage }),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    noteState,
    documentBlockPreview,
    livePreview,
    EditorView.lineWrapping,
    EditorView.updateListener.of((update) => {
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
  view.dom.addEventListener('contextmenu', showMenu);
  document.addEventListener('click', (event) => {
    if (!menu?.contains(event.target)) hideMenu();
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
  if (!opened) createView(payload);
  handler.emit('loadMarkdownAnnotations');
});
handler.on('update', (content) => {
  if (!view || view.state.doc.toString() === content) return;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: normalizeDisplayMathDelimiters(content) } });
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
handler.on('gotoBlock', (fragment) => {
  if (!view || !fragment) return;
  const index = view.state.doc.toString().indexOf(fragment);
  if (index >= 0) view.dispatch({ selection: { anchor: index }, scrollIntoView: true });
});
handler.emit('init');
