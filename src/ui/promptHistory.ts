import * as fs from "fs";
import * as path from "path";

export interface PromptHistoryStore {
  load(): readonly string[];
  record(text: string): void;
}

export interface PromptHistoryStoreOptions {
  filePath: string;
  maxEntries?: number;
}

interface PromptHistoryFile {
  version: 1;
  entries: string[];
}

const DEFAULT_MAX_ENTRIES = 200;

export function shouldRecordPromptHistoryEntry(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return false;
  }

  return !/^\/(?:clear|exit|quit)(?:\s|$)/i.test(trimmed);
}

function isPromptHistoryFile(value: unknown): value is PromptHistoryFile {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const obj = value as Record<string, unknown>;
  return obj.version === 1 && Array.isArray(obj.entries);
}

function normalizeEntries(
  entries: ReadonlyArray<string>,
  maxEntries: number,
): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (seen.has(entry)) {
      continue;
    }

    seen.add(entry);
    deduped.push(entry);

    if (deduped.length >= maxEntries) {
      break;
    }
  }

  return deduped;
}

function loadHistoryFile(filePath: string, maxEntries: number): string[] {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const parsed: unknown = JSON.parse(content);
    if (!isPromptHistoryFile(parsed)) {
      return [];
    }

    const entries = parsed.entries.filter(
      (entry): entry is string => typeof entry === "string",
    );
    return normalizeEntries(entries, maxEntries);
  } catch {
    return [];
  }
}

function saveHistoryFile(
  filePath: string,
  entries: readonly string[],
  maxEntries: number,
): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });

  const nextEntries = normalizeEntries(entries, maxEntries);
  const payload: PromptHistoryFile = {
    version: 1,
    entries: nextEntries,
  };

  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );

  fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  try {
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // best-effort cleanup only
    }
    throw error;
  }
}

export function createPromptHistoryStore(
  options: PromptHistoryStoreOptions,
): PromptHistoryStore {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;

  return {
    load(): readonly string[] {
      return loadHistoryFile(options.filePath, maxEntries);
    },
    record(text: string): void {
      if (!shouldRecordPromptHistoryEntry(text)) {
        return;
      }

      try {
        const existing = loadHistoryFile(options.filePath, maxEntries);
        const nextEntries = [
          text,
          ...existing.filter((entry) => entry !== text),
        ];
        saveHistoryFile(options.filePath, nextEntries, maxEntries);
      } catch {
        // Prompt history is best-effort; do not block prompt submission.
      }
    },
  };
}
