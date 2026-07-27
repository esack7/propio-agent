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
  if (!match) return undefined;

  const startLine = Number.parseInt(match[1] ?? "", 10);
  const endLine = match[2] ? Number.parseInt(match[2], 10) : undefined;
  if (!isValidLineNumber(startLine)) return undefined;
  if (endLine !== undefined && !isValidEndLine(endLine, startLine))
    return undefined;

  return {
    startLine,
    ...(endLine !== undefined ? { endLine } : {}),
  };
}

function isValidLineNumber(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function isValidEndLine(value: number, startLine: number): boolean {
  return isValidLineNumber(value) && value >= startLine;
}

function trimTrailingPunctuation(value: string): string {
  return value.replace(/[.,;:!?)}\]]+$/u, "");
}

function isFileLikeMentionPath(rawPath: string): boolean {
  if (!rawPath || rawPath.includes(":")) return false;
  if (isBareHyphenatedName(rawPath)) return false;
  return hasExplicitPathPrefix(rawPath) || hasFileLikeSyntax(rawPath);
}

function isBareHyphenatedName(rawPath: string): boolean {
  return rawPath.includes("-") && !/[\\/.]/u.test(rawPath);
}

function hasExplicitPathPrefix(rawPath: string): boolean {
  return ["./", "../", "/", "~/", "~"].some((prefix) =>
    rawPath.startsWith(prefix),
  );
}

function hasFileLikeSyntax(rawPath: string): boolean {
  return (
    /[\\/]/u.test(rawPath) ||
    rawPath.startsWith(".") ||
    /^[\p{L}\p{N}_]+$/u.test(rawPath) ||
    /\.[^./\s]+$/u.test(rawPath)
  );
}

interface MentionTokenBounds {
  readonly quoted: boolean;
  readonly pathStart: number;
  readonly pathEnd: number;
  readonly end: number;
}

function readMentionTokenBounds(
  text: string,
  start: number,
): MentionTokenBounds | null {
  const cursor = start + 1;
  if (cursor >= text.length) return null;

  const quote =
    text[cursor] === '"' || text[cursor] === "'" ? text[cursor] : undefined;
  return quote
    ? readQuotedMentionBounds(text, cursor, quote)
    : readUnquotedMentionBounds(text, cursor);
}

function readQuotedMentionBounds(
  text: string,
  quoteIndex: number,
  quote: string,
): MentionTokenBounds {
  let cursor = quoteIndex + 1;
  const pathStart = cursor;
  while (cursor < text.length && text[cursor] !== quote) cursor += 1;
  const pathEnd = cursor;
  cursor = cursor < text.length ? cursor + 1 : text.length;
  while (cursor < text.length && !/\s/.test(text[cursor])) cursor += 1;
  return { quoted: true, pathStart, pathEnd, end: cursor };
}

function readUnquotedMentionBounds(
  text: string,
  pathStart: number,
): MentionTokenBounds {
  let cursor = pathStart;
  while (cursor < text.length && !/\s/.test(text[cursor])) cursor += 1;
  return { quoted: false, pathStart, pathEnd: cursor, end: cursor };
}

function splitMentionPathAndFragment(
  text: string,
  bounds: MentionTokenBounds,
): { path: string; fragment: string } {
  const token = text.slice(bounds.pathStart, bounds.pathEnd);
  if (bounds.quoted) {
    const suffix = text.slice(bounds.pathEnd + 1, bounds.end);
    return { path: token, fragment: suffix.startsWith("#") ? suffix : "" };
  }

  const fragmentIndex = token.indexOf("#");
  return fragmentIndex < 0
    ? { path: token, fragment: "" }
    : {
        path: token.slice(0, fragmentIndex),
        fragment: token.slice(fragmentIndex),
      };
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

  const bounds = readMentionTokenBounds(text, index);
  if (!bounds) return null;
  const { path, fragment } = splitMentionPathAndFragment(text, bounds);

  const trimmedRaw = trimTrailingPunctuation(text.slice(index, bounds.end));
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
      quoted: bounds.quoted,
      ...(range ? { range } : {}),
    },
    end: bounds.end,
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
