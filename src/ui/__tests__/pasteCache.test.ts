import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  applyHistoryEntryToPrompt,
  buildPromptHistoryEntry,
  createPasteCache,
  isPasteHistoryRef,
  parsePasteHistoryRef,
} from "../pasteCache.js";
import { createPlainSubmission } from "../input/promptSubmission.js";

describe("parsePasteHistoryRef", () => {
  const hash = "a".repeat(64);

  it("accepts chat paste refs", () => {
    expect(parsePasteHistoryRef(`paste:${hash}`)).toEqual({
      hash,
      bash: false,
    });
  });

  it("accepts bash paste refs", () => {
    expect(parsePasteHistoryRef(`!paste:${hash}`)).toEqual({
      hash,
      bash: true,
    });
  });

  it("rejects malformed refs", () => {
    expect(parsePasteHistoryRef(hash)).toBeNull();
    expect(parsePasteHistoryRef("paste:abc")).toBeNull();
    expect(parsePasteHistoryRef(`paste:${"A".repeat(64)}`)).toBeNull();
    expect(parsePasteHistoryRef(`paste:../${hash}`)).toBeNull();
    expect(parsePasteHistoryRef(`paste:${hash} notes`)).toBeNull();
  });
});

describe("isPasteHistoryRef", () => {
  it("returns true only for validated refs", () => {
    expect(isPasteHistoryRef(`paste:${"b".repeat(64)}`)).toBe(true);
    expect(isPasteHistoryRef("paste:foo")).toBe(false);
  });
});

describe("createPasteCache", () => {
  let tempRoot: string;
  let cacheDir: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "propio-paste-cache-"));
    cacheDir = path.join(tempRoot, "paste-cache");
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("stores and reads content by hash", () => {
    const cache = createPasteCache({ cacheDir });
    const text = "large pasted body";
    const hash = cache.store(text);

    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(cache.read(hash)).toBe(text);
    expect(cache.resolve(`paste:${hash}`)).toBe(text);
  });

  it("deduplicates identical content", () => {
    const cache = createPasteCache({ cacheDir });
    const hashA = cache.store("same text");
    const hashB = cache.store("same text");

    expect(hashA).toBe(hashB);
    expect(
      fs.readdirSync(cacheDir).filter((name) => name.endsWith(".txt")),
    ).toHaveLength(1);
  });

  it("rejects invalid hashes on read", () => {
    const cache = createPasteCache({ cacheDir });
    expect(cache.read("../escape")).toBeNull();
    expect(cache.read("abc")).toBeNull();
  });

  it("creates cache directory with restrictive permissions", () => {
    const cache = createPasteCache({ cacheDir });
    cache.store("secret prompt");

    const dirMode = fs.statSync(cacheDir).mode & 0o777;
    expect(dirMode).toBe(0o700);

    const fileName = fs
      .readdirSync(cacheDir)
      .find((name) => name.endsWith(".txt"));
    expect(fileName).toBeDefined();
    const fileMode = fs.statSync(path.join(cacheDir, fileName!)).mode & 0o777;
    expect(fileMode).toBe(0o600);
  });
});

describe("applyHistoryEntryToPrompt", () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "propio-paste-apply-"));
  });

  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it("restores cached chat paste refs in prompt mode", () => {
    const cache = createPasteCache({ cacheDir });
    const hash = cache.store("cached chat body");

    expect(applyHistoryEntryToPrompt(`paste:${hash}`, cache)).toEqual({
      inputMode: "prompt",
      buffer: "cached chat body",
    });
  });

  it("restores cached bash paste refs in bash mode", () => {
    const cache = createPasteCache({ cacheDir });
    const hash = cache.store("git status --long");

    expect(applyHistoryEntryToPrompt(`!paste:${hash}`, cache)).toEqual({
      inputMode: "bash",
      buffer: "git status --long",
    });
  });

  it("falls back to paste ref when cache file is missing", () => {
    const cache = createPasteCache({ cacheDir });
    const hash = "c".repeat(64);

    expect(applyHistoryEntryToPrompt(`!paste:${hash}`, cache)).toEqual({
      inputMode: "bash",
      buffer: `paste:${hash}`,
    });
  });

  it("handles inline bash history entries", () => {
    const cache = createPasteCache({ cacheDir });

    expect(applyHistoryEntryToPrompt("!git status", cache)).toEqual({
      inputMode: "bash",
      buffer: "git status",
    });
  });
});

describe("buildPromptHistoryEntry", () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "propio-paste-build-"));
  });

  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it("stores large chat submissions as paste refs", () => {
    const cache = createPasteCache({ cacheDir });
    const text = "x".repeat(1025);
    const entry = buildPromptHistoryEntry(
      createPlainSubmission(text, "prompt"),
      cache,
    );

    expect(entry).toMatch(/^paste:[a-f0-9]{64}$/);
    expect(cache.resolve(entry)).toBe(text);
  });

  it("stores large bash submissions as !paste refs", () => {
    const cache = createPasteCache({ cacheDir });
    const text = "y".repeat(1025);
    const entry = buildPromptHistoryEntry(
      createPlainSubmission(text, "bash"),
      cache,
    );

    expect(entry).toMatch(/^!paste:[a-f0-9]{64}$/);
    expect(cache.resolve(entry.slice(1))).toBe(text);
  });
});
