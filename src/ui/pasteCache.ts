import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  formatBashHistoryEntry,
  getModeFromInput,
  parseBashHistoryEntry,
  type InputMode,
} from "./inputModes.js";
import {
  HISTORY_INLINE_MAX,
  type PromptSubmission,
} from "./input/promptSubmission.js";

const PASTE_REF_PATTERN = /^(?<bash>!)?paste:(?<hash>[a-f0-9]{64})$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

export interface PasteCache {
  /** Content-addressed write; returns sha256 hex digest. Sync, atomic temp + rename. */
  store(text: string): string;
  /** Read cache file by hash; null if missing. */
  read(hash: string): string | null;
  /** `parsePasteHistoryRef(entry)` then `read(hash)`; null if not a ref or file missing. */
  resolve(entry: string): string | null;
}

export interface PasteCacheOptions {
  cacheDir?: string;
}

export interface AppliedHistoryEntry {
  buffer: string;
  inputMode: InputMode;
}

export function parsePasteHistoryRef(
  entry: string,
): { hash: string; bash: boolean } | null {
  const match = PASTE_REF_PATTERN.exec(entry);
  if (!match?.groups?.hash) {
    return null;
  }

  return {
    hash: match.groups.hash,
    bash: Boolean(match.groups.bash),
  };
}

export function isPasteHistoryRef(entry: string): boolean {
  return parsePasteHistoryRef(entry) !== null;
}

function formatMissingPasteRefFallback(ref: {
  hash: string;
  bash: boolean;
}): string {
  return `paste:${ref.hash}`;
}

export function applyHistoryEntryToPrompt(
  stored: string,
  pasteCache: PasteCache,
): AppliedHistoryEntry {
  const pasteRef = parsePasteHistoryRef(stored);
  if (pasteRef) {
    const body = pasteCache.read(pasteRef.hash);
    return {
      inputMode: pasteRef.bash ? "bash" : "prompt",
      buffer: body ?? formatMissingPasteRefFallback(pasteRef),
    };
  }

  if (getModeFromInput(stored) === "bash") {
    return {
      inputMode: "bash",
      buffer: parseBashHistoryEntry(stored),
    };
  }

  return { inputMode: "prompt", buffer: stored };
}

export function buildPromptHistoryEntry(
  submission: PromptSubmission,
  pasteCache: PasteCache,
): string {
  if (submission.inputMode === "bash") {
    const trimmed = submission.text.trim();
    if (submission.text.length <= HISTORY_INLINE_MAX) {
      return formatBashHistoryEntry(trimmed);
    }

    const hash = pasteCache.store(submission.text);
    return `!paste:${hash}`;
  }

  if (submission.text.length <= HISTORY_INLINE_MAX) {
    return submission.text;
  }

  const hash = pasteCache.store(submission.text);
  return `paste:${hash}`;
}

export function createPasteCache(options: PasteCacheOptions = {}): PasteCache {
  const cacheDir =
    options.cacheDir ?? path.join(os.homedir(), ".propio", "paste-cache");
  let directoryReady = false;

  const ensureCacheDir = (): void => {
    if (directoryReady && fs.existsSync(cacheDir)) {
      return;
    }

    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    directoryReady = true;
  };

  const store = (text: string): string => {
    const hash = crypto.createHash("sha256").update(text, "utf8").digest("hex");
    const filePath = path.join(cacheDir, `${hash}.txt`);

    if (fs.existsSync(filePath)) {
      return hash;
    }

    ensureCacheDir();
    const tempPath = path.join(
      cacheDir,
      `.${hash}.${process.pid}.${Date.now()}.tmp`,
    );
    fs.writeFileSync(tempPath, text, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tempPath, filePath);
    return hash;
  };

  const read = (hash: string): string | null => {
    if (!HASH_PATTERN.test(hash)) {
      return null;
    }

    const filePath = path.join(cacheDir, `${hash}.txt`);
    try {
      return fs.readFileSync(filePath, "utf8");
    } catch {
      return null;
    }
  };

  return {
    store,
    read,
    resolve(entry: string): string | null {
      const parsed = parsePasteHistoryRef(entry);
      if (!parsed) {
        return null;
      }

      return read(parsed.hash);
    },
  };
}
