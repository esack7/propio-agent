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

const FEATURED_COMMANDS: ReadonlyArray<string> = [
  "/help",
  "/skills",
  "/skill <name>",
  "/model",
  "/tools",
  "/mcp",
  "/context",
  "/session list",
  "/exit",
];

export function getSlashCommandCompletionCommands(): SlashCommand[] {
  return SLASH_COMMAND_GROUPS.flatMap((group) =>
    group.commands.filter(
      (command) => command.command !== "?" && !command.command.includes("<"),
    ),
  );
}

function findCommand(command: string): SlashCommand | undefined {
  for (const group of SLASH_COMMAND_GROUPS) {
    const match = group.commands.find((entry) => entry.command === command);
    if (match) {
      return match;
    }
  }

  return undefined;
}

function formatCommandLine(command: SlashCommand): string {
  return formatLabelLine(command.command, command.description);
}

function formatLabelLine(label: string, description: string): string {
  return `  ${label.padEnd(16)} - ${description}`;
}

export function buildSlashCommandHelpLines(): SlashCommandLine[] {
  const lines: SlashCommandLine[] = [];

  lines.push({ text: "Most useful commands", style: "section" });
  for (const command of FEATURED_COMMANDS) {
    const entry = findCommand(command);
    if (entry) {
      lines.push({ text: formatCommandLine(entry), style: "info" });
    }
  }

  lines.push({ text: "Chat shortcuts", style: "section" });
  lines.push({
    text: formatLabelLine("Ctrl+J", "insert a newline"),
    style: "info",
  });
  lines.push({
    text: formatLabelLine("Ctrl+O", "toggle tool output"),
    style: "info",
  });
  lines.push({
    text: formatLabelLine("Ctrl+X Ctrl+E", "open the editor"),
    style: "info",
  });

  for (const group of SLASH_COMMAND_GROUPS) {
    lines.push({ text: group.name, style: "section" });

    for (const command of group.commands) {
      lines.push({ text: formatCommandLine(command), style: "info" });
    }
  }

  return lines;
}

export function getIdleFooterText(showToolCalls = true): string {
  return `Enter to send | ? help | Ctrl+O tools: ${
    showToolCalls ? "shown" : "hidden"
  }`;
}

export function isHelpCommand(input: string): boolean {
  const normalized = input.trim().toLowerCase();
  return normalized === "/help" || normalized === "?";
}
