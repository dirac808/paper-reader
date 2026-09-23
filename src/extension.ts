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
import { PdfPreview } from './pdfPreview';
import { extendMarkdownItWithMath } from './markdownMath';
import {
  MarkdownWysiwygProvider,
  openMarkdownNote,
  openMarkdownWysiwyg,
} from './markdownWysiwygProvider';
import { normalizeMarkdownMathDelimiters } from './markdownCleanup';

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

function isMarkdownUri(uri: vscode.Uri | undefined): uri is vscode.Uri {
  return !!uri && /\.(md|markdown)$/i.test(uri.fsPath || uri.path);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCancellationError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /operation was cancelled|canceled/i.test(error.message)
  );
}

async function normalizeMarkdownMathFile(resource?: vscode.Uri): Promise<void> {
  const uri = resource || vscode.window.activeTextEditor?.document.uri;
  if (!isMarkdownUri(uri)) {
    vscode.window.showErrorMessage(
      'Please select a Markdown file to normalize math delimiters.'
    );
    return;
  }

  const visibleEditor = vscode.window.visibleTextEditors.find(
    (editor) => editor.document.uri.toString() === uri.toString()
  );
  const document =
    visibleEditor?.document || (await vscode.workspace.openTextDocument(uri));
  const result = normalizeMarkdownMathDelimiters(document.getText());
  if (result.changedBlocks === 0) {
    vscode.window.showInformationMessage(
      'Paper Reader found no \\[...\\] display math blocks to normalize.'
    );
    return;
  }

  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    document.uri,
    new vscode.Range(0, 0, document.lineCount, 0),
    result.markdown
  );
  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    throw new Error('VS Code rejected the Markdown math normalization edit.');
  }
  await document.save();
  vscode.window.showInformationMessage(
    `Paper Reader normalized ${result.changedBlocks} Markdown math block${
      result.changedBlocks === 1 ? '' : 's'
    } to $$.`
  );
}

async function openMarkdownTextPreview(resource?: vscode.Uri): Promise<void> {
  const uri = resource || vscode.window.activeTextEditor?.document.uri;
  if (!isMarkdownUri(uri)) {
    vscode.window.showErrorMessage(
      'Please select a Markdown file to open with text preview.'
    );
    return;
  }

  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, {
    preview: false,
    preserveFocus: false,
    viewColumn: vscode.ViewColumn.Active,
  });

  let openedFloatingWindow = false;
  try {
    await vscode.commands.executeCommand(
      'workbench.action.copyEditorGroupToNewWindow'
    );
    openedFloatingWindow = true;
    await delay(500);
  } catch {
    // Older VS Code builds may not expose floating editor commands.
  }

  if (
    vscode.window.activeTextEditor?.document.uri.toString() !== uri.toString()
  ) {
    await vscode.window.showTextDocument(document, {
      preview: false,
      preserveFocus: false,
      viewColumn: vscode.ViewColumn.Active,
    });
  }

  await vscode.commands.executeCommand('markdown.showPreviewToSide');
  await delay(100);
  await vscode.commands.executeCommand('workbench.action.focusLeftGroup');

  const previewConfig = vscode.workspace.getConfiguration('markdown.preview');
  const scrollPreviewWithEditor = previewConfig.get<boolean>(
    'scrollPreviewWithEditor',
    true
  );
  const scrollEditorWithPreview = previewConfig.get<boolean>(
    'scrollEditorWithPreview',
    true
  );
  if (!scrollPreviewWithEditor || !scrollEditorWithPreview) {
    vscode.window.showWarningMessage(
      'Paper Reader opened native Markdown text preview, but VS Code Markdown preview scroll sync is disabled in settings.'
    );
  } else if (!openedFloatingWindow) {
    vscode.window.showInformationMessage(
      'Paper Reader opened Markdown text preview in the current window. Your VS Code version did not move the editor group into a floating window automatically.'
    );
  }
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
      void noteStorePromise.then((store) => context.subscriptions.push(store));
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
          retainContextWhenHidden: false,
        },
      }
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'dipe-paper-reader._getPdfWebviewStatus',
      (resource: vscode.Uri) => PdfPreview.getWebviewStatus(resource)
    )
  );
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      MarkdownWysiwygProvider.viewType,
      new MarkdownWysiwygProvider(context, getNoteStore),
      {
        webviewOptions: {
          retainContextWhenHidden: false,
        },
      }
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'dipe-paper-reader.startCursorDiagnostic',
      () => MarkdownWysiwygProvider.startCursorDiagnostic()
    ),
    vscode.commands.registerCommand(
      'dipe-paper-reader.stopCursorDiagnostic',
      () => MarkdownWysiwygProvider.stopCursorDiagnostic()
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
    vscode.commands.registerCommand(
      'dipe-paper-reader.openMarkdownTextPreview',
      async (resource?: vscode.Uri) => {
        try {
          await openMarkdownTextPreview(resource);
        } catch (error) {
          vscode.window.showErrorMessage(
            `Unable to open Paper Reader Markdown text preview: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'dipe-paper-reader.normalizeMarkdownMath',
      async (resource?: vscode.Uri) => {
        try {
          await normalizeMarkdownMathFile(resource);
        } catch (error) {
          vscode.window.showErrorMessage(
            `Unable to normalize Markdown math: ${
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
          await openMarkdownNote(annotation.exportedPath);
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
              if (isCancellationError(error)) {
                vscode.window.showInformationMessage(
                  'Paper Reader PDF translation cancelled.'
                );
                return;
              }
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
