export interface FileMentionRange {
  readonly startLine: number;
  readonly endLine?: number;
}

export interface ParsedFileMention {
  readonly raw: string;
  readonly path: string;
  readonly quoted: boolean;
  readonly range?: FileMentionRange;
}

function isMentionBoundary(character: string | undefined): boolean {
  return (
    character === undefined ||
    /\s/.test(character) ||
    character === "(" ||
    character === "[" ||
    character === "{" ||
    character === "<" ||
    character === '"' ||
    character === "'" ||
    character === "`"
  );
}

function parseRange(fragment: string): FileMentionRange | undefined {
  const match = fragment.match(/^#L(\d+)(?:-(\d+))?$/);
  if (!match) {
    return undefined;
  }

  const startLine = Number.parseInt(match[1] ?? "", 10);
  const endLine = match[2] ? Number.parseInt(match[2], 10) : undefined;

  if (!Number.isInteger(startLine) || startLine <= 0) {
    return undefined;
  }

  if (
    endLine !== undefined &&
    (!Number.isInteger(endLine) || endLine < startLine)
  ) {
    return undefined;
  }

  return {
    startLine,
    ...(endLine !== undefined ? { endLine } : {}),
  };
}

function trimTrailingPunctuation(value: string): string {
  return value.replace(/[.,;:!?)}\]]+$/u, "");
}

function isFileLikeMentionPath(rawPath: string): boolean {
  if (rawPath.length === 0) {
    return false;
  }

  if (rawPath.includes(":")) {
    return false;
  }

  if (
    rawPath.startsWith("./") ||
    rawPath.startsWith("../") ||
    rawPath.startsWith("/") ||
    rawPath.startsWith("~/") ||
    rawPath.startsWith("~")
  ) {
    return true;
  }

  return (
    rawPath.includes("/") ||
    rawPath.includes("\\") ||
    rawPath.startsWith(".") ||
    /\.[^./\s]+$/u.test(rawPath)
  );
}

function parseToken(
  text: string,
  index: number,
): { mention: ParsedFileMention; end: number } | null {
  if (text[index] !== "@") {
    return null;
  }

  if (index > 0 && !isMentionBoundary(text[index - 1])) {
    return null;
  }

  let cursor = index + 1;
  if (cursor >= text.length) {
    return null;
  }

  const quoted = text[cursor] === '"' || text[cursor] === "'";
  const quote = quoted ? text[cursor] : undefined;
  let pathStart = cursor;
  let pathEnd = cursor;

  if (quoted) {
    pathStart += 1;
    pathEnd = pathStart;
    while (pathEnd < text.length && text[pathEnd] !== quote) {
      pathEnd += 1;
    }
    cursor = pathEnd < text.length ? pathEnd + 1 : text.length;
    while (cursor < text.length && !/\s/.test(text[cursor])) {
      cursor += 1;
    }
  } else {
    while (cursor < text.length && !/\s/.test(text[cursor])) {
      cursor += 1;
    }
    pathEnd = cursor;
  }

  const raw = text.slice(index, cursor);
  const token = text.slice(pathStart, pathEnd);
  let path = token;
  let fragment = "";

  if (quoted) {
    const suffix = text.slice(pathEnd + 1, cursor);
    if (suffix.startsWith("#")) {
      fragment = suffix;
    }
  } else {
    const fragmentIndex = token.indexOf("#");
    if (fragmentIndex >= 0) {
      path = token.slice(0, fragmentIndex);
      fragment = token.slice(fragmentIndex);
    }
  }

  const trimmedRaw = trimTrailingPunctuation(raw);
  const trimmedPath = trimTrailingPunctuation(path);
  const trimmedFragment = trimTrailingPunctuation(fragment);
  if (!isFileLikeMentionPath(trimmedPath)) {
    return null;
  }

  const range = parseRange(trimmedFragment);

  return {
    mention: {
      raw: trimmedRaw,
      path: trimmedPath,
      quoted,
      ...(range ? { range } : {}),
    },
    end: cursor,
  };
}

function mentionKey(mention: ParsedFileMention): string {
  return [
    mention.path,
    mention.range
      ? `${mention.range.startLine}:${mention.range.endLine ?? ""}`
      : "",
  ].join("|");
}

export class MentionParser {
  parse(text: string): ParsedFileMention[] {
    const mentions: ParsedFileMention[] = [];
    const seen = new Set<string>();

    for (let index = 0; index < text.length; index += 1) {
      const parsed = parseToken(text, index);
      if (!parsed) {
        continue;
      }

      const key = mentionKey(parsed.mention);
      if (seen.has(key)) {
        index = parsed.end - 1;
        continue;
      }

      seen.add(key);
      mentions.push(parsed.mention);
      index = parsed.end - 1;
    }

    return mentions;
  }
}
