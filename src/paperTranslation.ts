import { fork, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  MarkdownTranslationProgress,
  translateAcademicMarkdown,
} from './deepSeekClient';
import { getConfiguredOutputRoot, getStoredSettingValue } from './config';

type ExtractResult = {
  ok: boolean;
  markdown?: string;
  error?: string;
};

type MarkdownExtraction = {
  markdown: string;
  markdownPath?: string;
  source: 'MinerU' | 'MinerU cache' | 'PDF.js fallback';
};

export type MinerUConfig = {
  executable: string;
  backend: string;
  effort: string;
  modelSource: string;
  proxyUrl: string;
  method: string;
  apiUrl: string;
  lang: string;
  formula: boolean;
  table: boolean;
  imageAnalysis: boolean;
  device: string;
  cudaDevice: string;
  renderThreads: number;
  processingWindowSize: number;
  fallbackToPdfJs: boolean;
};

const NO_PROXY_FIELD = 'NO_PROXY';
const LOWER_NO_PROXY_FIELD = 'no_proxy';
type MinerUProgress = (message: string) => void;

export function getMinerUConfig(): MinerUConfig {
  const config = vscode.workspace.getConfiguration();
  const getValue = <T>(key: string): T | undefined => {
    const primaryKey = `paper-reader.mineru.${key}`;
    const legacyKey = `dipe-paper-reader.mineru.${key}`;
    const storedValue = getStoredSettingValue<T>(primaryKey);
    if (storedValue !== undefined) {
      return storedValue;
    }
    const primaryValue = config.get(primaryKey) as T | undefined;
    if (primaryValue !== undefined) {
      return primaryValue;
    }
    return config.get(legacyKey) as T | undefined;
  };
  return {
    executable: getValue<string>('executable') || 'mineru',
    backend: getValue<string>('backend') || 'hybrid-engine',
    effort: getValue<string>('effort') || 'high',
    modelSource: getValue<string>('modelSource') || 'auto',
    proxyUrl: getValue<string>('proxyUrl') ?? 'http://127.0.0.1:7897',
    method: getValue<string>('method') || 'auto',
    apiUrl: getValue<string>('apiUrl') ?? '',
    lang: getValue<string>('lang') ?? '',
    formula: getValue<boolean>('formula') !== false,
    table: getValue<boolean>('table') !== false,
    imageAnalysis: getValue<boolean>('imageAnalysis') !== false,
    device: getValue<string>('device') || 'auto',
    cudaDevice: getValue<string>('cudaDevice') || '0',
    renderThreads: Number(getValue<number>('renderThreads')) || 1,
    processingWindowSize: Number(getValue<number>('processingWindowSize')) || 2,
    fallbackToPdfJs: getValue<boolean>('fallbackToPdfJs') === true,
  };
}

export function getMinerUEnvironment(
  config: MinerUConfig
): { [key: string]: string | undefined } {
  const env: { [key: string]: string | undefined } = {
    ...process.env,
    [NO_PROXY_FIELD]:
      process.env.NO_PROXY || process.env.no_proxy || '127.0.0.1,localhost',
    [LOWER_NO_PROXY_FIELD]:
      process.env.no_proxy || process.env.NO_PROXY || '127.0.0.1,localhost',
    MINERU_PDF_RENDER_THREADS: String(config.renderThreads),
    MINERU_PROCESSING_WINDOW_SIZE: String(config.processingWindowSize),
  };

  if (config.device === 'cpu') {
    env.CUDA_VISIBLE_DEVICES = '-1';
  } else if (config.device === 'cuda') {
    env.CUDA_VISIBLE_DEVICES = config.cudaDevice || '0';
  }

  const modelSource = config.modelSource.trim().toLowerCase();
  if (modelSource && modelSource !== 'auto') {
    env.MINERU_MODEL_SOURCE = modelSource;
  } else {
    delete env.MINERU_MODEL_SOURCE;
  }

  const proxyUrl = config.proxyUrl.trim();
  const usesLocalModelBackend = [
    'pipeline',
    'vlm-engine',
    'hybrid-engine',
  ].includes(config.backend);
  if (proxyUrl && usesLocalModelBackend && modelSource !== 'local') {
    env.HTTP_PROXY = proxyUrl;
    env.HTTPS_PROXY = proxyUrl;
    env.ALL_PROXY = proxyUrl;
    env['http_proxy'] = proxyUrl;
    env['https_proxy'] = proxyUrl;
    env['all_proxy'] = proxyUrl;
  }

  return env;
}

function collectMarkdownFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) {
    return [];
  }

  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectMarkdownFiles(entryPath));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      files.push(entryPath);
    }
  }
  return files;
}

function pickMinerUMarkdown(markdownFiles: string[], pdfStem: string): string {
  if (!markdownFiles.length) {
    throw new Error('MinerU completed but did not produce a Markdown file.');
  }

  const exact = markdownFiles.find(
    (file) => path.basename(file, '.md').toLowerCase() === pdfStem.toLowerCase()
  );
  if (exact) {
    return exact;
  }

  return markdownFiles
    .map((file) => ({ file, size: fs.statSync(file).size }))
    .sort((a, b) => b.size - a.size)[0].file;
}

function copyDirectory(source: string, target: string): void {
  if (!fs.existsSync(source)) {
    return;
  }

  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(sourcePath, targetPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

function toMarkdownPathSegment(segment: string): string {
  return segment.replace(/\\/g, '/').replace(/ /g, '%20');
}

function sanitizePathSegment(segment: string): string {
  const sanitized = segment
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return sanitized || 'paper';
}

function getWorkspaceOutputRoot(resource: vscode.Uri): string {
  const workspaceRoot =
    vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]
      ? vscode.workspace.workspaceFolders[0].uri.fsPath
      : path.dirname(resource.fsPath);
  return getConfiguredOutputRoot(workspaceRoot);
}

function getPaperTranslationDirectory(resource: vscode.Uri): string {
  const stem = path.basename(resource.fsPath, path.extname(resource.fsPath));
  return path.join(
    getWorkspaceOutputRoot(resource),
    'translations',
    sanitizePathSegment(stem)
  );
}

function getTranslationOutputPaths(
  resource: vscode.Uri
): {
  outputDirectory: string;
  sourcePath: string;
  translatedPath: string;
} {
  const outputDirectory = getPaperTranslationDirectory(resource);
  const outputStem = sanitizePathSegment(
    path.basename(resource.fsPath, path.extname(resource.fsPath))
  );
  return {
    outputDirectory,
    sourcePath: path.join(outputDirectory, `${outputStem}.mineru-original.md`),
    translatedPath: path.join(outputDirectory, `${outputStem}.deepseek-zh.md`),
  };
}

function stripPaperReaderExtractionHeader(markdown: string): string {
  return markdown.replace(/^<!-- Extracted by [^\n]* -->\r?\n\r?\n/, '');
}

function readCachedMinerUMarkdown(
  resource: vscode.Uri
): MarkdownExtraction | undefined {
  const { sourcePath } = getTranslationOutputPaths(resource);
  if (!fs.existsSync(sourcePath) || fs.statSync(sourcePath).size === 0) {
    return undefined;
  }

  const pdfStat = fs.statSync(resource.fsPath);
  const cacheStat = fs.statSync(sourcePath);
  if (cacheStat.mtimeMs < pdfStat.mtimeMs) {
    return undefined;
  }

  return {
    markdown: stripPaperReaderExtractionHeader(
      fs.readFileSync(sourcePath, 'utf8')
    ),
    markdownPath: sourcePath,
    source: 'MinerU cache',
  };
}

function reportMinerUProgress(
  output: string,
  onProgress?: MinerUProgress
): void {
  if (!onProgress) {
    return;
  }

  if (/Layout Predict|layout/i.test(output)) {
    onProgress('MinerU 处理中：版面分析');
  } else if (/MFR Predict|formula/i.test(output)) {
    onProgress('MinerU 处理中：公式识别');
  } else if (/OCR|rec Predict|det ch/i.test(output)) {
    onProgress('MinerU 处理中：OCR 文字识别');
  } else if (/Table/i.test(output)) {
    onProgress('MinerU 处理中：表格识别');
  } else if (/Processing pages/i.test(output)) {
    onProgress('MinerU 处理中：页面结构整理');
  } else if (/Completed batch|finished/i.test(output)) {
    onProgress('MinerU 处理中：收尾整理');
  }
}

function runMinerU(
  resource: vscode.Uri,
  outputDir: string,
  config: MinerUConfig,
  onProgress?: MinerUProgress
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      resource.fsPath,
      '-o',
      outputDir,
      '-b',
      config.backend,
      '--effort',
      config.effort,
      '-m',
      config.method,
      '-f',
      config.formula ? 'true' : 'false',
      '-t',
      config.table ? 'true' : 'false',
      '--image-analysis',
      config.imageAnalysis ? 'true' : 'false',
    ];
    if (config.lang) {
      args.push('-l', config.lang);
    }
    if (config.apiUrl) {
      args.push('--api-url', config.apiUrl);
    }

    const child = spawn(config.executable, args, {
      windowsHide: true,
      env: getMinerUEnvironment(config),
    });
    let stderr = '';
    let stdout = '';

    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      reportMinerUProgress(text, onProgress);
    });
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      reportMinerUProgress(text, onProgress);
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          [`MinerU exited with code ${code}.`, stderr.trim(), stdout.trim()]
            .filter(Boolean)
            .join('\n')
        )
      );
    });
  });
}

async function extractMarkdownWithMinerU(
  resource: vscode.Uri,
  onProgress?: MinerUProgress
): Promise<MarkdownExtraction> {
  const config = getMinerUConfig();
  const outputDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'paper-reader-mineru-')
  );
  await runMinerU(resource, outputDir, config, onProgress);

  const pdfStem = path.basename(resource.fsPath, path.extname(resource.fsPath));
  const markdownPath = pickMinerUMarkdown(
    collectMarkdownFiles(outputDir),
    pdfStem
  );
  return {
    markdown: fs.readFileSync(markdownPath, 'utf8'),
    markdownPath,
    source: 'MinerU',
  };
}

async function extractMarkdownWithPdfJs(resource: vscode.Uri): Promise<string> {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(
      __dirname,
      '..',
      '..',
      'scripts',
      'extractPdfText.js'
    );
    const child = fork(scriptPath, [resource.fsPath], {
      cwd: path.dirname(scriptPath),
      execArgv: [],
      silent: true,
    });
    let stderr = '';

    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('message', (message: ExtractResult) => {
      if (message.ok && message.markdown) {
        resolve(message.markdown);
      } else {
        reject(new Error(message.error || stderr || 'Unable to extract PDF.'));
      }
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code && code !== 0) {
        reject(
          new Error(stderr || `PDF text extraction exited with code ${code}.`)
        );
      }
    });
  });
}

async function extractMarkdown(
  resource: vscode.Uri,
  onProgress?: MinerUProgress
): Promise<MarkdownExtraction> {
  const config = getMinerUConfig();
  try {
    return await extractMarkdownWithMinerU(resource, onProgress);
  } catch (error) {
    if (!config.fallbackToPdfJs) {
      throw error;
    }

    vscode.window.showWarningMessage(
      `MinerU extraction failed, using PDF.js fallback: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return {
      markdown: await extractMarkdownWithPdfJs(resource),
      source: 'PDF.js fallback',
    };
  }
}

function prepareMarkdownForOutput(
  extraction: MarkdownExtraction,
  markdown: string,
  outputDirectory: string
): string {
  if (!extraction.markdownPath) {
    return markdown;
  }

  const sourceImageDir = path.join(
    path.dirname(extraction.markdownPath),
    'images'
  );
  if (!fs.existsSync(sourceImageDir)) {
    return markdown;
  }

  const assetDirectoryName = 'assets';
  const targetImageDir = path.join(
    outputDirectory,
    assetDirectoryName,
    'images'
  );
  copyDirectory(sourceImageDir, targetImageDir);

  const imagePrefix = `${toMarkdownPathSegment(assetDirectoryName)}/images/`;
  return markdown.replace(
    /(!\[[^\]]*\]\()images\//g,
    (_match, prefix) => `${prefix}${imagePrefix}`
  );
}

function writeSourceOutput(
  resource: vscode.Uri,
  extraction: MarkdownExtraction
): {
  sourcePath: string;
  preparedMarkdown: string;
} {
  const { outputDirectory, sourcePath } = getTranslationOutputPaths(resource);
  fs.mkdirSync(outputDirectory, { recursive: true });

  const preparedMarkdown = prepareMarkdownForOutput(
    extraction,
    extraction.markdown,
    outputDirectory
  );
  fs.writeFileSync(
    sourcePath,
    `<!-- Extracted by ${extraction.source} -->\n\n${preparedMarkdown}`,
    'utf8'
  );

  return { sourcePath, preparedMarkdown };
}

function writeTranslatedOutput(
  resource: vscode.Uri,
  extraction: MarkdownExtraction,
  translated: string
): {
  translatedPath: string;
} {
  const { outputDirectory, translatedPath } = getTranslationOutputPaths(
    resource
  );
  fs.mkdirSync(outputDirectory, { recursive: true });

  const translatedMarkdown = prepareMarkdownForOutput(
    extraction,
    translated,
    outputDirectory
  );

  fs.writeFileSync(
    translatedPath,
    `<!-- Extracted by ${extraction.source}; translated by DeepSeek -->\n\n${translatedMarkdown}`,
    'utf8'
  );

  return { translatedPath };
}

async function showMarkdownInNewWindow(
  markdownPath: string,
  title: string
): Promise<void> {
  const uri = vscode.Uri.file(markdownPath);
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, {
    preserveFocus: false,
    preview: false,
    viewColumn: vscode.ViewColumn.Beside,
  });

  try {
    await vscode.commands.executeCommand(
      'workbench.action.moveEditorToNewWindow'
    );
  } catch {
    vscode.window.showInformationMessage(
      `${title} opened in a Markdown editor.`
    );
  }
}

export async function translatePdfToMarkdownWindow(
  resource: vscode.Uri
): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Paper Reader translating PDF',
      cancellable: false,
    },
    async (progress) => {
      progress.report({ message: '准备全文翻译...', increment: 3 });
      const cachedExtraction = readCachedMinerUMarkdown(resource);
      let extraction: MarkdownExtraction;
      if (cachedExtraction) {
        extraction = cachedExtraction;
        progress.report({
          message: '已复用之前的 MinerU Markdown，中间解析步骤已跳过...',
          increment: 35,
        });
      } else {
        let lastMinerUMessage = '';
        extraction = await extractMarkdown(resource, (message) => {
          if (message !== lastMinerUMessage) {
            lastMinerUMessage = message;
            progress.report({ message });
          }
        });
        const sourceOutput = writeSourceOutput(resource, extraction);
        extraction = {
          ...extraction,
          markdown: sourceOutput.preparedMarkdown,
          markdownPath: sourceOutput.sourcePath,
        };
      }
      progress.report({
        message: 'MinerU 处理完成，准备文档翻译...',
        increment: 32,
      });

      let reportedBatches = 0;
      const translated = await translateAcademicMarkdown(
        extraction.markdown,
        (translationProgress: MarkdownTranslationProgress) => {
          const completedDelta =
            translationProgress.completedBatches - reportedBatches;
          reportedBatches = translationProgress.completedBatches;
          const increment =
            translationProgress.totalBatches > 0
              ? (completedDelta * 50) / translationProgress.totalBatches
              : 0;
          progress.report({
            message: `文档翻译中：${translationProgress.completedBatches}/${translationProgress.totalBatches}`,
            increment,
          });
        }
      );
      progress.report({ message: '写入 Markdown 文件...', increment: 10 });
      const outputs = writeTranslatedOutput(resource, extraction, translated);
      progress.report({ message: '打开翻译结果...', increment: 5 });
      await showMarkdownInNewWindow(outputs.translatedPath, 'PDF translation');
    }
  );
}

export const testingHooks = {
  getTranslationOutputPaths,
  readCachedMinerUMarkdown,
  writeSourceOutput,
};
