import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import {
  writeSnapshot,
  readSnapshot,
  readIndex,
  writeIndex,
  rebuildIndex,
  listSessions,
  resolveLatestSession,
  resolveSessionById,
  resolveWorkspaceRoot,
  hashWorkspace,
  getWorkspaceSessionsDir,
  getDefaultSessionsDir,
  SessionIndex,
  SessionIndexEntry,
} from "../sessionHistory.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpRoot: string;

function freshDir(): string {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "sess-"));
  return dir;
}

function minimalSessionJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 2,
    savedAt: overrides.savedAt ?? new Date().toISOString(),
    metadata: {
      providerName: overrides.providerName ?? "test-provider",
      modelKey: overrides.modelKey ?? "test-model",
      systemPrompt: "You are a test assistant.",
      promptBudgetPolicy: {
        reservedOutputTokens: 2048,
        maxRecentTurns: 50,
        artifactInlineCharCap: 12000,
      },
      summaryPolicy: {
        rawRecentTurns: 6,
        refreshIntervalTurns: 3,
        summaryTargetTokens: 512,
        contextPressureThreshold: 0.6,
      },
      contextWindowTokens: 128000,
    },
    context: {
      preamble: [],
      turns: overrides.turns ?? [],
      artifacts: [],
      pinnedMemory: [],
      ...(overrides.rollingSummary !== undefined
        ? { rollingSummary: overrides.rollingSummary }
        : {}),
    },
  });
}

function makeTurn(id: string, content: string): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    id,
    startedAt: now,
    completedAt: now,
    importance: "normal",
    userMessage: { role: "user", content },
    entries: [
      {
        kind: "assistant",
        createdAt: now,
        message: { role: "assistant", content: `Reply to: ${content}` },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "propio-session-test-"));
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sessionHistory", () => {
  // =================================================================
  // writeSnapshot
  // =================================================================

  describe("writeSnapshot", () => {
    it("should create a snapshot file and update the index", () => {
      const dir = freshDir();
      const json = minimalSessionJson({
        turns: [makeTurn("t1", "hello")],
      });

      const entry = writeSnapshot(dir, json);

      expect(entry.sessionId).toBeTruthy();
      expect(entry.snapshotFile).toMatch(/\.json$/);
      expect(entry.turnCount).toBe(1);
      expect(entry.providerName).toBe("test-provider");
      expect(entry.modelKey).toBe("test-model");
      expect(entry.hasRollingSummary).toBe(false);

      const snapshotContent = fs.readFileSync(
        path.join(dir, entry.snapshotFile),
        "utf8",
      );
      expect(snapshotContent).toBe(json);

      const index = readIndex(dir);
      expect(index).not.toBeNull();
      expect(index!.entries).toHaveLength(1);
      expect(index!.entries[0].sessionId).toBe(entry.sessionId);
    });

    it("should create multiple distinct entries for repeated saves", () => {
      const dir = freshDir();

      const entry1 = writeSnapshot(
        dir,
        minimalSessionJson({
          savedAt: "2026-03-29T10:00:00.000Z",
          turns: [makeTurn("t1", "first")],
        }),
      );
      const entry2 = writeSnapshot(
        dir,
        minimalSessionJson({
          savedAt: "2026-03-29T10:01:00.000Z",
          turns: [makeTurn("t1", "first"), makeTurn("t2", "second")],
        }),
      );

      expect(entry1.sessionId).not.toBe(entry2.sessionId);
      expect(entry1.snapshotFile).not.toBe(entry2.snapshotFile);

      const index = readIndex(dir);
      expect(index!.entries).toHaveLength(2);
    });

    it("should detect rolling summary presence", () => {
      const dir = freshDir();

      const withSummary = writeSnapshot(
        dir,
        minimalSessionJson({
          rollingSummary: {
            content: "A summary",
            updatedAt: "2026-01-01T00:00:00Z",
            coveredTurnIds: ["t1"],
            estimatedTokens: 10,
          },
        }),
      );

      expect(withSummary.hasRollingSummary).toBe(true);

      const withoutSummary = writeSnapshot(dir, minimalSessionJson());
      expect(withoutSummary.hasRollingSummary).toBe(false);
    });

    it("should create the sessions directory if it does not exist", () => {
      const dir = path.join(freshDir(), "nested", "sessions");
      expect(fs.existsSync(dir)).toBe(false);

      writeSnapshot(dir, minimalSessionJson());

      expect(fs.existsSync(dir)).toBe(true);
    });
  });

  // =================================================================
  // readSnapshot
  // =================================================================

  describe("readSnapshot", () => {
    it("should read back the exact JSON that was written", () => {
      const dir = freshDir();
      const json = minimalSessionJson({
        turns: [makeTurn("t1", "read me back")],
      });

      const entry = writeSnapshot(dir, json);
      const content = readSnapshot(dir, entry.snapshotFile);
      expect(content).toBe(json);
    });

    it("should throw when snapshot file does not exist", () => {
      const dir = freshDir();
      expect(() => readSnapshot(dir, "nonexistent.json")).toThrow();
    });
  });

  // =================================================================
  // readIndex / writeIndex
  // =================================================================

  describe("readIndex / writeIndex", () => {
    it("should return null when index does not exist", () => {
      const dir = freshDir();
      expect(readIndex(dir)).toBeNull();
    });

    it("should return null for malformed index JSON", () => {
      const dir = freshDir();
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "index.json"), "not json", "utf8");
      expect(readIndex(dir)).toBeNull();
    });

    it("should return null for index with wrong shape", () => {
      const dir = freshDir();
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "index.json"),
        JSON.stringify({ wrong: "shape" }),
        "utf8",
      );
      expect(readIndex(dir)).toBeNull();
    });

    it("should round-trip an index through write and read", () => {
      const dir = freshDir();
      const index: SessionIndex = {
        entries: [
          {
            sessionId: "test-id",
            snapshotFile: "test-id.json",
            savedAt: "2026-01-01T00:00:00Z",
            providerName: "prov",
            modelKey: "mod",
            turnCount: 3,
            hasRollingSummary: true,
          },
        ],
      };

      writeIndex(dir, index);
      const read = readIndex(dir);

      expect(read).not.toBeNull();
      expect(read!.entries).toHaveLength(1);
      expect(read!.entries[0]).toEqual(index.entries[0]);
    });
  });

  // =================================================================
  // rebuildIndex
  // =================================================================

  describe("rebuildIndex", () => {
    it("should return empty index for nonexistent directory", () => {
      const dir = path.join(freshDir(), "does-not-exist");
      const index = rebuildIndex(dir);
      expect(index.entries).toEqual([]);
    });

    it("should rebuild from snapshot files when index is missing", () => {
      const dir = freshDir();

      writeSnapshot(
        dir,
        minimalSessionJson({
          savedAt: "2026-03-29T09:00:00.000Z",
          turns: [makeTurn("t1", "first")],
        }),
      );
      writeSnapshot(
        dir,
        minimalSessionJson({
          savedAt: "2026-03-29T10:00:00.000Z",
          turns: [makeTurn("t1", "first"), makeTurn("t2", "second")],
        }),
      );

      // Delete the index
      const idxPath = path.join(dir, "index.json");
      fs.unlinkSync(idxPath);
      expect(readIndex(dir)).toBeNull();

      const rebuilt = rebuildIndex(dir);
      expect(rebuilt.entries).toHaveLength(2);
      // Newest first
      expect(rebuilt.entries[0].savedAt).toBe("2026-03-29T10:00:00.000Z");
      expect(rebuilt.entries[0].turnCount).toBe(2);
      expect(rebuilt.entries[1].savedAt).toBe("2026-03-29T09:00:00.000Z");
      expect(rebuilt.entries[1].turnCount).toBe(1);

      // Should also persist the rebuilt index
      const persisted = readIndex(dir);
      expect(persisted).not.toBeNull();
      expect(persisted!.entries).toHaveLength(2);
    });

    it("should skip malformed snapshot files during rebuild", () => {
      const dir = freshDir();
      fs.mkdirSync(dir, { recursive: true });

      // Write one valid snapshot directly
      fs.writeFileSync(
        path.join(dir, "2026-03-29T10-00-00.000Z-aabbcc.json"),
        minimalSessionJson({
          savedAt: "2026-03-29T10:00:00.000Z",
          turns: [makeTurn("t1", "valid")],
        }),
        "utf8",
      );

      // Write a malformed file
      fs.writeFileSync(
        path.join(dir, "2026-03-29T09-00-00.000Z-ddeeff.json"),
        "not valid json at all",
        "utf8",
      );

      const rebuilt = rebuildIndex(dir);
      expect(rebuilt.entries).toHaveLength(1);
      expect(rebuilt.entries[0].turnCount).toBe(1);
    });

    it("should not include index.json as a snapshot", () => {
      const dir = freshDir();
      writeSnapshot(dir, minimalSessionJson());

      // Delete and rebuild
      fs.unlinkSync(path.join(dir, "index.json"));
      const rebuilt = rebuildIndex(dir);

      expect(rebuilt.entries).toHaveLength(1);
      for (const e of rebuilt.entries) {
        expect(e.snapshotFile).not.toBe("index.json");
      }
    });
  });

  // =================================================================
  // listSessions
  // =================================================================

  describe("listSessions", () => {
    it("should return sessions newest-first", () => {
      const dir = freshDir();

      writeSnapshot(
        dir,
        minimalSessionJson({
          savedAt: "2026-03-29T08:00:00.000Z",
          providerName: "oldest",
        }),
      );
      writeSnapshot(
        dir,
        minimalSessionJson({
          savedAt: "2026-03-29T12:00:00.000Z",
          providerName: "newest",
        }),
      );
      writeSnapshot(
        dir,
        minimalSessionJson({
          savedAt: "2026-03-29T10:00:00.000Z",
          providerName: "middle",
        }),
      );

      const sessions = listSessions(dir);
      expect(sessions).toHaveLength(3);
      expect(sessions[0].providerName).toBe("newest");
      expect(sessions[1].providerName).toBe("middle");
      expect(sessions[2].providerName).toBe("oldest");
    });

    it("should rebuild the index if it is missing", () => {
      const dir = freshDir();

      writeSnapshot(
        dir,
        minimalSessionJson({ savedAt: "2026-03-29T10:00:00.000Z" }),
      );
      fs.unlinkSync(path.join(dir, "index.json"));

      const sessions = listSessions(dir);
      expect(sessions).toHaveLength(1);

      // Index should now be rebuilt on disk
      expect(readIndex(dir)).not.toBeNull();
    });

    it("should rebuild the index if it is malformed", () => {
      const dir = freshDir();

      writeSnapshot(
        dir,
        minimalSessionJson({ savedAt: "2026-03-29T10:00:00.000Z" }),
      );
      fs.writeFileSync(path.join(dir, "index.json"), "corrupted", "utf8");

      const sessions = listSessions(dir);
      expect(sessions).toHaveLength(1);
    });

    it("should return empty array for nonexistent directory", () => {
      const dir = path.join(freshDir(), "nope");
      expect(listSessions(dir)).toEqual([]);
    });
  });

  // =================================================================
  // resolveLatestSession
  // =================================================================

  describe("resolveLatestSession", () => {
    it("should return the newest session", () => {
      const dir = freshDir();

      writeSnapshot(
        dir,
        minimalSessionJson({ savedAt: "2026-03-29T08:00:00.000Z" }),
      );
      writeSnapshot(
        dir,
        minimalSessionJson({
          savedAt: "2026-03-29T12:00:00.000Z",
          modelKey: "latest-model",
        }),
      );

      const latest = resolveLatestSession(dir);
      expect(latest).not.toBeNull();
      expect(latest!.modelKey).toBe("latest-model");
    });

    it("should return null when no sessions exist", () => {
      const dir = freshDir();
      expect(resolveLatestSession(dir)).toBeNull();
    });
  });

  // =================================================================
  // resolveSessionById
  // =================================================================

  describe("resolveSessionById", () => {
    it("should find a session by its ID", () => {
      const dir = freshDir();

      const entry = writeSnapshot(dir, minimalSessionJson());
      const found = resolveSessionById(dir, entry.sessionId);

      expect(found).not.toBeNull();
      expect(found!.sessionId).toBe(entry.sessionId);
      expect(found!.snapshotFile).toBe(entry.snapshotFile);
    });

    it("should return null for unknown session ID", () => {
      const dir = freshDir();
      writeSnapshot(dir, minimalSessionJson());

      expect(resolveSessionById(dir, "nonexistent-id")).toBeNull();
    });
  });

  // =================================================================
  // Metadata extraction
  // =================================================================

  describe("metadata extraction", () => {
    it("should extract provider and model from snapshot", () => {
      const dir = freshDir();
      const entry = writeSnapshot(
        dir,
        minimalSessionJson({
          providerName: "openrouter",
          modelKey: "gpt-4o",
        }),
      );

      expect(entry.providerName).toBe("openrouter");
      expect(entry.modelKey).toBe("gpt-4o");
    });

    it("should extract savedAt from snapshot", () => {
      const dir = freshDir();
      const entry = writeSnapshot(
        dir,
        minimalSessionJson({ savedAt: "2026-03-29T15:30:00.000Z" }),
      );

      expect(entry.savedAt).toBe("2026-03-29T15:30:00.000Z");
    });

    it("should count turns from snapshot context", () => {
      const dir = freshDir();
      const entry = writeSnapshot(
        dir,
        minimalSessionJson({
          turns: [
            makeTurn("t1", "one"),
            makeTurn("t2", "two"),
            makeTurn("t3", "three"),
          ],
        }),
      );

      expect(entry.turnCount).toBe(3);
    });
  });
});

// ===================================================================
// Workspace resolution and session scoping
// ===================================================================

describe("workspace resolution", () => {
  describe("resolveWorkspaceRoot", () => {
    it("should resolve to the git root when inside a git repo", () => {
      const root = resolveWorkspaceRoot();
      expect(path.isAbsolute(root)).toBe(true);
      expect(fs.existsSync(path.join(root, ".git"))).toBe(true);
    });

    it("should fall back to cwd when not inside a git repo", () => {
      const nonGitDir = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "no-git-")),
      );
      const origCwd = process.cwd();
      try {
        process.chdir(nonGitDir);
        const root = resolveWorkspaceRoot();
        expect(root).toBe(nonGitDir);
      } finally {
        process.chdir(origCwd);
        fs.rmSync(nonGitDir, { recursive: true, force: true });
      }
    });
  });

  describe("hashWorkspace", () => {
    it("should return a hex SHA-256 hash of the input path", () => {
      const hash = hashWorkspace("/some/path");
      const expected = crypto
        .createHash("sha256")
        .update("/some/path")
        .digest("hex");
      expect(hash).toBe(expected);
    });

    it("should produce different hashes for different paths", () => {
      const a = hashWorkspace("/workspace/a");
      const b = hashWorkspace("/workspace/b");
      expect(a).not.toBe(b);
    });

    it("should produce the same hash for the same path", () => {
      const h1 = hashWorkspace("/same/path");
      const h2 = hashWorkspace("/same/path");
      expect(h1).toBe(h2);
    });
  });

  describe("getWorkspaceSessionsDir", () => {
    it("should return a path under ~/.propio/sessions/<hash>", () => {
      const dir = getWorkspaceSessionsDir("/my/project");
      const expectedHash = hashWorkspace("/my/project");
      expect(dir).toBe(
        path.join(os.homedir(), ".propio", "sessions", expectedHash),
      );
    });

    it("should auto-resolve workspace root when no argument given", () => {
      const dir = getWorkspaceSessionsDir();
      expect(dir).toContain(path.join(".propio", "sessions"));
      expect(path.isAbsolute(dir)).toBe(true);
    });

    it("should normalize a relative path to absolute before hashing", () => {
      const fromRelative = getWorkspaceSessionsDir(".");
      const fromAbsolute = getWorkspaceSessionsDir(path.resolve("."));
      expect(fromRelative).toBe(fromAbsolute);
    });

    it("should normalize paths with .. segments before hashing", () => {
      const base = path.resolve(".");
      const withDotDot = path.join(base, "sub", "..");
      expect(getWorkspaceSessionsDir(withDotDot)).toBe(
        getWorkspaceSessionsDir(base),
      );
    });
  });

  describe("getDefaultSessionsDir", () => {
    it("should return a path under ~/.propio/sessions", () => {
      const dir = getDefaultSessionsDir();
      expect(
        dir.startsWith(path.join(os.homedir(), ".propio", "sessions")),
      ).toBe(true);
      expect(path.isAbsolute(dir)).toBe(true);
    });
  });
});

describe("workspace isolation", () => {
  it("two different workspaces get different session directories", () => {
    const dirA = getWorkspaceSessionsDir("/workspace/alpha");
    const dirB = getWorkspaceSessionsDir("/workspace/beta");
    expect(dirA).not.toBe(dirB);
  });

  it("sessions saved in one workspace are not visible from another", () => {
    const dirA = path.join(freshDir(), "ws-a");
    const dirB = path.join(freshDir(), "ws-b");

    writeSnapshot(
      dirA,
      minimalSessionJson({
        savedAt: "2026-03-29T10:00:00.000Z",
        turns: [makeTurn("t1", "hello from A")],
      }),
    );

    const sessionsA = listSessions(dirA);
    const sessionsB = listSessions(dirB);

    expect(sessionsA).toHaveLength(1);
    expect(sessionsB).toHaveLength(0);
  });

  it("subdirectories of the same git repo share one session history via git root", () => {
    const gitRoot = resolveWorkspaceRoot();
    const sub = path.join(gitRoot, "src");

    let rootFromSub: string;
    const origCwd = process.cwd();
    try {
      process.chdir(sub);
      rootFromSub = resolveWorkspaceRoot();
    } finally {
      process.chdir(origCwd);
    }

    expect(rootFromSub).toBe(gitRoot);
    expect(getWorkspaceSessionsDir(rootFromSub)).toBe(
      getWorkspaceSessionsDir(gitRoot),
    );
  });
});
