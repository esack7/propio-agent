import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "@jest/globals";
import {
  allocatePlanFile,
  isPlanFilePath,
  writePlanFile,
} from "../planFile.js";

describe("planFile", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  it("allocates a plan file under home when cwd is not a git repo", () => {
    const cwd = makeTempDir("plan-cwd-");
    const homeDir = makeTempDir("plan-home-");

    const planPath = allocatePlanFile({
      sessionId: "session-123",
      cwd,
      homeDir,
      slugHint: "add feature",
    });

    expect(planPath).toContain(`${path.sep}.propio${path.sep}plans${path.sep}`);
    writePlanFile(planPath, "# Plan\n");
    expect(fs.existsSync(planPath)).toBe(true);
  });

  it("matches relative and absolute plan paths after normalization", () => {
    const cwd = makeTempDir("plan-match-cwd-");
    const plansDir = path.join(cwd, ".propio", "plans");
    fs.mkdirSync(plansDir, { recursive: true });
    const planPath = path.join(plansDir, "plan.md");
    fs.writeFileSync(planPath, "# Plan\n", "utf8");

    const previousCwd = process.cwd();
    process.chdir(cwd);
    try {
      expect(isPlanFilePath(planPath, planPath)).toBe(true);
      expect(isPlanFilePath(".propio/plans/plan.md", planPath)).toBe(true);
      expect(isPlanFilePath("./src/foo.ts", planPath)).toBe(false);
    } finally {
      process.chdir(previousCwd);
    }
  });
});
