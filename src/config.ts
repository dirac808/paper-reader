import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export const DEFAULT_OUTPUT_DIRECTORY = 'paper-reader-output';
export const DEFAULT_AI_BASE_URL = 'https://api.deepseek.com';
export const DEFAULT_AI_MODEL = 'deepseek-v4-flash';
export const DEFAULT_AI_TRANSLATION_CONCURRENCY = 6;
export const DEFAULT_TRANSLATION_PROMPT = [
  '你是科研论文 Markdown 正文翻译引擎。',
  '你会收到 JSON 数组，每个对象格式为 {"id":"S0","text":"英文正文"}。',
  '请把每个 text 的英文学术正文准确翻译成中文。',
  '必须返回合法 JSON 数组，格式为 [{"id":"S0","translation":"译文"}]。',
  '每个输入 id 必须且只能在输出中出现一次，不要遗漏、合并或新增 id。',
  '必须原样保留所有 {{PAPER_READER_INLINE_KEEP_0}} 和 {{PAPER_READER_KEEP_BLOCK_0}} 形式的占位符。',
  '必须保留公式、变量名、引用编号、人名、机构名、专有名词、缩写和数字。',
  '不要翻译占位符，不要添加解释，不要输出 Markdown 代码块，只输出 JSON 数组。',
].join('\n');
export const DEFAULT_SELECTION_TRANSLATION_PROMPT =
  '你是科研论文阅读助手。请把用户选中的英文学术论文片段准确翻译成中文。保留公式、变量、引用编号、人名、机构名、专有名词和缩写；不要添加解释；只输出译文。';
const LEGACY_DEFAULT_TRANSLATION_PROMPTS = [
  '你是科研论文阅读助手。请把用户提供的英文学术论文内容准确翻译成中文。保留公式、变量、引用编号、人名、机构名、专有名词和缩写；不要添加解释；只输出译文。',
];

export type AiConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  translationPrompt: string;
  translationConcurrency: number;
};

export type StoredSettingValue = string | boolean | number;

let storageFilePath: string | undefined;
let storedSettingsCache: { [key: string]: StoredSettingValue } | undefined;

export function initializeConfigStorage(storageRoot: string): void {
  fs.mkdirSync(storageRoot, { recursive: true });
  storageFilePath = path.join(storageRoot, 'paper-reader-settings.json');
  storedSettingsCache = undefined;
}

function readStoredSettings(): { [key: string]: StoredSettingValue } {
  if (storedSettingsCache) {
    return storedSettingsCache;
  }
  if (!storageFilePath || !fs.existsSync(storageFilePath)) {
    storedSettingsCache = {};
    return storedSettingsCache;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(storageFilePath, 'utf8'));
    storedSettingsCache =
      parsed && typeof parsed === 'object'
        ? (parsed as { [key: string]: StoredSettingValue })
        : {};
  } catch {
    storedSettingsCache = {};
  }
  return storedSettingsCache;
}

export function getStoredSettingValue<T>(key: string): T | undefined {
  return (readStoredSettings()[key] as unknown) as T | undefined;
}

export function saveStoredSettings(values: {
  [key: string]: StoredSettingValue;
}): void {
  if (!storageFilePath) {
    throw new Error('Paper Reader configuration storage is not initialized.');
  }

  const nextSettings = {
    ...readStoredSettings(),
    ...values,
  };
  const tempPath = `${storageFilePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(nextSettings, null, 2), 'utf8');
  fs.renameSync(tempPath, storageFilePath);
  storedSettingsCache = nextSettings;
}

function getConfigValue<T>(
  primaryKey: string,
  legacyKey: string
): T | undefined {
  const config = vscode.workspace.getConfiguration();
  return (
    getStoredSettingValue<T>(primaryKey) ||
    (config.get(primaryKey) as T | undefined) ||
    (config.get(legacyKey) as T | undefined)
  );
}

export function normalizeFullTranslationPrompt(prompt: string): string {
  const trimmed = prompt.trim();
  if (
    LEGACY_DEFAULT_TRANSLATION_PROMPTS.some(
      (legacyPrompt) => legacyPrompt.trim() === trimmed
    )
  ) {
    return DEFAULT_TRANSLATION_PROMPT;
  }
  return prompt;
}

export function getAiConfig(): AiConfig {
  const config = vscode.workspace.getConfiguration();
  const configuredConcurrency = Number(
    getConfigValue<number>(
      'paper-reader.ai.translationConcurrency',
      'dipe-paper-reader.ai.translationConcurrency'
    ) || DEFAULT_AI_TRANSLATION_CONCURRENCY
  );
  return {
    apiKey:
      process.env.PAPER_READER_AI_API_KEY ||
      process.env.DEEPSEEK_API_KEY ||
      getConfigValue<string>(
        'paper-reader.ai.apiKey',
        'dipe-paper-reader.ai.apiKey'
      ) ||
      (config.get('dipe-paper-reader.deepseek.apiKey') as string | undefined) ||
      '',
    baseUrl:
      getConfigValue<string>(
        'paper-reader.ai.baseUrl',
        'dipe-paper-reader.ai.baseUrl'
      ) ||
      (config.get('dipe-paper-reader.deepseek.baseUrl') as
        | string
        | undefined) ||
      DEFAULT_AI_BASE_URL,
    model:
      getConfigValue<string>(
        'paper-reader.ai.model',
        'dipe-paper-reader.ai.model'
      ) ||
      (config.get('dipe-paper-reader.deepseek.model') as string | undefined) ||
      DEFAULT_AI_MODEL,
    translationPrompt: normalizeFullTranslationPrompt(
      getConfigValue<string>(
        'paper-reader.ai.translationPrompt',
        'dipe-paper-reader.ai.translationPrompt'
      ) || DEFAULT_TRANSLATION_PROMPT
    ),
    translationConcurrency: Math.max(
      1,
      Math.min(20, configuredConcurrency || DEFAULT_AI_TRANSLATION_CONCURRENCY)
    ),
  };
}

export function getSelectionAiConfig(): AiConfig {
  const baseConfig = getAiConfig();
  return {
    apiKey:
      process.env.PAPER_READER_SELECTION_AI_API_KEY ||
      getConfigValue<string>(
        'paper-reader.selectionTranslation.apiKey',
        'dipe-paper-reader.selectionTranslation.apiKey'
      ) ||
      baseConfig.apiKey,
    baseUrl:
      getConfigValue<string>(
        'paper-reader.selectionTranslation.baseUrl',
        'dipe-paper-reader.selectionTranslation.baseUrl'
      ) || baseConfig.baseUrl,
    model:
      getConfigValue<string>(
        'paper-reader.selectionTranslation.model',
        'dipe-paper-reader.selectionTranslation.model'
      ) || baseConfig.model,
    translationPrompt:
      getConfigValue<string>(
        'paper-reader.selectionTranslation.prompt',
        'dipe-paper-reader.selectionTranslation.prompt'
      ) || DEFAULT_SELECTION_TRANSLATION_PROMPT,
    translationConcurrency: 1,
  };
}

export function getConfiguredOutputRoot(basePath: string): string {
  const outputDirectory =
    (
      getConfigValue<string>(
        'paper-reader.output.directory',
        'dipe-paper-reader.output.directory'
      ) || DEFAULT_OUTPUT_DIRECTORY
    )
      .trim()
      .replace(/[\\/]+$/g, '') || DEFAULT_OUTPUT_DIRECTORY;

  if (path.isAbsolute(outputDirectory)) {
    return outputDirectory;
  }
  return path.join(basePath, outputDirectory);
}
