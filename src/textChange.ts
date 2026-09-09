export type MinimalTextChange = {
  start: number;
  end: number;
  text: string;
};

export function normalizeLineEndings(
  text: string,
  lineEnding: '\n' | '\r\n'
): string {
  return text.replace(/\r\n|\r|\n/g, '\n').replace(/\n/g, lineEnding);
}

export function computeMinimalTextChange(
  current: string,
  next: string
): MinimalTextChange | undefined {
  if (current === next) {
    return undefined;
  }

  const sharedLimit = Math.min(current.length, next.length);
  let start = 0;
  while (
    start < sharedLimit &&
    current.charCodeAt(start) === next.charCodeAt(start)
  ) {
    start += 1;
  }

  let currentEnd = current.length;
  let nextEnd = next.length;
  while (
    currentEnd > start &&
    nextEnd > start &&
    current.charCodeAt(currentEnd - 1) === next.charCodeAt(nextEnd - 1)
  ) {
    currentEnd -= 1;
    nextEnd -= 1;
  }

  return {
    start,
    end: currentEnd,
    text: next.slice(start, nextEnd),
  };
}
