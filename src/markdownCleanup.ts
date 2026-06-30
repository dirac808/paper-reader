export type MarkdownMathNormalizationResult = {
  markdown: string;
  changedBlocks: number;
};

function getFenceMarker(line: string): string | undefined {
  const match = line.match(/^\s*(`{3,}|~{3,})/);
  return match?.[1];
}

function closesFence(line: string, fenceMarker: string): boolean {
  const fenceChar = fenceMarker[0];
  const minLength = fenceMarker.length;
  const match = line.match(new RegExp(`^\\s*\\${fenceChar}{${minLength},}`));
  return !!match;
}

function splitLineEnding(markdown: string): { text: string; eol: string } {
  return {
    text: markdown.replace(/\r\n/g, '\n'),
    eol: markdown.includes('\r\n') ? '\r\n' : '\n',
  };
}

function appendMathBlock(
  output: string[],
  indent: string,
  bodyLines: string[]
): void {
  output.push(`${indent}$$`);
  const trimmed = bodyLines.join('\n').trim();
  if (trimmed) {
    output.push(...trimmed.split('\n'));
  }
  output.push(`${indent}$$`);
}

export function normalizeMarkdownMathDelimiters(
  markdown: string
): MarkdownMathNormalizationResult {
  const { text, eol } = splitLineEnding(markdown);
  const lines = text.split('\n');
  const output: string[] = [];
  let changedBlocks = 0;
  let activeFence: string | undefined;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const fence = getFenceMarker(line);
    if (activeFence) {
      output.push(line);
      if (closesFence(line, activeFence)) {
        activeFence = undefined;
      }
      continue;
    }
    if (fence) {
      activeFence = fence;
      output.push(line);
      continue;
    }

    const startMatch = line.match(/^([ \t]*)\\\[\s*(.*)$/);
    if (!startMatch) {
      output.push(line);
      continue;
    }

    const indent = startMatch[1];
    const firstBody = startMatch[2];
    const inlineClose = firstBody.match(/^(.*?)\s*\\\]\s*$/);
    if (inlineClose) {
      appendMathBlock(output, indent, [inlineClose[1]]);
      changedBlocks++;
      continue;
    }

    const bodyLines = [firstBody];
    let closeIndex = -1;
    for (let cursor = index + 1; cursor < lines.length; cursor++) {
      const closeMatch = lines[cursor].match(/^(.*?)\s*\\\]\s*$/);
      if (closeMatch) {
        bodyLines.push(closeMatch[1]);
        closeIndex = cursor;
        break;
      }
      bodyLines.push(lines[cursor]);
    }

    if (closeIndex < 0) {
      output.push(line);
      continue;
    }

    appendMathBlock(output, indent, bodyLines);
    changedBlocks++;
    index = closeIndex;
  }

  return {
    markdown: output.join(eol),
    changedBlocks,
  };
}
