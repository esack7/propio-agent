import { fileURLToPath } from "node:url";

export type DroppedPathsLineResult =
  | { ok: true; paths: string[] }
  | { ok: false; paths: string[] };

export type DroppedTextClassification = {
  paths: string[];
  allNonEmptyLinesArePaths: boolean;
};

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
]);

function isBarePathToken(token: string): boolean {
  if (token.startsWith("/")) {
    return true;
  }
  if (token.startsWith("./") || token.startsWith("../")) {
    return true;
  }
  if (token.startsWith("~/") || token === "~") {
    return true;
  }
  return /^[A-Za-z]:[\\/]/.test(token);
}

function parseQuotedPathToken(
  line: string,
  start: number,
): { value: string; end: number } | null {
  const quote = line[start];
  let value = "";
  let index = start + 1;

  while (index < line.length) {
    const char = line[index];
    if (char === "\\" && index + 1 < line.length) {
      const next = line[index + 1];
      if (next === quote || next === "\\") {
        value += next;
        index += 2;
        continue;
      }
    }
    if (char === quote) {
      return { value, end: index + 1 };
    }
    value += char;
    index += 1;
  }

  return null;
}

function parseFileUrlToken(
  line: string,
  start: number,
): { value: string; end: number } | null {
  let index = start;
  while (index < line.length && !/\s/.test(line[index])) {
    index += 1;
  }

  const raw = line.slice(start, index);
  try {
    return { value: fileURLToPath(raw), end: index };
  } catch {
    return null;
  }
}

function parseUnquotedPathToken(
  line: string,
  start: number,
): { value: string; end: number } | null {
  let raw = "";
  let index = start;

  while (index < line.length) {
    if (
      line[index] === "\\" &&
      index + 1 < line.length &&
      line[index + 1] === " "
    ) {
      raw += " ";
      index += 2;
      continue;
    }
    if (/\s/.test(line[index])) {
      break;
    }
    raw += line[index];
    index += 1;
  }

  if (raw.length === 0) {
    return null;
  }

  if (!isBarePathToken(raw)) {
    return null;
  }

  return { value: raw, end: index };
}

function parsePathToken(
  line: string,
  start: number,
): { value: string; end: number } | null {
  if (line[start] === '"' || line[start] === "'") {
    const quoted = parseQuotedPathToken(line, start);
    if (!quoted || !isBarePathToken(quoted.value)) {
      return null;
    }
    return quoted;
  }

  if (line.slice(start).startsWith("file://")) {
    return parseFileUrlToken(line, start);
  }

  return parseUnquotedPathToken(line, start);
}

/** Parse one line (0..N paths). ok === true iff the entire line is consumed as paths only. */
export function parseDroppedPathsLine(line: string): DroppedPathsLineResult {
  const normalized = line.replace(/\r$/, "").trim();
  if (normalized.length === 0) {
    return { ok: false, paths: [] };
  }

  const paths: string[] = [];
  let index = 0;

  while (index < normalized.length) {
    while (index < normalized.length && /\s/.test(normalized[index])) {
      index += 1;
    }
    if (index >= normalized.length) {
      break;
    }

    const token = parsePathToken(normalized, index);
    if (!token) {
      return { ok: false, paths };
    }

    paths.push(token.value);
    index = token.end;
  }

  if (paths.length === 0) {
    return { ok: false, paths: [] };
  }

  return { ok: true, paths };
}

export function isImagePath(path: string): boolean {
  const lower = path.toLowerCase();
  for (const ext of IMAGE_EXTENSIONS) {
    if (lower.endsWith(ext)) {
      return true;
    }
  }
  return false;
}

export function classifyDroppedText(text: string): DroppedTextClassification {
  const lines = text.split("\n");
  const paths: string[] = [];
  let allNonEmptyLinesArePaths = true;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "").trim();
    if (line.length === 0) {
      continue;
    }

    const result = parseDroppedPathsLine(line);
    if (!result.ok || result.paths.length === 0) {
      allNonEmptyLinesArePaths = false;
      continue;
    }

    paths.push(...result.paths);
  }

  if (paths.length === 0) {
    allNonEmptyLinesArePaths = false;
  }

  return { paths, allNonEmptyLinesArePaths };
}
