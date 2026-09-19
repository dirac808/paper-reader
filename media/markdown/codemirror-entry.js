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
} from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
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
  const selection = view.state.selection.main;
  return selection.from <= to && selection.to >= from;
};

class MathWidget extends WidgetType {
  constructor(source, from, to, activate) {
    super();
    this.source = source;
    this.from = from;
    this.to = to;
    this.activate = activate;
  }

  eq(other) {
    return other.source === this.source;
  }

  toDOM() {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'paper-reader-cm-math';
    node.title = 'Click to edit Markdown formula';
    node.setAttribute('aria-label', 'Edit formula source');
    try {
      node.innerHTML = katex.renderToString(this.source, {
        displayMode: true,
        throwOnError: false,
        strict: 'ignore',
      });
    } catch {
      const fallback = document.createElement('code');
      fallback.textContent = this.source;
      node.appendChild(fallback);
    }
    node.addEventListener('click', () => this.activate(this.from, this.to));
    return node;
  }

  ignoreEvent(event) {
    return event.type !== 'click';
  }
}

class ImageWidget extends WidgetType {
  constructor(alt, url, from, to, activate) {
    super();
    this.alt = alt;
    this.url = url;
    this.from = from;
    this.to = to;
    this.activate = activate;
  }

  eq(other) {
    return other.url === this.url && other.alt === this.alt;
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
    node.addEventListener('click', () => this.activate(this.from, this.to));
    return node;
  }

  ignoreEvent(event) {
    return event.type !== 'click';
  }
}

class NoteAnchorWidget extends WidgetType {
  constructor(annotation, open) {
    super();
    this.annotation = annotation;
    this.open = open;
  }

  eq(other) {
    return other.annotation.id === this.annotation.id;
  }

  toDOM() {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'paper-reader-cm-note-anchor';
    node.title = 'Open note';
    node.setAttribute('aria-label', 'Open note');
    node.textContent = 'N';
    node.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.open(this.annotation.id);
    });
    return node;
  }
}

const buildVisibleDecorations = (view) => {
  const started = performance.now();
  const decorations = [];
  const visibleRanges = visibleDocumentText(view);
  const activate = (from, to) =>
    view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });

  for (const range of visibleRanges) {
    mathPattern.lastIndex = 0;
    let match;
    while ((match = mathPattern.exec(range.text))) {
      const raw = match[0];
      const from = range.from + match.index + (raw.startsWith('\n') ? 1 : 0);
      const to = range.from + match.index + raw.length;
      if (intersectsSelection(view, from, to)) continue;
      const source = match[2].trim();
      if (!source) continue;
      decorations.push(
        Decoration.replace({
          widget: new MathWidget(source, from, to, activate),
          block: true,
        }).range(from, to),
      );
    }

    imagePattern.lastIndex = 0;
    while ((match = imagePattern.exec(range.text))) {
      const from = range.from + match.index;
      const to = from + match[0].length;
      if (intersectsSelection(view, from, to)) continue;
      decorations.push(
        Decoration.replace({
          widget: new ImageWidget(match[1], match[2], from, to, activate),
          block: true,
        }).range(from, to),
      );
    }
  }

  const notes = view.state.field(noteState);
  const visibleStart = view.visibleRanges.length ? view.visibleRanges[0].from : 0;
  const visibleEnd = view.visibleRanges.length
    ? view.visibleRanges[view.visibleRanges.length - 1].to
    : 0;
  for (const annotation of notes) {
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
        widget: new NoteAnchorWidget(annotation.annotation, (id) =>
          handler.emit('openMarkdownAnnotationNote', id),
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
const menu = document.getElementById('paper-reader-context-menu');
let view;
let pendingSelection = null;
let pendingOpen;
let saveTimer = 0;
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
  menu.style.left = `${Math.min(event.clientX, window.innerWidth - 220)}px`;
  menu.style.top = `${Math.min(event.clientY, window.innerHeight - 90)}px`;
};

const scheduleSave = () => {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    handler.emit('save', normalizeDisplayMathDelimiters(view.state.doc.toString()));
  }, 120);
};

const createView = (payload) => {
  const extensions = [
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    markdown({ base: markdownLanguage }),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    noteState,
    livePreview,
    EditorView.lineWrapping,
    EditorView.updateListener.of((update) => {
      if (update.docChanged) scheduleSave();
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
    const from = source.indexOf(text);
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
