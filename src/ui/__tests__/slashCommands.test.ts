import {
  buildSlashCommandHelpLines,
  getBashFooterText,
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

  it("includes all available commands and shortcuts", () => {
    const lines = buildSlashCommandHelpLines();
    const text = lines.map((line) => line.text).join("\n");

    expect(text).toContain("Available commands");
    expect(text).toContain("Keyboard shortcuts");
    expect(text).toContain("Enter");
    expect(text).toContain("! <command>");
    expect(text).toContain("Ctrl+J");
    expect(text).toContain("Shift+Tab");
    expect(text).not.toContain("Alt+Enter");
    expect(text).toContain("Ctrl+O");
    expect(text).toContain("toggle tool output");
    expect(text).toContain("Ctrl+T");
    expect(text).toContain("toggle thinking output");
    expect(text).toContain("Ctrl+X Ctrl+E");
    expect(text).toContain("Ctrl+X Ctrl+E    - open the editor");
    expect(text).toContain("/help");
    expect(text).toContain("/model");
    expect(text).toContain("?");
    expect(text).toContain("/tools");
    expect(text).toContain("/mcp");
    expect(text).toContain("/context");
    expect(text).toContain("/session list");
    expect(text).toContain("/session load <id>");
    expect(text).toContain("/plan save [content]");
    expect(text).toContain("/plan approve [content]");
    expect(text).toContain("/plan show");
  });

  it("keeps the idle footer concise", () => {
    expect(getIdleFooterText()).toBe(
      "Enter to send | ? help | mode: execute | tools: shown | thinking: shown",
    );
    expect(getIdleFooterText(false)).toBe(
      "Enter to send | ? help | mode: execute | tools: hidden | thinking: shown",
    );
    expect(
      getIdleFooterText({ showToolCalls: false, showThinking: true }),
    ).toBe(
      "Enter to send | ? help | mode: execute | tools: hidden | thinking: shown",
    );
  });

  it("keeps the bash footer concise", () => {
    expect(getBashFooterText()).toBe(
      "Enter to run | mode: execute | tools: shown | thinking: shown",
    );
    expect(getBashFooterText(false)).toBe(
      "Enter to run | mode: execute | tools: hidden | thinking: shown",
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
