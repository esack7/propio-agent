import type { SkillInvocationScope } from "../skills/types.js";
import type { AgentMode } from "./types.js";

export const DISCOVER_MODE_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "bash",
] as const;

export const PLAN_MODE_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "write",
  "edit",
] as const;

export interface ResolveEffectiveToolAllowlistInput {
  readonly mode: AgentMode;
  readonly skillScopes: ReadonlyArray<SkillInvocationScope>;
  readonly enabledBuiltinNames: readonly string[];
  readonly connectedMcpToolNames: readonly string[];
  readonly planFilePath?: string;
  readonly planSaveApproved?: boolean;
}

function intersectSets(
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
): ReadonlySet<string> {
  return new Set([...a].filter((name) => b.has(name)));
}

function intersectWithEnabledBaselines(
  baseline: readonly string[],
  enabledBuiltinNames: readonly string[],
): ReadonlySet<string> {
  const enabled = new Set(enabledBuiltinNames);
  return new Set(baseline.filter((name) => enabled.has(name)));
}

function resolveExecuteAllowlist(
  skillScopes: ReadonlyArray<SkillInvocationScope>,
  enabledSurface: ReadonlySet<string>,
): ReadonlySet<string> | undefined {
  const scopedLists = skillScopes
    .map((scope) => scope.allowedTools)
    .filter(
      (allowedTools): allowedTools is readonly string[] =>
        Array.isArray(allowedTools) && allowedTools.length > 0,
    );

  if (scopedLists.length === 0) {
    return undefined;
  }

  let allowed = new Set(scopedLists[0]);
  for (const list of scopedLists.slice(1)) {
    allowed = new Set([...allowed].filter((tool) => list.includes(tool)));
  }

  return intersectSets(allowed, enabledSurface);
}

function resolvePlanBaseline(
  input: ResolveEffectiveToolAllowlistInput,
): readonly string[] {
  if (input.planFilePath && input.planSaveApproved) {
    return PLAN_MODE_TOOLS;
  }
  return DISCOVER_MODE_TOOLS;
}

export function resolveEffectiveToolAllowlist(
  input: ResolveEffectiveToolAllowlistInput,
): ReadonlySet<string> | undefined {
  const enabledSurface = new Set([
    ...input.enabledBuiltinNames,
    ...input.connectedMcpToolNames,
  ]);

  if (input.mode === "execute") {
    return resolveExecuteAllowlist(input.skillScopes, enabledSurface);
  }

  const baseline =
    input.mode === "plan" ? resolvePlanBaseline(input) : DISCOVER_MODE_TOOLS;
  return intersectWithEnabledBaselines(baseline, input.enabledBuiltinNames);
}

/**
 * Forward-compatibility hook for subagent tool inheritance when the task tool lands.
 */
// fallow-ignore-next-line unused-export
export function getSubagentToolAllowlist(
  parentMode: AgentMode,
  profileAllowedTools: ReadonlySet<string>,
  parentPlanState?: {
    readonly planFilePath?: string;
    readonly planSaveApproved?: boolean;
  },
): ReadonlySet<string> {
  if (parentMode === "execute") {
    return profileAllowedTools;
  }

  const parentBaseline =
    parentMode === "plan"
      ? resolvePlanBaseline({
          mode: "plan",
          skillScopes: [],
          enabledBuiltinNames: [],
          connectedMcpToolNames: [],
          planFilePath: parentPlanState?.planFilePath,
          planSaveApproved: parentPlanState?.planSaveApproved,
        })
      : DISCOVER_MODE_TOOLS;
  const baseline = new Set<string>(parentBaseline);
  return intersectSets(profileAllowedTools, baseline);
}
