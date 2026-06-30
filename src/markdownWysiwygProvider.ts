import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { sendMarkdownTextToCodex } from './codexBridge';
import { NoteStore } from './noteStore';

type WebviewMessage = {
  type: string;
  content?: unknown;
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

function getMarkdownConfig(): MarkdownOpenPayload['config'] {
  const config = vscode.workspace.getConfiguration();
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
  const normalized = content.replace(/\r/g, '');
  if (document.getText().replace(/\r/g, '') === normalized) {
    return true;
  }
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    document.uri,
    new vscode.Range(0, 0, document.lineCount, 0),
    normalized
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
      }, 400);
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
      config: getMarkdownConfig(),
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
            if (
              typeof message.content !== 'string' ||
              !message.content.trim()
            ) {
              vscode.window.showErrorMessage(
                'Please select Markdown text to add to Paper Reader notes.'
              );
              break;
            }
            (await this.getNoteStore()).appendToDefaultNote(
              [
                `## From ${vscode.workspace.asRelativePath(
                  document.uri,
                  false
                )}`,
                '',
                message.content
                  .trim()
                  .split(/\r?\n/)
                  .map((line) => `> ${line}`)
                  .join('\n'),
              ].join('\n')
            );
            vscode.window.showInformationMessage(
              'Selection added to Paper Reader notes.'
            );
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
