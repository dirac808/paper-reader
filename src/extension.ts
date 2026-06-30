import * as vscode from 'vscode';
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
import { openMarkdownWithPreview } from './markdownPreview';

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
      'dipe-paper-reader.openMarkdownWithPreview',
      async (resource?: vscode.Uri) => {
        try {
          await openMarkdownWithPreview(resource);
        } catch (error) {
          vscode.window.showErrorMessage(
            `Unable to open Markdown preview: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
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
          if (!editor || editor.selection.isEmpty) {
            vscode.window.showErrorMessage(
              'Please select Markdown text to add to Paper Reader notes.'
            );
            return;
          }

          const selectedText = editor.document.getText(editor.selection).trim();
          if (!selectedText) {
            vscode.window.showErrorMessage(
              'Please select Markdown text to add to Paper Reader notes.'
            );
            return;
          }

          const source = vscode.workspace.asRelativePath(
            editor.document.uri,
            false
          );
          const note = await getNoteStore();
          note.appendToDefaultNote(
            [
              `## From ${source}`,
              '',
              selectedText
                .split(/\r?\n/)
                .map((line) => `> ${line}`)
                .join('\n'),
            ].join('\n')
          );
          vscode.window.showInformationMessage(
            'Selection added to Paper Reader notes.'
          );
        } catch (error) {
          vscode.window.showErrorMessage(
            `Unable to add selection to Paper Reader notes: ${
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
