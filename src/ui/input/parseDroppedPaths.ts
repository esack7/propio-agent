import { fileURLToPath } from "node:url";

export type DroppedTextClassification = {
  paths: string[];
  allNonEmptyLinesArePaths: boolean;
};

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

function isBarePathLine(line: string): boolean {
  if (line.startsWith("/")) {
    return true;
  }
  if (line.startsWith("./") || line.startsWith("../")) {
    return true;
  }
  if (line.startsWith("~/") || line === "~") {
    return true;
  }
  return /^[A-Za-z]:[\\/]/.test(line);
}

function parseLineAsPath(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.startsWith("file://")) {
    try {
      return fileURLToPath(trimmed);
    } catch {
      return null;
    }
  }

  if (isBarePathLine(trimmed)) {
    return trimmed;
  }

  return null;
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
  const lines = text.split("\n").map((line) => line.trim());
  const paths: string[] = [];
  let allNonEmptyLinesArePaths = true;

  for (const line of lines) {
    if (line.length === 0) {
      continue;
    }

    const path = parseLineAsPath(line);
    if (path === null) {
      allNonEmptyLinesArePaths = false;
      continue;
    }

    paths.push(path);
  }

  if (paths.length === 0) {
    allNonEmptyLinesArePaths = false;
  }

  return { paths, allNonEmptyLinesArePaths };
}
