import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  clearSandboxEnvForTest,
  restoreSandboxEnv,
} from "../../__tests__/envTestHelpers.js";
import {
  ensureDirectory0700,
  getSandboxScratchpadDir,
  getScratchpadDir,
  removeEmptyScratchpadDir,
  resolveScratchpadDir,
} from "../scratchpad.js";

describe("scratchpad", () => {
  let sessionsDir: string;
  let previousSandboxEnv: string | undefined;

  beforeEach(() => {
    sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "propio-scratchpad-"));
    previousSandboxEnv = clearSandboxEnvForTest();
  });

  afterEach(() => {
    restoreSandboxEnv(previousSandboxEnv);
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  });

  it("getScratchpadDir returns sessionsDir/scratchpads/sessionId", () => {
    expect(getScratchpadDir(sessionsDir, "abc-123")).toBe(
      path.join(sessionsDir, "scratchpads", "abc-123"),
    );
  });

  it("getSandboxScratchpadDir returns /tmp/propio-scratchpads/sessionId", () => {
    expect(getSandboxScratchpadDir("abc-123")).toBe(
      path.join("/tmp", "propio-scratchpads", "abc-123"),
    );
  });

  it("resolveScratchpadDir creates native dir with mode 0700", () => {
    const result = resolveScratchpadDir(sessionsDir, "sess-native");

    expect(result).toEqual({
      ok: true,
      path: path.resolve(sessionsDir, "scratchpads", "sess-native"),
    });
    if (result.ok) {
      expect(fs.statSync(result.path).mode & 0o777).toBe(0o700);
    }
  });

  it("resolveScratchpadDir routes to sandbox path when IS_SANDBOX", () => {
    process.env.IS_SANDBOX = "true";

    const result = resolveScratchpadDir(sessionsDir, "sess-sandbox");

    expect(result).toEqual({
      ok: true,
      path: path.resolve("/tmp", "propio-scratchpads", "sess-sandbox"),
    });
    if (result.ok) {
      expect(fs.statSync(result.path).mode & 0o777).toBe(0o700);
      fs.rmSync(result.path, { recursive: true, force: true });
    }
  });

  it("ensureDirectory0700 sets mode 0700 after mkdir", () => {
    const dir = path.join(sessionsDir, "mode-test");
    const resolved = ensureDirectory0700(dir);
    expect(resolved).toBe(path.resolve(dir));
    expect(fs.statSync(resolved).mode & 0o777).toBe(0o700);
  });

  it("removeEmptyScratchpadDir removes empty dirs", () => {
    const dir = path.join(sessionsDir, "scratchpads", "empty-session");
    fs.mkdirSync(dir, { recursive: true });

    removeEmptyScratchpadDir(dir);

    expect(fs.existsSync(dir)).toBe(false);
  });

  it("removeEmptyScratchpadDir keeps dirs with files", () => {
    const dir = path.join(sessionsDir, "scratchpads", "used-session");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "notes.txt"), "scratch");

    removeEmptyScratchpadDir(dir);

    expect(fs.existsSync(dir)).toBe(true);
  });

  it("resolveScratchpadDir rejects unsafe session ids without creating dirs", () => {
    const result = resolveScratchpadDir(sessionsDir, "../../escape");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorName).toBe("InvalidSessionId");
      expect(
        fs.existsSync(path.join(sessionsDir, "scratchpads", "../../escape")),
      ).toBe(false);
    }
  });

  it("resolveScratchpadDir returns ok:false when mkdir fails", () => {
    const target = getScratchpadDir(sessionsDir, "fail");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "blocks directory creation");

    const result = resolveScratchpadDir(sessionsDir, "fail");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.path).toBe(target);
      expect(result.errorName.length).toBeGreaterThan(0);
      expect(result.message.length).toBeGreaterThan(0);
    }
  });
});
