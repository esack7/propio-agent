export interface SlashCommandLine {
  readonly text: string;
  readonly style: "info" | "subtle" | "section";
}

export interface SlashCommand {
  readonly command: string;
  readonly description: string;
}

export interface SlashCommandGroup {
  readonly name: string;
  readonly commands: ReadonlyArray<SlashCommand>;
}

export interface FooterVisibilityOptions {
  readonly showToolCalls: boolean;
  readonly showThinking: boolean;
  readonly agentMode?: "execute" | "plan" | "discover";
}

export const SLASH_COMMAND_GROUPS: ReadonlyArray<SlashCommandGroup> = [
  {
    name: "Chat",
    commands: [
      { command: "/help", description: "show this help menu" },
      { command: "?", description: "alias for /help" },
      { command: "/clear", description: "clear session context" },
      { command: "/skill <name>", description: "run an inline skill now" },
      { command: "/skills", description: "list loaded skills" },
      {
        command: "/model",
        description: "switch the active provider/model or update defaults",
      },
      {
        command: "/mode",
        description: "show or switch agent mode (execute, plan, discover)",
      },
      {
        command: "/mode execute",
        description: "switch to Execute mode (full tool access)",
      },
      {
        command: "/mode plan",
        description: "switch to Plan mode (plan file writes only)",
      },
      {
        command: "/mode discover",
        description: "switch to Discover mode (read-only exploration)",
      },
      {
        command: "/plan save [content]",
        description:
          "save the latest assistant plan draft, or explicit content (Plan mode only)",
      },
    ],
  },
  {
    name: "Context",
    commands: [
      {
        command: "/context",
        description: "show structured context overview",
      },
      { command: "/context prompt", description: "show latest prompt plan" },
      {
        command: "/context memory",
        description: "show pinned memory and rolling summary",
      },
    ],
  },
  {
    name: "Sessions",
    commands: [
      { command: "/session list", description: "list saved session snapshots" },
      {
        command: "/session load",
        description: "load the latest saved session",
      },
      {
        command: "/session load <id>",
        description: "load a specific saved session",
      },
      { command: "/exit", description: "save session snapshot and exit" },
    ],
  },
  {
    name: "Tools",
    commands: [{ command: "/tools", description: "manage enabled tools" }],
  },
  {
    name: "MCP",
    commands: [
      { command: "/mcp", description: "show MCP server status" },
      { command: "/mcp list", description: "list configured MCP servers" },
      { command: "/mcp get", description: "show one MCP server" },
      { command: "/mcp tools", description: "list discovered MCP tools" },
      { command: "/mcp reconnect", description: "reconnect one MCP server" },
      { command: "/mcp enable", description: "enable one MCP server" },
      { command: "/mcp disable", description: "disable one MCP server" },
    ],
  },
];

export function getSlashCommandCompletionCommands(): SlashCommand[] {
  return SLASH_COMMAND_GROUPS.flatMap((group) =>
    group.commands.filter(
      (command) => command.command !== "?" && !command.command.includes("<"),
    ),
  );
}

function formatCommandLine(command: SlashCommand): string {
  return formatLabelLine(command.command, command.description);
}

function formatLabelLine(label: string, description: string): string {
  return `  ${label.padEnd(16)} - ${description}`;
}

export function buildSlashCommandHelpLines(): SlashCommandLine[] {
  const lines: SlashCommandLine[] = [];

  lines.push({ text: "Available commands", style: "section" });
  for (const group of SLASH_COMMAND_GROUPS) {
    lines.push({ text: group.name, style: "section" });

    for (const command of group.commands) {
      lines.push({ text: formatCommandLine(command), style: "info" });
    }
  }

  lines.push({ text: "Keyboard shortcuts", style: "section" });
  lines.push({
    text: formatLabelLine("Enter", "send the current message"),
    style: "info",
  });
  lines.push({
    text: formatLabelLine("! <command>", "run one local shell command"),
    style: "info",
  });
  lines.push({
    text: formatLabelLine("Ctrl+J", "insert a newline"),
    style: "info",
  });
  lines.push({
    text: formatLabelLine("Shift+Tab", "cycle agent mode (best-effort)"),
    style: "info",
  });
  lines.push({
    text: formatLabelLine("Ctrl+O", "toggle tool output"),
    style: "info",
  });
  lines.push({
    text: formatLabelLine("Ctrl+T", "toggle thinking output"),
    style: "info",
  });
  lines.push({
    text: formatLabelLine("Ctrl+X Ctrl+E", "open the editor"),
    style: "info",
  });
  lines.push({
    text: formatLabelLine(
      "Esc",
      "cancel the active turn, or exit shell-command input",
    ),
    style: "info",
  });

  return lines;
}

export function getIdleFooterText(
  visibility: boolean | FooterVisibilityOptions = true,
): string {
  const showToolCalls =
    typeof visibility === "boolean" ? visibility : visibility.showToolCalls;
  const showThinking =
    typeof visibility === "boolean" ? true : visibility.showThinking;
  const agentMode =
    typeof visibility === "boolean"
      ? "execute"
      : (visibility.agentMode ?? "execute");
  const modeLabel =
    agentMode === "execute"
      ? "execute"
      : agentMode === "plan"
        ? "plan"
        : "discover";

  return `Enter to send | ? help | mode: ${modeLabel} | tools: ${
    showToolCalls ? "shown" : "hidden"
  } | thinking: ${showThinking ? "shown" : "hidden"}`;
}

export function getBashFooterText(
  visibility: boolean | FooterVisibilityOptions = true,
): string {
  const showToolCalls =
    typeof visibility === "boolean" ? visibility : visibility.showToolCalls;
  const showThinking =
    typeof visibility === "boolean" ? true : visibility.showThinking;
  const agentMode =
    typeof visibility === "boolean"
      ? "execute"
      : (visibility.agentMode ?? "execute");
  const modeLabel =
    agentMode === "execute"
      ? "execute"
      : agentMode === "plan"
        ? "plan"
        : "discover";

  return `Enter to run | mode: ${modeLabel} | tools: ${
    showToolCalls ? "shown" : "hidden"
  } | thinking: ${showThinking ? "shown" : "hidden"}`;
}

export function isHelpCommand(input: string): boolean {
  const normalized = input.trim().toLowerCase();
  return normalized === "/help" || normalized === "?";
}
