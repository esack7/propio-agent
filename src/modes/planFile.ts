import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { normalizeToolPath } from "../tools/shared.js";

const PLANS_DIR_NAME = "plans";
const PROPIO_DIR = ".propio";
const PROPOSED_PLAN_BLOCK_PATTERN =
  "<proposed_plan>([\\s\\S]*?)</proposed_plan>";

function canonicalizePath(rawPath: string): string {
  const normalized = normalizeToolPath(rawPath);
  try {
    return fs.realpathSync.native(normalized);
  } catch {
    return path.resolve(normalized);
  }
}

function slugify(text: string, maxLength = 48): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength);
  return slug.length > 0 ? slug : "plan";
}

function formatTimestamp(iso: string): string {
  return iso.replace(/[:.]/g, "-");
}

function resolvePlansRoot(cwd: string, homeDir: string): string {
  try {
    const gitRoot = execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
    }).trim();
    if (gitRoot) {
      return path.join(path.resolve(gitRoot), PROPIO_DIR, PLANS_DIR_NAME);
    }
  } catch {
    // not in a git repo or git unavailable
  }

  return path.join(homeDir, PROPIO_DIR, PLANS_DIR_NAME);
}

function ensurePlanDirectoryExists(plansRoot: string): void {
  fs.mkdirSync(plansRoot, { recursive: true });
}

export function extractProposedPlanContent(
  content: string,
): string | undefined {
  if (typeof content !== "string") {
    return undefined;
  }

  const matches = [
    ...content.matchAll(new RegExp(PROPOSED_PLAN_BLOCK_PATTERN, "gi")),
  ];
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const proposedPlan = matches[index]?.[1]?.trim();
    if (proposedPlan) {
      return proposedPlan;
    }
  }

  return undefined;
}

export interface AllocatePlanFileInput {
  readonly sessionId: string;
  readonly cwd: string;
  readonly homeDir: string;
  readonly createdAt?: string;
  readonly slugHint?: string;
}

export function allocatePlanFile(input: AllocatePlanFileInput): string {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const plansRoot = resolvePlansRoot(input.cwd, input.homeDir);
  ensurePlanDirectoryExists(plansRoot);

  const slugSource =
    input.slugHint?.trim() ||
    input.sessionId.slice(0, 8) ||
    formatTimestamp(createdAt);
  const slug = slugify(slugSource);
  const fileName = `${formatTimestamp(createdAt)}-${slug}.md`;
  const planPath = path.resolve(plansRoot, fileName);
  return canonicalizePath(planPath);
}

export function writePlanFile(planFilePath: string, content: string): void {
  fs.mkdirSync(path.dirname(planFilePath), { recursive: true });
  fs.writeFileSync(planFilePath, content, "utf8");
}

export function isPlanFilePath(
  rawPath: unknown,
  planFilePath: string | undefined,
): boolean {
  if (typeof rawPath !== "string" || !planFilePath) {
    return false;
  }

  try {
    return canonicalizePath(rawPath) === canonicalizePath(planFilePath);
  } catch {
    return false;
  }
}
