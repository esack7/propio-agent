/** Propio CLI discovery conventions. Keep these outside the public skills entry point. */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loadSkills } from "./index.js";
import { extractFrontmatterText } from "./parser.js";
import type { LoadLocalSkillsResult, SkillContext } from "./types.js";

export function readFrontmatterText(skillFile: string): string | null {
  return extractFrontmatterText(fs.readFileSync(skillFile, "utf8"));
}

export function loadLocalSkills(
  options: Partial<SkillContext> = {},
): LoadLocalSkillsResult {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const homeDir = path.resolve(options.homeDir ?? os.homedir());
  return loadSkills({
    workspaceRoot: cwd,
    roots: [
      { source: "project", skillRoot: path.join(cwd, ".propio", "skills") },
      { source: "user", skillRoot: path.join(homeDir, ".propio", "skills") },
    ],
  });
}
