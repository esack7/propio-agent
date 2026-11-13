import * as fs from "fs";
import * as path from "path";
import type { PolicyTarget } from "../policy/index.js";
import { normalizeMcpNameSegment } from "../mcp/toolName.js";

/** Built-in tools that act on the file named by their `path` argument. */
const PATH_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "write",
  "edit",
  "grep",
  "find",
  "ls",
]);

export interface PolicyTargetContext {
  /** Absolute, with symbolic links resolved. */
  readonly workspaceRoot: string;
  /** Resolves a raw path argument the way the tool itself will. */
  readonly resolvePath: (rawPath: unknown) => string;
  /** Set for an MCP tool: the configured name of its server. */
  readonly mcpServerName?: string;
}

/**
 * Follow symbolic links, including for a path that does not exist yet: the
 * deepest existing ancestor is resolved and the rest is appended, so a new
 * file under a linked directory is judged by where it will really be written.
 */
export function resolveSymbolicLinks(absolutePath: string): string {
  const missing: string[] = [];
  let current = absolutePath;
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...missing.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      // A link whose destination is missing must not be read as a plain new
      // file: writing through it would land wherever it points.
      if (isSymbolicLink(current)) {
        throw new Error(
          `Cannot resolve ${current}: it is a symbolic link to a missing path`,
        );
      }
      const parent = path.dirname(current);
      if (parent === current) return absolutePath;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

function isSymbolicLink(candidate: string): boolean {
  try {
    return fs.lstatSync(candidate).isSymbolicLink();
  } catch {
    return false;
  }
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function hasEnvironmentOverrides(env: unknown): boolean {
  return env !== null && typeof env === "object" && Object.keys(env).length > 0;
}

function commandTarget(
  args: Readonly<Record<string, unknown>>,
  context: PolicyTargetContext,
): PolicyTarget {
  const command = typeof args.command === "string" ? args.command : "";
  const cwd =
    args.cwd === undefined
      ? context.workspaceRoot
      : resolveSymbolicLinks(context.resolvePath(args.cwd));
  // The command text says nothing about where it runs or with what
  // environment, so a rule that approved the text does not cover such a call.
  const detached =
    !isInside(cwd, context.workspaceRoot) || hasEnvironmentOverrides(args.env);
  return detached
    ? { kind: "command", command, detached: true }
    : { kind: "command", command };
}

/**
 * What a call acts on, for policy to match rules against. Throws when the
 * path cannot be resolved; the caller treats that as a refusal.
 */
export function resolvePolicyTarget(
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  context: PolicyTargetContext,
): PolicyTarget | undefined {
  if (context.mcpServerName !== undefined) {
    return {
      kind: "mcp",
      serverPrefix: `mcp__${normalizeMcpNameSegment(context.mcpServerName)}`,
    };
  }
  if (toolName === "bash") return commandTarget(args, context);
  if (PATH_TOOLS.has(toolName)) {
    return {
      kind: "path",
      path: resolveSymbolicLinks(context.resolvePath(args.path)),
    };
  }
  return undefined;
}
