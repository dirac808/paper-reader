import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';

const CODEX_EXTENSION_ID = 'openai.chatgpt';
const CODEX_OPEN_SIDEBAR_COMMAND = 'chatgpt.openSidebar';
const CODEX_ADD_FILE_TO_THREAD_COMMAND = 'chatgpt.addFileToThread';
const PDF_SELECTION_PROMPT_PREFIX =
  '\u003e [\u6765\u81ea\u6b63\u5728\u9605\u8bfb\u7684PDF\u6587\u732e]';
const mkdtemp = promisify(fs.mkdtemp);
const writeFile = promisify(fs.writeFile);

function formatPdfSelectionPrompt(text: string): string {
  return `${PDF_SELECTION_PROMPT_PREFIX}\n\n${text}`;
}

function createCodeFence(text: string): string {
  const matches = text.match(/`{3,}/g) || [];
  const longestFence = matches.reduce(
    (length, match) => Math.max(length, match.length),
    2
  );
  return '`'.repeat(longestFence + 1);
}

function formatEditorSelectionPrompt(
  text: string,
  source: string,
  languageId: string
): string {
  const header = `> [来自 VS Code 编辑器：${source}]`;
  if (languageId === 'markdown') {
    return `${header}\n\n${text}`;
  }

  const fence = createCodeFence(text);
  const language = languageId && languageId !== 'plaintext' ? languageId : '';
  return `${header}\n\n${fence}${language}\n${text}\n${fence}`;
}

async function activateCodexExtension(): Promise<boolean> {
  const extension = vscode.extensions.getExtension(CODEX_EXTENSION_ID);
  if (!extension) {
    vscode.window.showErrorMessage(
      'Codex extension is not installed or enabled. Please install openai.chatgpt.'
    );
    return false;
  }

  if (!extension.isActive) {
    await extension.activate();
  }

  return true;
}

async function createPdfSelectionResource(text: string): Promise<vscode.Uri> {
  const directory = await mkdtemp(join(tmpdir(), 'dipe-paper-selection-'));
  const filePath = join(directory, 'pdf-selection.md');
  await writeFile(filePath, formatPdfSelectionPrompt(text), 'utf8');
  return vscode.Uri.file(filePath);
}

async function createEditorSelectionResource(
  text: string,
  source: string,
  languageId: string
): Promise<vscode.Uri> {
  const directory = await mkdtemp(join(tmpdir(), 'paper-reader-selection-'));
  const filePath = join(directory, 'editor-selection.md');
  await writeFile(
    filePath,
    formatEditorSelectionPrompt(text, source, languageId),
    'utf8'
  );
  return vscode.Uri.file(filePath);
}

export async function sendPdfSelectionToCodex(text: unknown): Promise<void> {
  if (typeof text !== 'string') {
    return;
  }

  const selectedText = text.trim();
  if (!selectedText) {
    return;
  }

  const codexReady = await activateCodexExtension();
  if (!codexReady) {
    return;
  }

  const resource = await createPdfSelectionResource(selectedText);
  await vscode.commands.executeCommand(
    CODEX_ADD_FILE_TO_THREAD_COMMAND,
    resource
  );
  await vscode.commands.executeCommand(CODEX_OPEN_SIDEBAR_COMMAND);
}

export async function sendEditorSelectionToCodex(
  editor: vscode.TextEditor | undefined
): Promise<void> {
  if (!editor) {
    vscode.window.showErrorMessage('Please select text to send to Codex.');
    return;
  }

  const selectedText = editor.selections
    .filter((selection) => !selection.isEmpty)
    .map((selection) => editor.document.getText(selection))
    .join('\n\n')
    .trim();
  if (!selectedText) {
    vscode.window.showErrorMessage('Please select text to send to Codex.');
    return;
  }

  const codexReady = await activateCodexExtension();
  if (!codexReady) {
    return;
  }

  const source = vscode.workspace.asRelativePath(editor.document.uri, false);
  const resource = await createEditorSelectionResource(
    selectedText,
    source,
    editor.document.languageId
  );
  await vscode.commands.executeCommand(
    CODEX_ADD_FILE_TO_THREAD_COMMAND,
    resource
  );
  await vscode.commands.executeCommand(CODEX_OPEN_SIDEBAR_COMMAND);
}
