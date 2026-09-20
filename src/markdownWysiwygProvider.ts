import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import * as vscode from 'vscode';
import { sendMarkdownTextToCodex } from './codexBridge';
import { NoteStore } from './noteStore';
import { computeMinimalTextChange, normalizeLineEndings } from './textChange';

type WebviewMessage = {
  type: string;
  content?: unknown;
};

type MarkdownSelectionAnchor = {
  selectedText?: unknown;
  prefixText?: unknown;
  suffixText?: unknown;
  textOffset?: unknown;
};

type MarkdownOpenPayload = {
  content: string;
  rootPath: string;
  documentCacheId: string;
  config: {
    editMode: 'wysiwyg' | 'ir';
    editorTheme: string;
    codeMirrorTheme: string;
    mermaidTheme: string;
    language: string;
    isWeb: boolean;
    isDev: boolean;
    fontSizes: {
      body: number;
      inlineMath: number;
      displayMath: number;
    };
    markdown: {
      math: {
        macros: Record<string, string>;
      };
    };
  };
};

const MARKDOWN_VIEW_TYPE = 'paper-reader.markdownEditor';

function getMarkdownResourceRoot(context: vscode.ExtensionContext): vscode.Uri {
  return vscode.Uri.file(path.join(context.extensionPath, 'media', 'markdown'));
}

function getUriFolder(uri: vscode.Uri): vscode.Uri {
  return vscode.Uri.file(path.dirname(uri.fsPath));
}

function rewriteResourcePaths(
  html: string,
  webview: vscode.Webview,
  resourceRoot: vscode.Uri
): string {
  return html.replace(
    /((?:src|href)=["'])(?!https?:|#|data:|mailto:|javascript:|blob:|\/\/)(.+?)(["'])/gi,
    (_match, prefix: string, resourcePath: string, suffix: string) => {
      const normalized = resourcePath.replace(/^\.\//, '');
      const target = vscode.Uri.file(
        path.normalize(path.join(resourceRoot.fsPath, normalized))
      );
      return `${prefix}${webview.asWebviewUri(target)}${suffix}`;
    }
  );
}

function readMarkdownHtml(
  context: vscode.ExtensionContext,
  webview: vscode.Webview,
  documentFolder: vscode.Uri
): string {
  const resourceRoot = getMarkdownResourceRoot(context);
  const htmlPath = path.join(resourceRoot.fsPath, 'index.html');
  const baseUrl = webview
    .asWebviewUri(documentFolder)
    .toString()
    .replace(/\?.+$/, '');
  const html = fs
    .readFileSync(htmlPath, 'utf8')
    .replace('{{baseUrl}}', baseUrl);
  return rewriteResourcePaths(html, webview, resourceRoot);
}

function getMarkdownConfig(
  resource?: vscode.Uri
): MarkdownOpenPayload['config'] {
  const config = vscode.workspace.getConfiguration(undefined, resource);
  const get = <T>(key: string, defaultValue: T): T => {
    const value = config.get<T>(`paper-reader.markdown.${key}`);
    return value === undefined ? defaultValue : value;
  };
  const markdownConfig = vscode.workspace.getConfiguration('markdown');
  return {
    editMode: get<'wysiwyg' | 'ir'>('editMode', 'wysiwyg'),
    editorTheme: get<string>('editorTheme', 'Auto'),
    codeMirrorTheme: get<string>('codeMirrorTheme', 'Auto'),
    mermaidTheme: get<string>('mermaidTheme', 'Auto'),
    language: vscode.env.language,
    isWeb: false,
    isDev: false,
    fontSizes: {
      body: get<number>('bodyFontSize', 14),
      inlineMath: get<number>('inlineMathFontSize', 15),
      displayMath: get<number>('displayMathFontSize', 18),
    },
    markdown: {
      math: {
        macros: markdownConfig.get<Record<string, string>>('math.macros', {}),
      },
    },
  };
}

async function updateTextDocument(
  document: vscode.TextDocument,
  content: string
): Promise<boolean> {
  const normalized = normalizeLineEndings(
    content,
    document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n'
  );
  const current = document.getText();
  if (current === normalized) {
    return true;
  }
  const change = computeMinimalTextChange(current, normalized);
  if (!change) {
    return true;
  }
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    document.uri,
    new vscode.Range(
      document.positionAt(change.start),
      document.positionAt(change.end)
    ),
    change.text
  );
  return vscode.workspace.applyEdit(edit);
}

async function openMarkdownLink(
  document: vscode.TextDocument,
  link: string
): Promise<void> {
  if (!link) {
    return;
  }
  if (/^https?:\/\//i.test(link)) {
    await vscode.env.openExternal(vscode.Uri.parse(link));
    return;
  }

  const cleanLink = decodeURIComponent(link.replace(/^file:\/\//i, ''));
  const target = path.isAbsolute(cleanLink)
    ? cleanLink
    : path.join(path.dirname(document.uri.fsPath), cleanLink);
  await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(target), {
    preview: false,
  });
}

async function writeDroppedImage(
  document: vscode.TextDocument,
  payload: unknown
): Promise<void> {
  if (!payload || typeof payload !== 'object') {
    return;
  }
  const data = (payload as { data?: string }).data;
  const ext = (payload as { ext?: string }).ext || 'png';
  if (!data) {
    return;
  }

  const imageDirectory = path.join(path.dirname(document.uri.fsPath), 'assets');
  fs.mkdirSync(imageDirectory, { recursive: true });
  const fileName = `image-${Date.now()}.${ext.replace(/^\./, '')}`;
  const imagePath = path.join(imageDirectory, fileName);
  fs.writeFileSync(imagePath, Buffer.from(data, 'binary'));
  await vscode.env.clipboard.writeText(`![${fileName}](assets/${fileName})`);
  await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
}

function getDocumentHash(document: vscode.TextDocument): string {
  const hash = createHash('sha256');
  hash.update(document.uri.toString());
  return hash.digest('hex');
}

function getDocumentTitle(document: vscode.TextDocument): string {
  return path.basename(document.uri.fsPath || document.uri.path);
}

export async function openMarkdownNote(
  exportedPath: string | undefined
): Promise<void> {
  if (!exportedPath) {
    throw new Error('Markdown note file was not created.');
  }

  await vscode.commands.executeCommand(
    'vscode.openWith',
    vscode.Uri.file(exportedPath),
    MARKDOWN_VIEW_TYPE,
    vscode.ViewColumn.Beside
  );

  try {
    await vscode.commands.executeCommand(
      'workbench.action.moveEditorToNewWindow'
    );
  } catch {
    vscode.window.showInformationMessage(
      'Paper Reader note opened in the current window.'
    );
  }
}

export class MarkdownWysiwygProvider
  implements vscode.CustomTextEditorProvider {
  public static readonly viewType = MARKDOWN_VIEW_TYPE;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly getNoteStore: () => Promise<NoteStore>
  ) {}

  public resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel
  ): void {
    const webview = webviewPanel.webview;
    const documentFolder = getUriFolder(document.uri);
    const workspaceRoots =
      vscode.workspace.workspaceFolders?.map((folder) => folder.uri) || [];
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        this.context.extensionUri ||
          vscode.Uri.file(this.context.extensionPath),
        documentFolder,
        ...workspaceRoots,
      ],
    };

    let content = document.getText();
    let pendingContent: string | undefined;
    let syncTimer: NodeJS.Timer | undefined;

    const flush = async (): Promise<void> => {
      if (syncTimer) {
        clearTimeout(syncTimer);
        syncTimer = undefined;
      }
      if (pendingContent === undefined) {
        return;
      }
      const nextContent = pendingContent;
      pendingContent = undefined;
      content = nextContent;
      await updateTextDocument(document, nextContent);
    };

    const scheduleSync = (nextContent: string): void => {
      pendingContent = nextContent;
      content = nextContent;
      if (syncTimer) {
        clearTimeout(syncTimer);
      }
      syncTimer = setTimeout(() => {
        void flush();
      }, 150);
    };

    const emit = (type: string, messageContent?: unknown): void => {
      void webview.postMessage({ type, content: messageContent });
    };

    const openPayload = (): MarkdownOpenPayload => ({
      content,
      rootPath: webview
        .asWebviewUri(getMarkdownResourceRoot(this.context))
        .toString(),
      documentCacheId: `${document.uri.scheme}:${document.uri.toString()}`,
      config: getMarkdownConfig(document.uri),
    });

    const sendMarkdownAnnotations = async (): Promise<void> => {
      const store = await this.getNoteStore();
      emit(
        'markdownAnnotations',
        store.getMarkdownAnnotations(
          getDocumentHash(document),
          getDocumentTitle(document)
        )
      );
    };
    let annotationSubscription: vscode.Disposable | undefined;
    void this.getNoteStore().then((store) => {
      annotationSubscription = store.onDidChangeAnnotations((change) => {
        if (
          change.kind === 'markdown' &&
          change.documentHash === getDocumentHash(document)
        ) {
          void sendMarkdownAnnotations();
        }
      });
    });

    const documentSubscription = vscode.workspace.onDidChangeTextDocument(
      (event) => {
        if (
          event.document.uri.toString() !== document.uri.toString() ||
          event.contentChanges.length === 0
        ) {
          return;
        }
        const nextText = event.document.getText().replace(/\r/g, '');
        if (nextText === content.replace(/\r/g, '')) {
          return;
        }
        content = nextText;
        emit('update', nextText);
      }
    );

    webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      try {
        switch (message.type) {
          case 'init':
            emit('open', openPayload());
            break;
          case 'save':
            if (typeof message.content === 'string') {
              scheduleSync(message.content);
            }
            break;
          case 'doSave':
            if (typeof message.content === 'string') {
              pendingContent = message.content;
              await flush();
              await vscode.commands.executeCommand(
                'workbench.action.files.save'
              );
            }
            break;
          case 'updateMarkdownFontSizes':
            if (message.content && typeof message.content === 'object') {
              const requested = message.content as Record<string, unknown>;
              const clamp = (value: unknown, fallback: number): number => {
                const numeric = Number(value);
                return Number.isFinite(numeric)
                  ? Math.min(32, Math.max(10, Math.round(numeric)))
                  : fallback;
              };
              const fontSizes = {
                body: clamp(requested.body, 14),
                inlineMath: clamp(requested.inlineMath, 15),
                displayMath: clamp(requested.displayMath, 18),
              };
              const configuration = vscode.workspace.getConfiguration(
                'paper-reader',
                document.uri
              );
              const workspaceFolder = vscode.workspace.getWorkspaceFolder(
                document.uri
              );
              const target = workspaceFolder
                ? vscode.ConfigurationTarget.WorkspaceFolder
                : vscode.workspace.workspaceFolders?.length
                ? vscode.ConfigurationTarget.Workspace
                : vscode.ConfigurationTarget.Global;
              await configuration.update(
                'markdown.bodyFontSize',
                fontSizes.body,
                target
              );
              await configuration.update(
                'markdown.inlineMathFontSize',
                fontSizes.inlineMath,
                target
              );
              await configuration.update(
                'markdown.displayMathFontSize',
                fontSizes.displayMath,
                target
              );
              emit('markdownFontSizes', fontSizes);
            }
            break;
          case 'openLink':
            if (typeof message.content === 'string') {
              await openMarkdownLink(document, message.content);
            }
            break;
          case 'img':
            await writeDroppedImage(document, message.content);
            break;
          case 'sendSelectionToCodex':
            await sendMarkdownTextToCodex(
              message.content,
              vscode.workspace.asRelativePath(document.uri, false)
            );
            break;
          case 'addSelectionToNotes':
            if (!message.content || typeof message.content !== 'object') {
              vscode.window.showErrorMessage(
                'Please select Markdown text to create a Paper Reader note.'
              );
              break;
            }
            {
              const anchor = message.content as MarkdownSelectionAnchor;
              const selectedText = String(anchor.selectedText || '').trim();
              if (!selectedText) {
                vscode.window.showErrorMessage(
                  'Please select Markdown text to create a Paper Reader note.'
                );
                break;
              }
              const store = await this.getNoteStore();
              const annotation = store.saveMarkdownAnnotation({
                documentUri: document.uri.toString(),
                documentHash: getDocumentHash(document),
                documentTitle: getDocumentTitle(document),
                selectedText,
                prefixText: String(anchor.prefixText || ''),
                suffixText: String(anchor.suffixText || ''),
                textOffset: Number.isFinite(Number(anchor.textOffset))
                  ? Number(anchor.textOffset)
                  : -1,
                content: '## Note\n\n',
              });
              await sendMarkdownAnnotations();
              await openMarkdownNote(annotation.exportedPath);
              vscode.window.showInformationMessage('Markdown note created.');
            }
            break;
          case 'loadMarkdownAnnotations':
            await sendMarkdownAnnotations();
            break;
          case 'openMarkdownAnnotationNote':
            {
              const store = await this.getNoteStore();
              const ids = (Array.isArray(message.content)
                ? message.content
                : [message.content]
              )
                .map(Number)
                .filter(Number.isFinite);
              const annotations = ids
                .map((id) =>
                  store.getMarkdownAnnotation(
                    getDocumentHash(document),
                    id,
                    getDocumentTitle(document)
                  )
                )
                .filter(
                  (item): item is NonNullable<typeof item> => item !== undefined
                );
              let annotation = annotations[0];
              if (annotations.length > 1) {
                const selected = await vscode.window.showQuickPick(
                  annotations.map((item, index) => ({
                    label: `Note ${index + 1}`,
                    description: path.basename(item.exportedPath || ''),
                    annotation: item,
                  })),
                  { placeHolder: 'Select the note to open' }
                );
                annotation = selected?.annotation;
              }
              if (!annotation) {
                await sendMarkdownAnnotations();
                break;
              }
              await openMarkdownNote(annotation.exportedPath);
            }
            break;
          case 'deleteMarkdownAnnotation':
            (await this.getNoteStore()).deleteMarkdownAnnotation(
              getDocumentHash(document),
              Number(message.content)
            );
            await sendMarkdownAnnotations();
            break;
          case 'insertImage':
            vscode.window.showInformationMessage(
              'Paper Reader Markdown image picker is not enabled yet. Drag an image into the editor instead.'
            );
            break;
          case 'editInVSCode':
            await vscode.commands.executeCommand(
              'vscode.openWith',
              document.uri,
              'default',
              vscode.ViewColumn.Active
            );
            break;
          case 'queryAIAvailable':
            emit('aiAvailable', false);
            break;
          case 'queryVSCodeModels':
            emit('vscodeModels', []);
            break;
          case 'showInFolder':
            await vscode.commands.executeCommand(
              'revealFileInOS',
              document.uri
            );
            break;
          case 'developerTool':
            await vscode.commands.executeCommand(
              'workbench.action.toggleDevTools'
            );
            break;
          default:
            break;
        }
      } catch (error) {
        vscode.window.showErrorMessage(
          `Paper Reader Markdown editor error: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    });

    webviewPanel.onDidDispose(() => {
      void flush();
      documentSubscription.dispose();
      annotationSubscription?.dispose();
    });

    webview.html = readMarkdownHtml(this.context, webview, documentFolder);
  }
}

export async function openMarkdownWysiwyg(
  uri: vscode.Uri,
  viewColumn: vscode.ViewColumn = vscode.ViewColumn.Active
): Promise<void> {
  await vscode.commands.executeCommand(
    'vscode.openWith',
    uri,
    MarkdownWysiwygProvider.viewType,
    viewColumn
  );
}
