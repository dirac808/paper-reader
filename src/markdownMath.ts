type KatexApi = {
  renderToString(
    content: string,
    options: {
      displayMode: boolean;
      strict: boolean;
      throwOnError: boolean;
      trust: boolean;
    }
  ): string;
};

const katex = require('katex') as KatexApi;

type MarkdownToken = {
  block?: boolean;
  content: string;
  map?: number[];
  markup?: string;
};

type MarkdownStateBlock = {
  bMarks: number[];
  eMarks: number[];
  line: number;
  lineMax: number;
  src: string;
  tShift: number[];
  push(type: string, tag: string, nesting: number): MarkdownToken;
};

type MarkdownStateInline = {
  pos: number;
  posMax: number;
  src: string;
  push(type: string, tag: string, nesting: number): MarkdownToken;
};

type MarkdownRendererRules = {
  [name: string]: (
    tokens: MarkdownToken[],
    index: number,
    options: unknown,
    env: unknown,
    self: unknown
  ) => string;
};

type MarkdownIt = {
  block: {
    ruler: {
      before(
        beforeName: string,
        ruleName: string,
        rule: MarkdownBlockRule,
        options?: { alt?: string[] }
      ): void;
    };
  };
  inline: {
    ruler: {
      before(
        beforeName: string,
        ruleName: string,
        rule: MarkdownInlineRule
      ): void;
    };
  };
  renderer: {
    rules: MarkdownRendererRules;
  };
  utils: {
    escapeHtml(value: string): string;
  };
};

type MarkdownBlockRule = (
  state: MarkdownStateBlock,
  startLine: number,
  endLine: number,
  silent: boolean
) => boolean;

type MarkdownInlineRule = (
  state: MarkdownStateInline,
  silent: boolean
) => boolean;

function isEscaped(source: string, index: number): boolean {
  let slashCount = 0;
  for (
    let cursor = index - 1;
    cursor >= 0 && source[cursor] === '\\';
    cursor--
  ) {
    slashCount++;
  }
  return slashCount % 2 === 1;
}

function findClosingDelimiter(
  source: string,
  delimiter: string,
  from: number
): number {
  let cursor = from;
  while (cursor < source.length) {
    const found = source.indexOf(delimiter, cursor);
    if (found === -1) {
      return -1;
    }
    if (!isEscaped(source, found)) {
      return found;
    }
    cursor = found + delimiter.length;
  }
  return -1;
}

function escapeHtml(content: string): string {
  return content
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderMath(content: string, displayMode: boolean): string {
  try {
    return katex.renderToString(content, {
      displayMode,
      throwOnError: false,
      strict: false,
      trust: false,
    });
  } catch {
    return `<code>${escapeHtml(content)}</code>`;
  }
}

function createMathBlockRule(): MarkdownBlockRule {
  return (state, startLine, endLine, silent): boolean => {
    const start = state.bMarks[startLine] + state.tShift[startLine];
    const max = state.eMarks[startLine];
    const firstLine = state.src.slice(start, max).trim();
    let opener = '';
    let closer = '';

    if (firstLine.startsWith('\\[')) {
      opener = '\\[';
      closer = '\\]';
    } else if (firstLine.startsWith('$$')) {
      opener = '$$';
      closer = '$$';
    } else {
      return false;
    }

    const firstContent = firstLine.slice(opener.length);
    const inlineClose = firstContent.indexOf(closer);
    if (inlineClose !== -1) {
      if (!silent) {
        const token = state.push('paper_reader_math_block', 'math', 0);
        token.block = true;
        token.content = firstContent.slice(0, inlineClose).trim();
        token.map = [startLine, startLine + 1];
        token.markup = opener;
      }
      state.line = startLine + 1;
      return true;
    }

    let nextLine = startLine;
    const contentLines = [firstContent];
    while (++nextLine < endLine) {
      const lineStart = state.bMarks[nextLine] + state.tShift[nextLine];
      const lineEnd = state.eMarks[nextLine];
      const line = state.src.slice(lineStart, lineEnd);
      const closeIndex = line.indexOf(closer);
      if (closeIndex !== -1) {
        contentLines.push(line.slice(0, closeIndex));
        break;
      }
      contentLines.push(line);
    }

    if (nextLine >= endLine) {
      return false;
    }

    if (!silent) {
      const token = state.push('paper_reader_math_block', 'math', 0);
      token.block = true;
      token.content = contentLines.join('\n').trim();
      token.map = [startLine, nextLine + 1];
      token.markup = opener;
    }
    state.line = nextLine + 1;
    return true;
  };
}

function createMathInlineRule(): MarkdownInlineRule {
  return (state, silent): boolean => {
    const source = state.src;
    const position = state.pos;
    let opener = '';
    let closer = '';

    if (source.startsWith('\\(', position)) {
      opener = '\\(';
      closer = '\\)';
    } else if (
      source[position] === '$' &&
      source[position + 1] !== '$' &&
      !isEscaped(source, position)
    ) {
      opener = '$';
      closer = '$';
    } else {
      return false;
    }

    const contentStart = position + opener.length;
    const contentEnd = findClosingDelimiter(source, closer, contentStart);
    if (contentEnd === -1 || contentEnd === contentStart) {
      return false;
    }

    if (!silent) {
      const token = state.push('paper_reader_math_inline', 'math', 0);
      token.content = source.slice(contentStart, contentEnd);
      token.markup = opener;
    }
    state.pos = contentEnd + closer.length;
    return true;
  };
}

export function extendMarkdownItWithMath(md: MarkdownIt): MarkdownIt {
  md.block.ruler.before(
    'blockquote',
    'paper_reader_math_block',
    createMathBlockRule(),
    { alt: ['paragraph', 'reference', 'blockquote', 'list'] }
  );
  md.inline.ruler.before(
    'escape',
    'paper_reader_math_inline',
    createMathInlineRule()
  );
  md.renderer.rules['paper_reader_math_block'] = (tokens, index): string =>
    `<p class="paper-reader-math-block" data-source-line="${
      tokens[index].map ? tokens[index].map?.[0] + 1 : ''
    }">${renderMath(tokens[index].content, true)}</p>\n`;
  md.renderer.rules['paper_reader_math_inline'] = (tokens, index): string =>
    `<span class="paper-reader-math-inline">${renderMath(
      tokens[index].content,
      false
    )}</span>`;
  return md;
}
