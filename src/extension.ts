import * as vscode from 'vscode';
import { createHash } from 'crypto';
import * as path from 'path';
import {
  sendEditorSelectionToCodex,
  sendPdfSelectionToCodex,
} from './codexBridge';
import {
  ConfigurationPanel,
  ConfigurationViewProvider,
} from './configurationPanel';
import { initializeConfigStorage } from './config';
import { runSelfCheck } from './diagnostics';
import { GraphPanel } from './graphPanel';
import { NotesPanel } from './notesPanel';
import { NoteStore } from './noteStore';
import { translatePdfToMarkdownWindow } from './paperTranslation';
import { PdfCustomProvider } from './pdfProvider';
import { extendMarkdownItWithMath } from './markdownMath';
import {
  MarkdownWysiwygProvider,
  openMarkdownWysiwyg,
} from './markdownWysiwygProvider';

function getStableDocumentHash(document: vscode.TextDocument): string {
  const hash = createHash('sha256');
  hash.update(document.uri.toString());
  return hash.digest('hex');
}

function getSelectionContext(
  document: vscode.TextDocument,
  selectedText: string
): { prefixText: string; suffixText: string } {
  const text = document.getText();
  const index = text.indexOf(selectedText);
  const contextSize = 80;
  if (index < 0) {
    return { prefixText: '', suffixText: '' };
  }
  return {
    prefixText: text.slice(Math.max(0, index - contextSize), index),
    suffixText: text.slice(
      index + selectedText.length,
      index + selectedText.length + contextSize
    ),
  };
}

async function openAnnotationMarkdown(
  exportedPath: string | undefined
): Promise<void> {
  if (!exportedPath) {
    throw new Error('Markdown note file was not created.');
  }
  const document = await vscode.workspace.openTextDocument(
    vscode.Uri.file(exportedPath)
  );
  await vscode.window.showTextDocument(document, {
    preview: false,
    preserveFocus: false,
    viewColumn: vscode.ViewColumn.Beside,
  });
}

export function activate(
  context: vscode.ExtensionContext
): { extendMarkdownIt: typeof extendMarkdownItWithMath } {
  const extensionRoot = vscode.Uri.file(context.extensionPath);
  initializeConfigStorage(context.globalStoragePath);
  const windowWithWebviewViews = (vscode.window as unknown) as {
    registerWebviewViewProvider?: (
      viewId: string,
      provider: unknown
    ) => vscode.Disposable;
  };
  let noteStorePromise: Promise<NoteStore> | undefined;
  const getNoteStore = (): Promise<NoteStore> => {
    if (!noteStorePromise) {
      noteStorePromise = NoteStore.create(context);
    }
    return noteStorePromise;
  };
  // Register our custom editor provider
  const provider = new PdfCustomProvider(extensionRoot, getNoteStore);
  const activeTranslationTasks = new Set<string>();
  if (windowWithWebviewViews.registerWebviewViewProvider) {
    context.subscriptions.push(
      windowWithWebviewViews.registerWebviewViewProvider(
        'paper-reader.configurationView',
        new ConfigurationViewProvider(extensionRoot)
      )
    );
  }
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      PdfCustomProvider.viewType,
      provider,
      {
        webviewOptions: {
          enableFindWidget: false, // default
          retainContextWhenHidden: true,
        },
      }
    )
  );
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      MarkdownWysiwygProvider.viewType,
      new MarkdownWysiwygProvider(context, getNoteStore),
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      }
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'dipe-paper-reader.openPdf',
      async (resource?: vscode.Uri) => {
        const uri = resource || vscode.window.activeTextEditor?.document.uri;
        if (!uri || !uri.path.toLowerCase().endsWith('.pdf')) {
          vscode.window.showErrorMessage('Please select a PDF file to open.');
          return;
        }

        await vscode.commands.executeCommand(
          'vscode.openWith',
          uri,
          PdfCustomProvider.viewType,
          vscode.ViewColumn.Active
        );
      }
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'dipe-paper-reader.testSendToCodex',
      async () => {
        await sendPdfSelectionToCodex('This is a Paper Reader bridge test.');
      }
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'dipe-paper-reader.sendSelectionToCodex',
      async () => {
        try {
          await sendEditorSelectionToCodex(vscode.window.activeTextEditor);
        } catch (error) {
          vscode.window.showErrorMessage(
            `Unable to send selection to Codex: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'dipe-paper-reader.openMarkdownWysiwyg',
      async (resource?: vscode.Uri) => {
        try {
          const uri = resource || vscode.window.activeTextEditor?.document.uri;
          if (!uri || !/\.(md|markdown)$/i.test(uri.fsPath || uri.path)) {
            vscode.window.showErrorMessage(
              'Please select a Markdown file to open with Paper Reader.'
            );
            return;
          }
          await openMarkdownWysiwyg(uri);
        } catch (error) {
          vscode.window.showErrorMessage(
            `Unable to open Paper Reader Markdown editor: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('dipe-paper-reader.selfCheck', async () => {
      try {
        await runSelfCheck();
      } catch (error) {
        vscode.window.showErrorMessage(
          `Unable to run Paper Reader self check: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'dipe-paper-reader.openConfiguration',
      () => {
        ConfigurationPanel.show(extensionRoot);
      }
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('dipe-paper-reader.openNotes', async () => {
      try {
        NotesPanel.show(context, await getNoteStore());
      } catch (error) {
        vscode.window.showErrorMessage(
          `Unable to open Paper Reader notes: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'dipe-paper-reader.addSelectionToNotes',
      async () => {
        try {
          const editor = vscode.window.activeTextEditor;
          if (
            !editor ||
            editor.selection.isEmpty ||
            editor.document.languageId !== 'markdown'
          ) {
            vscode.window.showErrorMessage(
              'Please select Markdown text to create a Paper Reader note.'
            );
            return;
          }

          const selectedText = editor.document.getText(editor.selection).trim();
          if (!selectedText) {
            vscode.window.showErrorMessage(
              'Please select Markdown text to create a Paper Reader note.'
            );
            return;
          }

          const context = getSelectionContext(editor.document, selectedText);
          const store = await getNoteStore();
          const annotation = store.saveMarkdownAnnotation({
            documentUri: editor.document.uri.toString(),
            documentHash: getStableDocumentHash(editor.document),
            documentTitle: path.basename(
              editor.document.uri.fsPath || editor.document.uri.path
            ),
            selectedText,
            prefixText: context.prefixText,
            suffixText: context.suffixText,
            content: '## Note\n\n',
          });
          await openAnnotationMarkdown(annotation.exportedPath);
          vscode.window.showInformationMessage('Markdown note created.');
        } catch (error) {
          vscode.window.showErrorMessage(
            `Unable to create Paper Reader Markdown note: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'dipe-paper-reader.openKnowledgeGraph',
      async () => {
        try {
          GraphPanel.show(await getNoteStore());
        } catch (error) {
          vscode.window.showErrorMessage(
            `Unable to open Paper Reader knowledge graph: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'dipe-paper-reader.translateCurrentPdf',
      (resource?: vscode.Uri) => {
        try {
          const uri = resource || provider.activePreview?.resourceUri;
          if (!uri || !uri.path.toLowerCase().endsWith('.pdf')) {
            vscode.window.showErrorMessage(
              'Please open or select a PDF file to translate.'
            );
            return;
          }
          const taskKey = uri.fsPath;
          if (activeTranslationTasks.has(taskKey)) {
            vscode.window.showInformationMessage(
              'Paper Reader is already translating this PDF.'
            );
            return;
          }
          activeTranslationTasks.add(taskKey);
          translatePdfToMarkdownWindow(uri)
            .catch((error) => {
              vscode.window.showErrorMessage(
                `Unable to translate PDF: ${
                  error instanceof Error ? error.message : String(error)
                }`
              );
            })
            .finally(() => {
              activeTranslationTasks.delete(taskKey);
            });
          vscode.window.showInformationMessage(
            'Paper Reader started PDF translation in the background.'
          );
        } catch (error) {
          vscode.window.showErrorMessage(
            `Unable to translate PDF: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    )
  );

  return {
    extendMarkdownIt: extendMarkdownItWithMath,
  };
}

export function deactivate(): void {}
