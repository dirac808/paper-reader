import * as vscode from 'vscode';
import { NoteStore } from './noteStore';

export class NotesPanel {
  public static readonly viewType = 'dipe.notes';
  private static currentPanel: NotesPanel | undefined;

  public static show(context: vscode.ExtensionContext, store: NoteStore): void {
    if (NotesPanel.currentPanel) {
      NotesPanel.currentPanel.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      NotesPanel.viewType,
      'Paper Reader Notes',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );
    NotesPanel.currentPanel = new NotesPanel(panel, context, store);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly store: NoteStore
  ) {
    this.panel.webview.html = this.getHtml();
    this.panel.onDidDispose(() => {
      NotesPanel.currentPanel = undefined;
    });
    this.panel.webview.onDidReceiveMessage((message) => {
      switch (message.command) {
        case 'ready': {
          const note = this.store.getOrCreateDefaultNote();
          this.panel.webview.postMessage({ command: 'loaded', note });
          break;
        }
        case 'save': {
          const note = this.store.saveNote(
            message.id,
            String(message.content || '')
          );
          this.panel.webview.postMessage({ command: 'saved', note });
          break;
        }
      }
    });
  }

  private getHtml(): string {
    const nonce = `${Date.now()}${Math.random().toString(16).slice(2)}`;
    const cspSource = this.panel.webview.cspSource;
    const codemirrorCss =
      'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/codemirror.min.css';
    const codemirrorJs =
      'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/codemirror.min.js';
    const markdownModeJs =
      'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/markdown/markdown.min.js';
    const xmlModeJs =
      'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/xml/xml.min.js';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' https://cdnjs.cloudflare.com; style-src 'unsafe-inline' https://cdnjs.cloudflare.com ${cspSource};">
  <link rel="stylesheet" href="${codemirrorCss}">
  <style>
    html, body { height: 100%; margin: 0; overflow: hidden; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
    .toolbar { height: 40px; display: flex; align-items: center; gap: 8px; padding: 0 10px; border-bottom: 1px solid var(--vscode-panel-border); box-sizing: border-box; }
    .title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .status { margin-left: auto; opacity: 0.75; font-size: 12px; }
    button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; padding: 4px 10px; cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    #editor { height: calc(100% - 40px); }
    .CodeMirror { height: 100%; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); }
    .CodeMirror-lines, .CodeMirror pre, .CodeMirror-code, .CodeMirror-code span { color: var(--vscode-editor-foreground) !important; }
    .CodeMirror-gutters { background: var(--vscode-editorGutter-background); border-right: 1px solid var(--vscode-panel-border); }
    .CodeMirror-linenumber { color: var(--vscode-editorLineNumber-foreground); }
    .CodeMirror-cursor { border-left-color: var(--vscode-editorCursor-foreground); }
    .CodeMirror-selected { background: var(--vscode-editor-selectionBackground) !important; }
    .cm-dipe-wikilink { color: var(--vscode-textLink-foreground); font-weight: 600; }
    .cm-dipe-tag { color: var(--vscode-charts-green); font-weight: 600; }
  </style>
</head>
<body>
  <div class="toolbar">
    <button id="save">Save</button>
    <div class="title" id="title">Paper Reader Notes</div>
    <div class="status" id="status">Loading</div>
  </div>
  <textarea id="editor"></textarea>
  <script nonce="${nonce}" src="${codemirrorJs}"></script>
  <script nonce="${nonce}" src="${xmlModeJs}"></script>
  <script nonce="${nonce}" src="${markdownModeJs}"></script>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let currentNoteId;
    let saveTimer;
    const status = document.getElementById('status');
    const title = document.getElementById('title');
    const editor = CodeMirror.fromTextArea(document.getElementById('editor'), {
      mode: 'markdown',
      lineNumbers: true,
      lineWrapping: true,
      viewportMargin: Infinity
    });

    editor.addOverlay({
      token(stream) {
        if (stream.match(/\\[\\[[^\\]\\n]+\\]\\]/)) return 'dipe-wikilink';
        if (stream.match(/(^|[\\s([{])#[A-Za-z0-9_\\-\\u4e00-\\u9fa5]+/)) return 'dipe-tag';
        stream.next();
        return null;
      }
    });

    function setStatus(value) {
      status.textContent = value;
    }

    function save() {
      vscode.postMessage({ command: 'save', id: currentNoteId, content: editor.getValue() });
      setStatus('Saving');
    }

    editor.on('change', () => {
      setStatus('Unsaved');
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(save, 1200);
    });

    document.getElementById('save').addEventListener('click', save);
    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.command === 'loaded' || message.command === 'saved') {
        currentNoteId = message.note.id;
        title.textContent = message.note.title;
        if (message.command === 'loaded') {
          editor.setValue(message.note.content);
          editor.clearHistory();
        }
        setStatus(message.command === 'saved' ? 'Saved' : 'Ready');
      }
    });
    vscode.postMessage({ command: 'ready' });
  </script>
</body>
</html>`;
  }
}
