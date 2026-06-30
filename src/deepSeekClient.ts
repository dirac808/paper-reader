import * as https from 'https';
import { URL } from 'url';
import { AiConfig, getAiConfig, getSelectionAiConfig } from './config';

type DeepSeekMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

type DeepSeekChoice = {
  message?: {
    content?: string;
  };
};

type DeepSeekResponse = {
  choices?: DeepSeekChoice[];
  error?: {
    message?: string;
  };
};

type MarkdownProtection = {
  protectedMarkdown: string;
  restore(translated: string): string;
};

type InlineProtection = {
  text: string;
  restore(translated: string): string;
};

export type TranslationUnit = {
  id: string;
  text: string;
  restoreInline(translated: string): string;
};

export type MarkdownTranslationProgress = {
  completedBatches: number;
  totalBatches: number;
};

const MAX_TOKENS_FIELD = 'max_tokens';
const PLACEHOLDER_PREFIX = 'PAPER_READER_KEEP_BLOCK_';
const TRANSLATION_PREFIX = 'PAPER_READER_TRANSLATE_';
const INLINE_PLACEHOLDER_PREFIX = 'PAPER_READER_INLINE_KEEP_';
const MAX_TRANSLATION_BATCH_CHARS = 4000;
const MAX_TRANSLATION_RESPONSE_TOKENS = 8192;
const MAX_TRANSLATION_CONCURRENCY = 20;
const KATEX_STYLE_COMMANDS = [
  'normalfont',
  'displaystyle',
  'textstyle',
  'scriptstyle',
  'scriptscriptstyle',
];

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function getMissingApiKeyMessage(): string {
  return 'AI API key is missing. Set PAPER_READER_AI_API_KEY, DEEPSEEK_API_KEY, or paper-reader.ai.apiKey.';
}

type PostJsonImplementation = <T>(
  baseUrl: string,
  path: string,
  apiKey: string,
  body: unknown
) => Promise<T>;

function postJson<T>(
  baseUrl: string,
  path: string,
  apiKey: string,
  body: unknown
): Promise<T> {
  return new Promise((resolve, reject) => {
    const endpoint = new URL(path, baseUrl);
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const request = https.request(
      {
        method: 'POST',
        hostname: endpoint.hostname,
        port: endpoint.port || 443,
        path: `${endpoint.pathname}${endpoint.search}`,
        protocol: endpoint.protocol,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown;
          try {
            parsed = raw ? JSON.parse(raw) : {};
          } catch (error) {
            reject(
              new Error(`AI API returned invalid JSON: ${raw.slice(0, 200)}`)
            );
            return;
          }

          if (
            !response.statusCode ||
            response.statusCode < 200 ||
            response.statusCode >= 300
          ) {
            const message =
              typeof parsed === 'object' &&
              parsed !== null &&
              'error' in parsed &&
              (parsed as DeepSeekResponse).error &&
              (parsed as DeepSeekResponse).error?.message
                ? (parsed as DeepSeekResponse).error?.message
                : raw;
            reject(
              new Error(
                `AI API request failed (${response.statusCode}): ${message}`
              )
            );
            return;
          }

          resolve(parsed as T);
        });
      }
    );

    request.on('error', reject);
    request.write(payload);
    request.end();
  });
}

let postJsonImplementation: PostJsonImplementation = postJson;

function skipLatexWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && /\s/.test(text[index])) {
    index += 1;
  }
  return index;
}

function findBalancedGroupEnd(text: string, start: number): number {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    const previous = index > 0 ? text[index - 1] : '';
    if (char === '{' && previous !== '\\') {
      depth += 1;
    } else if (char === '}' && previous !== '\\') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function repairFractionAt(
  block: string,
  start: number
): {
  text: string;
  end: number;
} {
  const firstGroupStart = skipLatexWhitespace(block, start + '\\frac'.length);
  if (block[firstGroupStart] !== '{') {
    return { text: '\\frac', end: start + '\\frac'.length };
  }

  const firstGroupEnd = findBalancedGroupEnd(block, firstGroupStart);
  if (firstGroupEnd === -1) {
    return { text: block.slice(start), end: block.length };
  }

  const secondGroupStart = skipLatexWhitespace(block, firstGroupEnd + 1);
  if (block[secondGroupStart] === '{') {
    const secondGroupEnd = findBalancedGroupEnd(block, secondGroupStart);
    if (secondGroupEnd !== -1) {
      return {
        text: block.slice(start, secondGroupEnd + 1),
        end: secondGroupEnd + 1,
      };
    }
  }

  const tail = block.slice(secondGroupStart);
  if (/^(?:\\end\{array\}|\$\$)/.test(tail)) {
    return {
      text: `${block.slice(start, firstGroupEnd + 1)}{}`,
      end: firstGroupEnd + 1,
    };
  }

  return {
    text: block.slice(start, firstGroupEnd + 1),
    end: firstGroupEnd + 1,
  };
}

function repairMissingFractionDenominators(block: string): string {
  const marker = '\\frac';
  let result = '';
  let cursor = 0;

  while (cursor < block.length) {
    const start = block.indexOf(marker, cursor);
    if (start === -1) {
      result += block.slice(cursor);
      break;
    }

    result += block.slice(cursor, start);
    const repaired = repairFractionAt(block, start);
    result += repaired.text;
    cursor = repaired.end;
  }

  return result;
}

function normalizeDisplayMathBlock(block: string): string {
  return repairMissingFractionDenominators(block)
    .replace(/\\end\s+\\end\{array\}/g, '\\end{array}')
    .replace(/\\\s+_/g, '_')
    .replace(/\\\s+\^/g, '^')
    .replace(/\\\s+}/g, '}')
    .replace(/\\operatorname\*\s*\{\s*([^{}]+?)\s*\}/g, (_match, name) => {
      const compactName = String(name).replace(/\s+/g, '');
      return `\\operatorname*{${compactName}}`;
    })
    .replace(/\\operatorname\s*\{\s*([^{}]+?)\s*\}/g, (_match, name) => {
      const compactName = String(name).replace(/\s+/g, '');
      return `\\operatorname{${compactName}}`;
    })
    .replace(
      /\\mathrm\s*\{\s*([A-Za-z](?:\s+[A-Za-z]){1,8})\s*\}/g,
      (_match, name) => {
        const compactName = String(name).replace(/\s+/g, '');
        return `\\mathrm{${compactName}}`;
      }
    );
}

function normalizeLatexForMarkdown(markdown: string): string {
  let normalized = markdown
    .replace(/\u00a0/g, ' ')
    .replace(/\u200b/g, '')
    .replace(/\bxxxxxxxxxx\b/g, '');
  for (const command of KATEX_STYLE_COMMANDS) {
    normalized = normalized.replace(
      new RegExp(`\\\\${command}\\b\\s*`, 'g'),
      ''
    );
  }

  return normalized.replace(/\$\$[\s\S]*?\$\$/g, (block) =>
    normalizeDisplayMathBlock(block)
  );
}

function protectMarkdownBlocks(markdown: string): MarkdownProtection {
  const blocks: string[] = [];
  const patterns = [
    /```[\s\S]*?```/g,
    /\$\$[\s\S]*?\$\$/g,
    /\\\[[\s\S]*?\\\]/g,
    /!\[[^\]]*\]\([^)]+\)/g,
  ];
  let protectedMarkdown = markdown;

  for (const pattern of patterns) {
    protectedMarkdown = protectedMarkdown.replace(pattern, (match) => {
      const placeholder = `{{${PLACEHOLDER_PREFIX}${blocks.length}}}`;
      blocks.push(match);
      return placeholder;
    });
  }

  return {
    protectedMarkdown,
    restore(translated: string): string {
      return translated.replace(
        new RegExp(`\\{\\{${PLACEHOLDER_PREFIX}(\\d+)\\}\\}`, 'g'),
        (_match, index) => blocks[Number(index)] || _match
      );
    },
  };
}

function protectInlineContent(text: string): InlineProtection {
  const fragments: string[] = [];
  const patterns = [
    /\{\{PAPER_READER_KEEP_BLOCK_\d+\}\}/g,
    /\[[^\]\n]+\]\([^)]+\)/g,
    /`[^`\n]+`/g,
    /\$[^$\n]+\$/g,
    /https?:\/\/[^\s)]+/g,
    /\[[^\]\n]{1,80}\]/g,
  ];
  let protectedText = text;

  for (const pattern of patterns) {
    protectedText = protectedText.replace(pattern, (match) => {
      const placeholder = `{{${INLINE_PLACEHOLDER_PREFIX}${fragments.length}}}`;
      fragments.push(match);
      return placeholder;
    });
  }

  return {
    text: protectedText,
    restore(translated: string): string {
      return translated.replace(
        new RegExp(`\\{\\{${INLINE_PLACEHOLDER_PREFIX}(\\d+)\\}\\}`, 'g'),
        (_match, index) => fragments[Number(index)] || _match
      );
    },
  };
}

function isMostlyNonProse(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return true;
  }
  if (/^\{\{PAPER_READER_KEEP_BLOCK_\d+\}\}$/.test(trimmed)) {
    return true;
  }
  if (/^[-=*_~|:\s]+$/.test(trimmed)) {
    return true;
  }
  if (/^[\d\s.,;:()[\]{}+\-*/^_=<>%'"`]+$/.test(trimmed)) {
    return true;
  }

  return !/[A-Za-z]{2,}/.test(trimmed);
}

function isProtectedOrStructuralBlock(block: string): boolean {
  const trimmed = block.trim();
  if (!trimmed) {
    return true;
  }
  if (/^\{\{PAPER_READER_KEEP_BLOCK_\d+\}\}$/.test(trimmed)) {
    return true;
  }
  if (/^!\[[^\]]*\]\([^)]+\)$/.test(trimmed)) {
    return true;
  }
  if (/^\[[^\]]+\]:\s+/.test(trimmed)) {
    return true;
  }
  if (/^<!--[\s\S]*-->$/.test(trimmed)) {
    return true;
  }
  if (/^\|[\s\S]*\|$/.test(trimmed)) {
    return true;
  }
  if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(trimmed)) {
    return true;
  }

  return false;
}

function isSkippedPaperSectionHeading(text: string): boolean {
  const heading = text.replace(/^#{1,6}\s+/, '').trim();
  return /^(references|bibliography|acknowledg(e)?ments?|appendix|supplementary materials?|funding|conflicts? of interest)\b/i.test(
    heading
  );
}

function createTranslationPlaceholder(index: number): string {
  return `{{${TRANSLATION_PREFIX}${index}}}`;
}

function addTranslationUnit(text: string, units: TranslationUnit[]): string {
  if (isMostlyNonProse(text)) {
    return text;
  }

  const inline = protectInlineContent(text);
  if (isMostlyNonProse(inline.text)) {
    return text;
  }

  const id = `S${units.length}`;
  const placeholder = createTranslationPlaceholder(units.length);
  units.push({
    id,
    text: inline.text,
    restoreInline: inline.restore,
  });
  return placeholder;
}

function buildTranslationTemplate(
  markdown: string
): {
  template: string;
  units: TranslationUnit[];
} {
  const units: TranslationUnit[] = [];
  const parts = markdown.replace(/\r\n/g, '\n').split(/(\n{2,})/);
  let inSkippedSection = false;

  const template = parts
    .map((part) => {
      if (/^\n{2,}$/.test(part) || isProtectedOrStructuralBlock(part)) {
        return part;
      }

      const headingMatch = part.match(/^(\s*#{1,6}\s+)(.+?)(\s*)$/);
      if (headingMatch) {
        inSkippedSection = isSkippedPaperSectionHeading(part);
        if (inSkippedSection) {
          return part;
        }

        return `${headingMatch[1]}${addTranslationUnit(
          headingMatch[2],
          units
        )}${headingMatch[3]}`;
      }

      if (inSkippedSection) {
        return part;
      }

      const lines = part.split('\n');
      const canTranslateLineByLine = lines.some((line) =>
        /^\s*(?:[-*+]\s+|\d+\.\s+|>\s*)\S/.test(line)
      );
      if (canTranslateLineByLine) {
        return lines
          .map((line) => {
            const listMatch = line.match(
              /^(\s*(?:[-*+]\s+|\d+\.\s+|>\s*))(.*)$/
            );
            if (!listMatch) {
              return line;
            }
            return `${listMatch[1]}${addTranslationUnit(listMatch[2], units)}`;
          })
          .join('\n');
      }

      const bodyMatch = part.match(/^(\s*)([\s\S]*?)(\s*)$/);
      if (!bodyMatch) {
        return part;
      }

      return `${bodyMatch[1]}${addTranslationUnit(bodyMatch[2], units)}${
        bodyMatch[3]
      }`;
    })
    .join('');

  return { template, units };
}

function splitIntoBatches(units: TranslationUnit[]): TranslationUnit[][] {
  const batches: TranslationUnit[][] = [];
  let current: TranslationUnit[] = [];
  let currentSize = 0;

  for (const unit of units) {
    const itemSize = unit.text.length + unit.id.length + 32;
    if (
      current.length &&
      currentSize + itemSize > MAX_TRANSLATION_BATCH_CHARS
    ) {
      batches.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(unit);
    currentSize += itemSize;
  }

  if (current.length) {
    batches.push(current);
  }

  return batches;
}

function extractJsonArray(raw: string): unknown {
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/i, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('[');
    const end = trimmed.lastIndexOf(']');
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error(
      `AI returned non-JSON translation data: ${raw.slice(0, 200)}`
    );
  }
}

function parseTranslationMap(raw: string): Map<string, string> {
  const parsed = extractJsonArray(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('AI translation data is not an array.');
  }

  const translations = new Map<string, string>();
  for (const item of parsed) {
    if (
      typeof item === 'object' &&
      item !== null &&
      'id' in item &&
      'translation' in item
    ) {
      const id = (item as { id?: unknown }).id;
      const translation = (item as { translation?: unknown }).translation;
      if (typeof id === 'string' && typeof translation === 'string') {
        translations.set(id, translation);
      }
    }
  }

  return translations;
}

function buildMarkdownTranslationMessages(
  batch: TranslationUnit[],
  translationPrompt: string,
  retryReason?: string
): DeepSeekMessage[] {
  const systemPrompt = [
    translationPrompt,
    '',
    'You are translating protected academic-paper Markdown segments.',
    'The user will send a JSON array of objects shaped like {"id":"S0","text":"..."}.',
    'Return only a valid JSON array. Do not wrap it in Markdown fences.',
    'Every input id must appear exactly once in the output.',
    'Each output item must be shaped like {"id":"S0","translation":"..."}.',
    'Preserve placeholders such as {{PAPER_READER_INLINE_KEEP_0}} and {{PAPER_READER_KEEP_BLOCK_0}} exactly.',
    'Do not translate placeholders, variable names, abbreviations, citations, or numbers.',
    retryReason ? `Previous response was invalid: ${retryReason}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return [
    {
      role: 'system',
      content: systemPrompt,
    },
    {
      role: 'user',
      content: JSON.stringify(
        batch.map((unit) => ({ id: unit.id, text: unit.text }))
      ),
    },
  ];
}

async function requestTranslationBatch(
  batch: TranslationUnit[],
  apiKey: string,
  baseUrl: string,
  model: string,
  translationPrompt: string,
  retryReason?: string
): Promise<Map<string, string>> {
  const response = await postJsonImplementation<DeepSeekResponse>(
    baseUrl,
    '/chat/completions',
    apiKey,
    {
      model,
      messages: buildMarkdownTranslationMessages(
        batch,
        translationPrompt,
        retryReason
      ),
      thinking: { type: 'disabled' },
      temperature: retryReason ? 0 : 0.2,
      [MAX_TOKENS_FIELD]: MAX_TRANSLATION_RESPONSE_TOKENS,
      stream: false,
    }
  );

  const translated = response.choices && response.choices[0]?.message?.content;
  if (!translated) {
    throw new Error('AI returned an empty paper translation batch.');
  }

  return parseTranslationMap(translated);
}

async function translateBatchWithRecovery(
  batch: TranslationUnit[],
  apiKey: string,
  baseUrl: string,
  model: string,
  translationPrompt: string
): Promise<Map<string, string>> {
  let batchTranslations: Map<string, string>;
  try {
    batchTranslations = await requestTranslationBatch(
      batch,
      apiKey,
      baseUrl,
      model,
      translationPrompt
    );
  } catch (error) {
    batchTranslations = await requestTranslationBatch(
      batch,
      apiKey,
      baseUrl,
      model,
      translationPrompt,
      error instanceof Error ? error.message : String(error)
    );
  }

  let missingUnits = batch.filter((unit) => !batchTranslations.get(unit.id));
  if (!missingUnits.length) {
    return batchTranslations;
  }

  for (let attempt = 0; attempt < 2 && missingUnits.length; attempt += 1) {
    const recovered = await requestTranslationBatch(
      missingUnits,
      apiKey,
      baseUrl,
      model,
      translationPrompt,
      `Missing id(s): ${missingUnits.map((unit) => unit.id).join(', ')}`
    );
    for (const unit of missingUnits) {
      const translatedText = recovered.get(unit.id);
      if (translatedText) {
        batchTranslations.set(unit.id, translatedText);
      }
    }
    missingUnits = batch.filter((unit) => !batchTranslations.get(unit.id));
  }

  if (missingUnits.length) {
    throw new Error(
      `AI missed translation segment(s): ${missingUnits
        .map((unit) => unit.id)
        .join(', ')}.`
    );
  }

  return batchTranslations;
}

async function translateMarkdownUnits(
  units: TranslationUnit[],
  apiKey: string,
  baseUrl: string,
  model: string,
  translationPrompt: string,
  concurrency: number,
  onProgress?: (progress: MarkdownTranslationProgress) => void
): Promise<Map<string, string>> {
  const translations = new Map<string, string>();
  const batches = splitIntoBatches(units);
  let nextBatchIndex = 0;
  let completedBatches = 0;
  const workerCount = Math.min(
    Math.max(1, Math.min(MAX_TRANSLATION_CONCURRENCY, concurrency)),
    batches.length
  );

  const translateNextBatch = async (): Promise<void> => {
    const index = nextBatchIndex;
    nextBatchIndex += 1;
    if (index >= batches.length) {
      return;
    }

    const batch = batches[index];
    const batchTranslations = await translateBatchWithRecovery(
      batch,
      apiKey,
      baseUrl,
      model,
      translationPrompt
    );
    for (const unit of batch) {
      const translatedText = batchTranslations.get(unit.id);
      if (!translatedText) {
        throw new Error(`AI missed translation segment ${unit.id}.`);
      }
      translations.set(unit.id, unit.restoreInline(translatedText.trim()));
    }
    completedBatches += 1;
    if (onProgress) {
      onProgress({
        completedBatches,
        totalBatches: batches.length,
      });
    }
    await yieldToEventLoop();
    await translateNextBatch();
  };

  await Promise.all(
    Array.from({ length: workerCount }, () => translateNextBatch())
  );

  return translations;
}

function applyTranslations(
  template: string,
  units: TranslationUnit[],
  translations: Map<string, string>
): string {
  return template.replace(
    new RegExp(`\\{\\{${TRANSLATION_PREFIX}(\\d+)\\}\\}`, 'g'),
    (match, index) => {
      const unit = units[Number(index)];
      if (!unit) {
        return match;
      }
      return translations.get(unit.id) || match;
    }
  );
}

export async function translateAcademicSelection(
  text: unknown
): Promise<string> {
  if (typeof text !== 'string' || !text.trim()) {
    return '';
  }

  const { apiKey, baseUrl, model, translationPrompt } = getSelectionAiConfig();
  if (!apiKey) {
    throw new Error(getMissingApiKeyMessage());
  }

  const messages: DeepSeekMessage[] = [
    {
      role: 'system',
      content: translationPrompt,
    },
    {
      role: 'user',
      content: text.trim(),
    },
  ];

  const response = await postJsonImplementation<DeepSeekResponse>(
    baseUrl,
    '/chat/completions',
    apiKey,
    {
      model,
      messages,
      thinking: { type: 'disabled' },
      temperature: 0.2,
      [MAX_TOKENS_FIELD]: 1024,
      stream: false,
    }
  );

  const translated = response.choices && response.choices[0]?.message?.content;
  if (!translated) {
    throw new Error('AI returned an empty translation.');
  }

  return translated.trim();
}

export async function translateAcademicMarkdown(
  markdown: string,
  onProgress?: (progress: MarkdownTranslationProgress) => void
): Promise<string> {
  const source = normalizeLatexForMarkdown(markdown.trim());
  if (!source) {
    return '';
  }

  const {
    apiKey,
    baseUrl,
    model,
    translationPrompt,
    translationConcurrency,
  } = getAiConfig();
  if (!apiKey) {
    throw new Error(getMissingApiKeyMessage());
  }

  const protectedSource = protectMarkdownBlocks(source);
  const { template, units } = buildTranslationTemplate(
    protectedSource.protectedMarkdown
  );
  if (!units.length) {
    return protectedSource.restore(template);
  }

  const translations = await translateMarkdownUnits(
    units,
    apiKey,
    baseUrl,
    model,
    translationPrompt,
    translationConcurrency,
    onProgress
  );
  return protectedSource.restore(
    applyTranslations(template, units, translations).trim()
  );
}

export async function testAiConnection(config: AiConfig): Promise<void> {
  const { apiKey, baseUrl, model } = config;
  if (!apiKey) {
    throw new Error(
      `${getMissingApiKeyMessage()} Solution: open Settings and set Paper Reader > AI: Api Key.`
    );
  }

  const response = await postJsonImplementation<DeepSeekResponse>(
    baseUrl,
    '/chat/completions',
    apiKey,
    {
      model,
      messages: [
        {
          role: 'user',
          content: 'Reply with OK.',
        },
      ],
      thinking: { type: 'disabled' },
      temperature: 0,
      [MAX_TOKENS_FIELD]: 8,
      stream: false,
    }
  );

  if (!response.choices || !response.choices[0]?.message?.content) {
    throw new Error(
      'AI API returned an empty response. Solution: verify baseUrl, model name, and API key permissions.'
    );
  }
}

export const testingHooks = {
  parseTranslationMap,
  translateMarkdownUnits,
  setPostJsonImplementation(implementation: PostJsonImplementation): void {
    postJsonImplementation = implementation;
  },
  resetPostJsonImplementation(): void {
    postJsonImplementation = postJson;
  },
};
