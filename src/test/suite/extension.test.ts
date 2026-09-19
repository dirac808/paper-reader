import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

type PdfWebviewStatus =
  | { state: 'loading'; stage: string }
  | { state: 'ready'; pagesCount: number }
  | { state: 'error'; details: string };

const EXTENSION_ID = 'paper-reader-lab.paper-reader';
const EXPECTED_COMMANDS = [
  'dipe-paper-reader.openPdf',
  'dipe-paper-reader.openMarkdownWysiwyg',
  'dipe-paper-reader.sendSelectionToCodex',
  'dipe-paper-reader.translateCurrentPdf',
  'dipe-paper-reader.openConfiguration',
];
const REQUIRED_RUNTIME_ASSETS = [
  'lib/build/pdf.worker.js',
  'lib/web/standard_fonts/FoxitSans.pfb',
  'media/markdown/codemirror.bundle.js',
  'media/markdown/codicons/codicon.css',
  'media/markdown/codicons/codicon.ttf',
  'media/markdown/dist/js/katex/katex.min.css',
  'node_modules/dommatrix/dist/dommatrix.js',
  'node_modules/pdfjs-dist/legacy/build/pdf.js',
  'node_modules/pdfjs-dist/legacy/build/pdf.worker.js',
  'node_modules/sql.js/dist/sql-wasm.js',
  'node_modules/sql.js/dist/sql-wasm.wasm',
  'node_modules/web-streams-polyfill/dist/ponyfill.js',
  'scripts/extractPdfText.js',
];

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForPdfWebview(
  resource: vscode.Uri,
  timeoutMilliseconds: number
): Promise<PdfWebviewStatus> {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastStatus: PdfWebviewStatus | undefined;
  while (Date.now() < deadline) {
    lastStatus = await vscode.commands.executeCommand<PdfWebviewStatus>(
      'dipe-paper-reader._getPdfWebviewStatus',
      resource
    );
    if (lastStatus?.state === 'ready' || lastStatus?.state === 'error') {
      return lastStatus;
    }
    await delay(100);
  }
  throw new Error(
    `Timed out waiting for the PDF Webview to load the document. Last status: ${JSON.stringify(
      lastStatus
    )}`
  );
}

async function closeAllEditors(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await delay(200);
}

async function removeDirectory(directory: string): Promise<void> {
  const promisesWithRm = fs.promises as typeof fs.promises & {
    rm?: (
      target: fs.PathLike,
      options: { recursive: boolean; force: boolean }
    ) => Promise<void>;
  };
  if (promisesWithRm.rm) {
    await promisesWithRm.rm(directory, { recursive: true, force: true });
  } else {
    await fs.promises.rmdir(directory, { recursive: true });
  }
}

suite('Paper Reader extension integration', () => {
  teardown(async () => {
    await closeAllEditors();
  });

  test('activates and registers its public commands', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `Extension ${EXTENSION_ID} was not discovered.`);

    await extension.activate();
    assert.strictEqual(extension.isActive, true);
    const commands = await vscode.commands.getCommands(true);
    for (const command of EXPECTED_COMMANDS) {
      assert.ok(commands.includes(command), `Missing command: ${command}`);
    }
  });

  test('contains every runtime Webview and extraction asset', () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `Extension ${EXTENSION_ID} was not discovered.`);
    for (const relativePath of REQUIRED_RUNTIME_ASSETS) {
      assert.ok(
        fs.existsSync(path.join(extension.extensionPath, relativePath)),
        `Missing packaged runtime asset: ${relativePath}`
      );
    }
  });

  test('opens the repository PDF in the Paper Reader custom editor', async function () {
    this.timeout(20_000);
    const pdfPath = process.env.PAPER_READER_TEST_PDF;
    assert.ok(
      pdfPath && fs.existsSync(pdfPath),
      `Missing test PDF: ${pdfPath}`
    );

    const pdfUri = vscode.Uri.file(pdfPath);
    await vscode.commands.executeCommand(
      'vscode.openWith',
      pdfUri,
      'dipe.paperReader',
      vscode.ViewColumn.Active
    );
    const webviewStatus = await waitForPdfWebview(pdfUri, 15_000);
    assert.notStrictEqual(
      webviewStatus.state,
      'error',
      webviewStatus.state === 'error'
        ? `PDF Webview failed to initialize:\n${webviewStatus.details}`
        : undefined
    );
    assert.ok(
      webviewStatus.state === 'ready' && webviewStatus.pagesCount > 0,
      'PDF Webview did not load any pages.'
    );

    const tabs = ((vscode.window as unknown) as {
      tabGroups?: { activeTabGroup?: { activeTab?: { label?: string } } };
    }).tabGroups;
    assert.ok(
      tabs?.activeTabGroup?.activeTab,
      'PDF custom editor did not open.'
    );
    assert.strictEqual(
      tabs?.activeTabGroup?.activeTab?.label,
      path.basename(pdfPath)
    );
  });

  test('opens and edits Markdown in the Paper Reader custom editor', async function () {
    this.timeout(20_000);
    const directory = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'paper-reader-integration-')
    );
    const markdownPath = path.join(directory, 'integration.md');
    await fs.promises.writeFile(
      markdownPath,
      '# Integration\n\nAuthor<sup>*</sup> uses $\\rho + \\sigma$ inline.\n\n$$\nx^2 + y^2 = z^2\n$$\n',
      'utf8'
    );

    try {
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(markdownPath),
        'paper-reader.markdownEditor',
        vscode.ViewColumn.Active
      );
      await delay(1500);

      const tabs = ((vscode.window as unknown) as {
        tabGroups?: { activeTabGroup?: { activeTab?: { label?: string } } };
      }).tabGroups;
      assert.ok(
        tabs?.activeTabGroup?.activeTab,
        'Markdown custom editor did not open.'
      );
      assert.strictEqual(
        tabs?.activeTabGroup?.activeTab?.label,
        path.basename(markdownPath)
      );
      const document = await vscode.workspace.openTextDocument(markdownPath);
      assert.ok(document.getText().includes('x^2 + y^2 = z^2'));
    } finally {
      await closeAllEditors();
      await removeDirectory(directory);
    }
  });
});
