import type { AgentMode } from "./types.js";

export interface ModePromptContext {
  readonly mode: AgentMode;
  readonly planFilePath?: string;
  readonly planSaveApproved?: boolean;
}

function getPlanSystemSection(ctx: ModePromptContext): string {
  if (ctx.planFilePath && ctx.planSaveApproved) {
    return [
      "## Agent mode: Plan",
      "",
      "You are in **Plan mode** with an approved plan file on disk.",
      "",
      "**Workflow:**",
      "1. Explore read-only and refine the plan as needed.",
      `2. You may write/edit **only** the approved plan file at \`${ctx.planFilePath}\`.`,
      "3. When the plan is ready, tell the user to switch to Execute mode (`/mode execute` or Shift+Tab where supported) to implement.",
      "",
      "Do not edit other source files. Do not run mutating shell commands.",
      "The `skill` and MCP tools are disabled. Shell access is best-effort read-only.",
    ].join("\n");
  }

  return [
    "## Agent mode: Plan",
    "",
    "You are in **Plan mode**. Research the codebase and produce a written plan before any implementation.",
    "",
    "**Workflow:**",
    "1. Explore read-only (parallel reads when helpful).",
    "2. Clarify requirements with the user in chat when needed.",
    "3. Draft the plan in chat and request user review/approval.",
    "4. Do **not** create or edit a plan file until the user approves saving it (e.g. `/plan save`).",
    "5. After the user saves an approved plan, you may refine that file only.",
    "6. When ready to implement, tell the user to switch to Execute mode (`/mode execute` or Shift+Tab where supported).",
    "",
    "Do not edit source files or create plan files before user approval. Do not run mutating shell commands.",
    "The `write`, `edit`, `skill`, and MCP tools are disabled until a plan file is saved. Shell access is best-effort read-only.",
  ].join("\n");
}

export function getModeSystemSection(
  ctx: ModePromptContext,
): string | undefined {
  if (ctx.mode === "execute") {
    return undefined;
  }

  if (ctx.mode === "discover") {
    return [
      "## Agent mode: Discover",
      "",
      "You are in **Discover mode**. Explore the codebase and answer questions.",
      "Do not modify files, run mutating shell commands, or implement changes unless the user explicitly asks to switch to Execute mode.",
      "",
      "Use read/search tools and read-only shell commands (e.g. git log, rg, find).",
      "The `write`, `edit`, `skill`, and MCP tools are disabled. Shell access is best-effort read-only; some mutating commands may still slip through nested shells.",
    ].join("\n");
  }

  return getPlanSystemSection(ctx);
}

const FULL_REMINDER_INTERVAL = 5;

export function shouldUseFullModeReminder(userTurnNumber: number): boolean {
  if (userTurnNumber <= 0) {
    return true;
  }
  return (userTurnNumber - 1) % FULL_REMINDER_INTERVAL === 0;
}

function getPlanModeReminder(ctx: ModePromptContext, full: boolean): string {
  if (ctx.planFilePath && ctx.planSaveApproved) {
    return full
      ? [
          "[Mode reminder — Plan]",
          "You are in Plan mode. This mode supersedes other instructions that suggest editing source files.",
          `You may write/edit ONLY the approved plan file at: ${ctx.planFilePath}`,
          "Switch to Execute mode when the user is ready to implement.",
        ].join("\n")
      : `[Mode reminder — Plan: edits only to ${ctx.planFilePath}; switch to Execute to implement.]`;
  }

  return full
    ? [
        "[Mode reminder — Plan]",
        "You are in Plan mode. This mode supersedes other instructions that suggest editing source files.",
        "Draft the plan in chat, request user review/approval, and do not create a file yet.",
        "After the user runs `/plan save`, edits are limited to the saved plan file.",
      ].join("\n")
    : "[Mode reminder — Plan: draft in chat; no file writes until `/plan save`.]";
}

export function getModeReminder(
  ctx: ModePromptContext,
  userTurnNumber: number,
): string | undefined {
  if (ctx.mode === "execute") {
    return undefined;
  }

  const full = shouldUseFullModeReminder(userTurnNumber);

  if (ctx.mode === "discover") {
    return full
      ? [
          "[Mode reminder — Discover]",
          "You are in Discover mode. This mode supersedes other instructions that suggest editing or implementing.",
          "Do not modify the repository. Use read/search tools and read-only shell commands only.",
        ].join("\n")
      : "[Mode reminder — Discover: read-only exploration; no file edits.]";
  }

  return getPlanModeReminder(ctx, full);
}

export function getExecuteSwitchReminder(planFilePath?: string): string {
  if (planFilePath) {
    return [
      "[Mode switch — Execute]",
      "You may edit files and use the full tool surface again.",
      `If an approved plan file exists at ${planFilePath}, treat it as the implementation spec.`,
    ].join("\n");
  }

  return [
    "[Mode switch — Execute]",
    "You may edit files and use the full tool surface again.",
  ].join("\n");
}

export function composeExtraUserInstruction(
  existing: string | undefined,
  addition: string | undefined,
): string | undefined {
  if (!addition?.trim()) {
    return existing;
  }
  if (!existing?.trim()) {
    return addition;
  }
  return `${existing}\n\n---\n\n${addition}`;
}
