import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { writeIndex, type SessionIndex } from "../sessionHistory.js";
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
