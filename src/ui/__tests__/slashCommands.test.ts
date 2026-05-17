import {
  buildSlashCommandHelpLines,
  getIdleFooterText,
  getSlashCommandCompletionCommands,
  isHelpCommand,
  SLASH_COMMAND_GROUPS,
} from "../slashCommands.js";

describe("slashCommands", () => {
  it("groups slash commands into chat, context, sessions, and tools", () => {
    expect(SLASH_COMMAND_GROUPS.map((group) => group.name)).toEqual([
      "Chat",
      "Context",
      "Sessions",
      "Tools",
      "MCP",
    ]);
  });

  it("includes a most useful commands section and a help alias", () => {
    const lines = buildSlashCommandHelpLines();
    const text = lines.map((line) => line.text).join("\n");

    expect(text).toContain("Most useful commands");
    expect(text).toContain("Chat shortcuts");
    expect(text).toContain("Ctrl+J");
    expect(text).not.toContain("Alt+Enter");
    expect(text).toContain("Ctrl+O");
    expect(text).toContain("toggle tool output");
    expect(text).toContain("Ctrl+X Ctrl+E");
    expect(text).toContain("Ctrl+X Ctrl+E    - open the editor");
    expect(text).toContain("/help");
    expect(text).toContain("/model");
    expect(text).toContain("?");
    expect(text).toContain("/tools");
    expect(text).toContain("/mcp");
    expect(text).toContain("/context");
    expect(text).toContain("/session list");
  });

  it("keeps the idle footer concise", () => {
    expect(getIdleFooterText()).toBe(
      "Enter to send | ? help | Ctrl+O tools: shown",
    );
    expect(getIdleFooterText(false)).toBe(
      "Enter to send | ? help | Ctrl+O tools: hidden",
    );
  });

  it("treats ? as a help alias", () => {
    expect(isHelpCommand("?")).toBe(true);
    expect(isHelpCommand("/help")).toBe(true);
    expect(isHelpCommand("/tools")).toBe(false);
  });

  it("exposes completion commands without aliases or placeholders", () => {
    const commands = getSlashCommandCompletionCommands().map(
      (command) => command.command,
    );

    expect(commands).toContain("/context");
    expect(commands).toContain("/model");
    expect(commands).toContain("/context prompt");
    expect(commands).toContain("/session load");
    expect(commands).not.toContain("?");
    expect(commands).not.toContain("/session load <id>");
  });
});
