import type { Capability, ToolMetadata } from "./capabilities.js";
import type { PolicyTarget } from "./rules.js";

/**
 * The default for a call no rule matched. This is separate from the agent's
 * own modes (such as plan or discover), which policy knows nothing about.
 */
export const PERMISSION_MODES = ["ask", "accept-edits", "bypass"] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

export function isPermissionMode(value: unknown): value is PermissionMode {
  return (
    typeof value === "string" &&
    (PERMISSION_MODES as readonly string[]).includes(value)
  );
}

export interface ModeDefault {
  readonly outcome: "allow" | "ask";
  readonly reason: string;
}

const ALWAYS_ASK: readonly Capability[] = ["process", "network", "external"];

/** Whether an absolute, normalized path is the workspace root or inside it. */
export function isInsideWorkspace(
  path: string,
  workspaceRoot: string,
): boolean {
  const root =
    workspaceRoot.length > 1 && workspaceRoot.endsWith("/")
      ? workspaceRoot.slice(0, -1)
      : workspaceRoot;
  if (path === root) return true;
  return path.startsWith(root === "/" ? "/" : `${root}/`);
}

export function modeDefault(
  mode: PermissionMode,
  metadata: ToolMetadata,
  target: PolicyTarget | undefined,
  workspaceRoot: string,
): ModeDefault {
  if (mode === "bypass") {
    return { outcome: "allow", reason: "Bypass mode allows every call" };
  }
  const capabilities = metadata.capabilities;
  const risky = capabilities.find((capability) =>
    ALWAYS_ASK.includes(capability),
  );
  if (risky) {
    return {
      outcome: "ask",
      reason: `Calls with the ${risky} capability need approval in ${mode} mode`,
    };
  }
  if (capabilities.length === 0) {
    return { outcome: "ask", reason: "The tool declares no capabilities" };
  }
  const outside =
    target?.kind === "path" && !isInsideWorkspace(target.path, workspaceRoot);
  if (outside) {
    return { outcome: "ask", reason: "The path is outside the workspace" };
  }
  if (capabilities.includes("workspace_write")) {
    // A write with no path to check is never assumed to be in the workspace.
    return mode === "accept-edits" && target?.kind === "path"
      ? {
          outcome: "allow",
          reason: "Accept-edits mode allows writes inside the workspace",
        }
      : {
          outcome: "ask",
          reason: `Workspace writes need approval in ${mode} mode`,
        };
  }
  return { outcome: "allow", reason: "Reads inside the workspace are allowed" };
}
