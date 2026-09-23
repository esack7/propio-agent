import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  writeIndex,
  writeRecoveryCheckpoint,
  type SessionIndex,
} from "../sessionHistory.js";
import { writeRecoveryJournalBase } from "../recoveryJournal.js";
import {
  listActiveInProgressSessionIds,
  pruneStaleSessionStorage,
} from "../sessionStoragePrune.js";

describe("sessionStoragePrune", () => {
  let sessionsDir: string;
  const retentionDays = 7;
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;

  beforeEach(() => {
    sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "propio-prune-"));
  });

  afterEach(() => {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  });

  function writeIndexEntries(entries: SessionIndex["entries"]): void {
    writeIndex(sessionsDir, { entries });
  }

  function makeStorageDir(
    tree: "artifacts" | "scratchpads",
    sessionId: string,
    mtimeMs: number,
  ): string {
    const dir = path.join(sessionsDir, tree, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "marker.txt"), "x");
    const past = new Date(mtimeMs);
    fs.utimesSync(dir, past, past);
    return dir;
  }

  function makeTraceJournal(sessionId: string, mtimeMs: number): string {
    const dir = path.join(sessionsDir, "traces", sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const journal = path.join(dir, "run-1.jsonl");
    fs.writeFileSync(journal, "{}\n");
    const past = new Date(mtimeMs);
    fs.utimesSync(journal, past, past);
    return journal;
  }

  it("prunes stale unanchored artifact dirs past retention", () => {
    const staleMtime = Date.now() - retentionMs - 1000;
    const staleDir = makeStorageDir("artifacts", "stale-artifact", staleMtime);
    const freshDir = makeStorageDir("artifacts", "fresh-artifact", Date.now());
    writeIndexEntries([]);

    pruneStaleSessionStorage(sessionsDir, retentionDays);

    expect(fs.existsSync(staleDir)).toBe(false);
    expect(fs.existsSync(freshDir)).toBe(true);
  });

  it("keeps anchored artifact dirs by runtimeSessionId", () => {
    const staleMtime = Date.now() - retentionMs - 1000;
    const anchoredDir = makeStorageDir(
      "artifacts",
      "runtime-anchored",
      staleMtime,
    );
    writeIndexEntries([
      {
        sessionId: "snapshot-id",
        runtimeSessionId: "runtime-anchored",
        snapshotFile: "runtime-anchored.json",
        savedAt: new Date().toISOString(),
        providerName: "p",
        modelKey: "m",
        turnCount: 0,
        hasRollingSummary: false,
      },
    ]);

    pruneStaleSessionStorage(sessionsDir, retentionDays);

    expect(fs.existsSync(anchoredDir)).toBe(true);
  });

  it("keeps artifacts anchored only by a recovery checkpoint", () => {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const staleDir = makeStorageDir(
      "artifacts",
      sessionId,
      Date.now() - retentionMs - 1000,
    );
    writeRecoveryCheckpoint(
      sessionsDir,
      JSON.stringify({
        version: 4,
        savedAt: new Date().toISOString(),
        metadata: { sessionId },
        context: { turns: [] },
      }),
    );

    pruneStaleSessionStorage(sessionsDir, retentionDays);

    expect(fs.existsSync(staleDir)).toBe(true);
  });

  it("expires an inactive checkpoint before pruning its artifacts", () => {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const staleMtime = Date.now() - retentionMs - 1000;
    const artifacts = makeStorageDir("artifacts", sessionId, staleMtime);
    writeRecoveryCheckpoint(
      sessionsDir,
      JSON.stringify({
        version: 4,
        savedAt: new Date(staleMtime).toISOString(),
        metadata: { sessionId },
        context: { turns: [] },
      }),
    );
    const checkpoint = path.join(sessionsDir, `recovery-${sessionId}.json`);
    fs.utimesSync(checkpoint, new Date(staleMtime), new Date(staleMtime));

    pruneStaleSessionStorage(sessionsDir, retentionDays);

    expect(fs.existsSync(checkpoint)).toBe(false);
    expect(fs.existsSync(artifacts)).toBe(false);
  });

  it("expires an inactive journal before pruning its artifacts", () => {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const staleMtime = Date.now() - retentionMs - 1000;
    const artifacts = makeStorageDir("artifacts", sessionId, staleMtime);
    writeRecoveryJournalBase(
      sessionsDir,
      JSON.stringify({
        version: 4,
        savedAt: new Date(staleMtime).toISOString(),
        metadata: {
          providerName: "fixture",
          modelKey: "fixture",
          systemPrompt: "",
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
          sessionId,
        },
        context: {
          preamble: [],
          turns: [],
          artifacts: [],
          pinnedMemory: [],
          invokedSkills: [],
        },
      }),
    );
    const journal = path.join(sessionsDir, `recovery-${sessionId}.jsonl`);
    fs.utimesSync(journal, new Date(staleMtime), new Date(staleMtime));

    pruneStaleSessionStorage(sessionsDir, retentionDays);

    expect(fs.existsSync(journal)).toBe(false);
    expect(fs.existsSync(artifacts)).toBe(false);
  });

  it("removes old interrupted temp files but leaves active ones alone", () => {
    const staleMtime = Date.now() - retentionMs - 1000;
    const inactiveId = "11111111-1111-4111-8111-111111111111";
    const activeId = "22222222-2222-4222-8222-222222222222";
    const staleTemp = path.join(
      sessionsDir,
      `recovery-${inactiveId}.jsonl.abcdef123456.tmp`,
    );
    const activeTemp = path.join(
      sessionsDir,
      `recovery-${activeId}.jsonl.abcdef123456.tmp`,
    );
    const activeCheckpoint = path.join(
      sessionsDir,
      `recovery-${activeId}.json`,
    );
    fs.writeFileSync(staleTemp, "private interrupted state");
    fs.writeFileSync(activeTemp, "active state");
    fs.writeFileSync(activeCheckpoint, "active checkpoint");
    fs.utimesSync(staleTemp, new Date(staleMtime), new Date(staleMtime));
    fs.utimesSync(activeTemp, new Date(staleMtime), new Date(staleMtime));
    fs.utimesSync(activeCheckpoint, new Date(staleMtime), new Date(staleMtime));
    fs.writeFileSync(
      path.join(sessionsDir, `inprogress-${activeId}.json`),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );

    pruneStaleSessionStorage(sessionsDir, retentionDays);

    expect(fs.existsSync(staleTemp)).toBe(false);
    expect(fs.existsSync(activeTemp)).toBe(true);
    expect(fs.existsSync(activeCheckpoint)).toBe(true);
  });

  it("keeps anchored scratchpad by legacy sessionId in index", () => {
    const staleMtime = Date.now() - retentionMs - 1000;
    const scratchDir = makeStorageDir(
      "scratchpads",
      "legacy-session-id",
      staleMtime,
    );
    writeIndexEntries([
      {
        sessionId: "legacy-session-id",
        runtimeSessionId: "different-runtime-id",
        snapshotFile: "legacy-session-id.json",
        savedAt: new Date().toISOString(),
        providerName: "p",
        modelKey: "m",
        turnCount: 0,
        hasRollingSummary: false,
      },
    ]);

    pruneStaleSessionStorage(sessionsDir, retentionDays);

    expect(fs.existsSync(scratchDir)).toBe(true);
  });

  it("prunes empty anchored scratchpads", () => {
    const scratchDir = path.join(sessionsDir, "scratchpads", "empty-anchored");
    fs.mkdirSync(scratchDir, { recursive: true });
    writeIndexEntries([
      {
        sessionId: "empty-anchored",
        runtimeSessionId: "empty-anchored",
        snapshotFile: "empty-anchored.json",
        savedAt: new Date().toISOString(),
        providerName: "p",
        modelKey: "m",
        turnCount: 0,
        hasRollingSummary: false,
      },
    ]);

    pruneStaleSessionStorage(sessionsDir, retentionDays);

    expect(fs.existsSync(scratchDir)).toBe(false);
  });

  it("does not delete scratchpad with live inprogress marker", () => {
    const staleMtime = Date.now() - retentionMs - 1000;
    const scratchDir = makeStorageDir(
      "scratchpads",
      "active-session",
      staleMtime,
    );
    writeIndexEntries([]);
    fs.writeFileSync(
      path.join(sessionsDir, "inprogress-active-session.json"),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );

    pruneStaleSessionStorage(sessionsDir, retentionDays);

    expect(fs.existsSync(scratchDir)).toBe(true);
  });

  it("prunes stale unanchored scratchpad past retention", () => {
    const staleMtime = Date.now() - retentionMs - 1000;
    const staleDir = makeStorageDir("scratchpads", "stale-scratch", staleMtime);
    writeIndexEntries([]);

    pruneStaleSessionStorage(sessionsDir, retentionDays);

    expect(fs.existsSync(staleDir)).toBe(false);
  });

  it("prunes stale trace journals even for anchored sessions", () => {
    const staleMtime = Date.now() - retentionMs - 1000;
    const journal = makeTraceJournal("anchored-trace", staleMtime);
    writeIndexEntries([
      {
        sessionId: "snapshot-id",
        runtimeSessionId: "anchored-trace",
        snapshotFile: "anchored-trace.json",
        savedAt: new Date().toISOString(),
        providerName: "p",
        modelKey: "m",
        turnCount: 0,
        hasRollingSummary: false,
      },
    ]);

    pruneStaleSessionStorage(sessionsDir, retentionDays);

    expect(fs.existsSync(journal)).toBe(false);
    expect(fs.existsSync(path.dirname(journal))).toBe(false);
  });

  it("keeps fresh trace journals", () => {
    const journal = makeTraceJournal("fresh-trace", Date.now());
    const materialDir = path.join(path.dirname(journal), "run-1.materials");
    fs.mkdirSync(materialDir);
    fs.writeFileSync(path.join(materialDir, "content.bin"), "captured");
    writeIndexEntries([]);

    pruneStaleSessionStorage(sessionsDir, retentionDays);

    expect(fs.existsSync(journal)).toBe(true);
    expect(fs.existsSync(materialDir)).toBe(true);
  });

  it("removes private material with an expired trace journal", () => {
    const staleMtime = Date.now() - retentionMs - 1000;
    const journal = makeTraceJournal("full-trace", staleMtime);
    const materialDir = path.join(path.dirname(journal), "run-1.materials");
    fs.mkdirSync(materialDir);
    fs.writeFileSync(path.join(materialDir, "content.bin"), "captured");
    writeIndexEntries([]);

    pruneStaleSessionStorage(sessionsDir, retentionDays);

    expect(fs.existsSync(journal)).toBe(false);
    expect(fs.existsSync(materialDir)).toBe(false);
  });

  it("keeps trace journals for live sessions", () => {
    const staleMtime = Date.now() - retentionMs - 1000;
    const journal = makeTraceJournal("active-trace", staleMtime);
    writeIndexEntries([]);
    fs.writeFileSync(
      path.join(sessionsDir, "inprogress-active-trace.json"),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );

    pruneStaleSessionStorage(sessionsDir, retentionDays);

    expect(fs.existsSync(journal)).toBe(true);
  });

  it("listActiveInProgressSessionIds uses process.kill(pid, 0)", () => {
    fs.writeFileSync(
      path.join(sessionsDir, "inprogress-live.json"),
      JSON.stringify({ pid: process.pid }),
    );
    fs.writeFileSync(
      path.join(sessionsDir, "inprogress-dead.json"),
      JSON.stringify({ pid: 999999999 }),
    );

    const active = listActiveInProgressSessionIds(sessionsDir);

    expect(active.has("live")).toBe(true);
    expect(active.has("dead")).toBe(false);
  });
});
