import type { SystemPromptContext } from "./systemPromptContext.js";

export const DEFAULT_CORE_IDENTITY = `You are a helpful AI coding assistant with access to tools. Use the tools available to you to complete user requests effectively.

When you need to perform actions like reading files, searching code, or executing commands, use the appropriate tool by making a function call. You will receive the tool results and can use that information to continue helping the user.

For exploratory questions, analysis requests, or requests that ask whether something is possible, inspect and explain without changing files. Do not write, edit, delete, rename, or otherwise modify files unless the user explicitly asks you to implement, fix, update, create, remove, or change something, or they confirm a proposed plan.

Always provide clear, concise responses and summarize what you did after completing the user's request.`;

export function getCoreIdentitySection(baseRules: string): string {
  return `# Core Identity and Operational Rules\n\n${baseRules.trim()}`;
}

export function getAgentsMdSection(agentsMdContent: string): string {
  return `# Project Instructions (AGENTS.md)\n\n${agentsMdContent.trim()}`;
}

export function getToolUtilizationSection(): string {
  return `# Tool Utilization

Use tools when they materially help complete the request. Prefer the smallest set of tool calls needed to gather evidence or make a change.

Detailed parameters, constraints, and per-tool behavior live in each tool's schema description. Follow those schemas when choosing arguments.

Do not assume a tool is available unless it appears in the runtime environment's enabled tools list.`;
}

export function getResponseFormattingSection(): string {
  return `# Response Formatting

When formatting responses, avoid Markdown tables. Use bullet lists, numbered lists, or plain prose instead.

Keep summaries concise after completing work.`;
}

export type RuntimeToolListMode = "full" | "summary" | "omit";

function formatGitState(ctx: SystemPromptContext): string {
  if (ctx.gitBranch === undefined) {
    return "- Git: not available or not a repository";
  }

  const dirty =
    ctx.isGitDirty === true
      ? "dirty"
      : ctx.isGitDirty === false
        ? "clean"
        : "unknown";
  return `- Git branch: ${ctx.gitBranch} (${dirty})`;
}

function formatEnabledTools(ctx: SystemPromptContext): string {
  if (ctx.enabledToolNames.length === 0) {
    return "- Enabled tools: (none)";
  }

  return `- Enabled tools: ${ctx.enabledToolNames.slice().sort().join(", ")}`;
}

function formatEnabledToolSummary(ctx: SystemPromptContext): string {
  if (ctx.enabledToolNames.length === 0) {
    return "- Enabled tools: (none)";
  }

  return `- Enabled tools: ${ctx.enabledToolNames.length} tools (full list in overflow block below)`;
}

function formatToolLine(
  ctx: SystemPromptContext,
  mode: RuntimeToolListMode,
): string | null {
  if (mode === "omit") {
    return null;
  }

  return mode === "summary"
    ? formatEnabledToolSummary(ctx)
    : formatEnabledTools(ctx);
}

export function formatRuntimeEnvironmentSection(
  ctx: SystemPromptContext,
  opts?: {
    includeGitDetails?: boolean;
    toolListMode?: RuntimeToolListMode;
  },
): string {
  const includeGit = opts?.includeGitDetails !== false;
  const toolListMode = opts?.toolListMode ?? "full";
  const lines = [
    "# Runtime Environment",
    "",
    `- OS: ${ctx.os}`,
    `- Working directory: ${ctx.cwd}`,
    `- Date and time: ${ctx.dateTime}`,
    `- Node.js: ${ctx.nodeVersion}`,
    `- Shell: ${ctx.shell}`,
  ];

  if (includeGit) {
    lines.push(formatGitState(ctx));
  }

  const toolLine = formatToolLine(ctx, toolListMode);
  if (toolLine) {
    lines.push(toolLine);
  }

  return lines.join("\n");
}

export function formatRuntimeOverflowBlock(ctx: SystemPromptContext): string {
  const lines = ["# Runtime Context (overflow)", ""];
  lines.push(formatGitState(ctx));
  lines.push(`- Working directory: ${ctx.cwd}`);
  lines.push(`- Date and time: ${ctx.dateTime}`);
  lines.push(formatEnabledTools(ctx));
  return lines.join("\n");
}
