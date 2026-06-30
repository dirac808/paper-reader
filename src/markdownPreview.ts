import * as vscode from 'vscode';

function isMarkdownUri(uri: vscode.Uri | undefined): uri is vscode.Uri {
  return Boolean(uri && /\.(md|markdown)$/i.test(uri.path));
}

export async function openMarkdownWithPreview(
  resource?: vscode.Uri
): Promise<void> {
  const uri = resource || vscode.window.activeTextEditor?.document.uri;
  if (!isMarkdownUri(uri)) {
    vscode.window.showErrorMessage('Please select a Markdown file to open.');
    return;
  }

  const document = await vscode.workspace.openTextDocument(uri);
  const sourceColumn =
    vscode.window.activeTextEditor?.viewColumn || vscode.ViewColumn.Active;
  await vscode.window.showTextDocument(document, {
    preview: false,
    preserveFocus: false,
    viewColumn: sourceColumn,
  });

  await vscode.commands.executeCommand('markdown.showPreviewToSide');

  await vscode.window.showTextDocument(document, {
    preview: false,
    preserveFocus: false,
    viewColumn: sourceColumn,
  });
}
