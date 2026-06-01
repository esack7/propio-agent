import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it } from "@jest/globals";
import {
  allocatePlanFile,
  extractProposedPlanContent,
  isPlanFilePath,
  writePlanFile,
} from "../planFile.js";
import { createTempDirTracker } from "../../__tests__/tempDirs.js";

describe("planFile", () => {
  const { makeTempDir, cleanupTempDirs } = createTempDirTracker();

  afterEach(() => {
    cleanupTempDirs();
  });

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

  it("extracts the latest proposed plan block from assistant text", () => {
    const content = [
      "Acknowledgement text.",
      "<proposed_plan>",
      "# Draft one",
      "</proposed_plan>",
      "More text.",
      "<proposed_plan>",
      "# Draft two",
      "",
      "Step 1",
      "</proposed_plan>",
    ].join("\n");

    expect(extractProposedPlanContent(content)).toBe("# Draft two\n\nStep 1");
    expect(
      extractProposedPlanContent("Plain acknowledgement only"),
    ).toBeUndefined();
  });
});
