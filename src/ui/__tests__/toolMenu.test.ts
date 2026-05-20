import { showToolMenu } from "../toolMenu.js";
import { createMockMenuUi, MockPromptComposer } from "./menuTestHelpers.js";

class MockAgent {
  private tools = new Map([
    [
      "read",
      {
        name: "read",
        description: "Read a text file.",
        enabled: true,
        enabledByDefault: true,
      },
    ],
    [
      "write",
      {
        name: "write",
        description: "Write a file atomically.",
        enabled: true,
        enabledByDefault: true,
      },
    ],
    [
      "edit",
      {
        name: "edit",
        description: "Edit a file - replace text.",
        enabled: true,
        enabledByDefault: true,
      },
    ],
    [
      "bash",
      {
        name: "bash",
        description: "Run a shell command.",
        enabled: true,
        enabledByDefault: true,
      },
    ],
    [
      "grep",
      {
        name: "grep",
        description: "Search file contents recursively.",
        enabled: false,
        enabledByDefault: false,
      },
    ],
    [
      "find",
      {
        name: "find",
        description: "Find files by name or glob.",
        enabled: false,
        enabledByDefault: false,
      },
    ],
    [
      "ls",
      {
        name: "ls",
        description: "List directory contents.",
        enabled: false,
        enabledByDefault: false,
      },
    ],
  ]);

  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  getToolSummaries() {
    return Array.from(this.tools.values());
  }

  isToolEnabled(name: string): boolean {
    return this.tools.get(name)?.enabled || false;
  }

  enableTool(name: string): void {
    if (this.tools.has(name)) {
      const tool = this.tools.get(name)!;
      this.tools.set(name, { ...tool, enabled: true });
    }
  }

  disableTool(name: string): void {
    if (this.tools.has(name)) {
      const tool = this.tools.get(name)!;
      this.tools.set(name, { ...tool, enabled: false });
    }
  }

  enableAllTools(): void {
    for (const [name, tool] of this.tools) {
      this.tools.set(name, { ...tool, enabled: true });
    }
  }

  disableAllTools(): void {
    for (const [name, tool] of this.tools) {
      this.tools.set(name, { ...tool, enabled: false });
    }
  }

  resetToolsToManifestDefaults(): void {
    for (const [name, tool] of this.tools) {
      this.tools.set(name, { ...tool, enabled: tool.enabledByDefault });
    }
  }
}

describe("showToolMenu", () => {
  let mockAgent: MockAgent;
  let outputLines: string[];
  let mockUi: {
    command: (text: string) => void;
    error: (text: string) => void;
    info: (text: string) => void;
    prompt: (text: string) => string;
    section: (text: string) => void;
    success: (text: string) => void;
  };

  beforeEach(() => {
    mockAgent = new MockAgent();
    outputLines = [];
    mockUi = createMockMenuUi(outputLines);
  });

  async function renderToolMenu(
    responses: Array<string | null>,
    agent: MockAgent = mockAgent,
  ): Promise<MockPromptComposer> {
    const input = new MockPromptComposer(responses);
    await showToolMenu(input, agent as any, mockUi as any);
    return input;
  }

  it("shows the seven built-in tools in order", async () => {
    await renderToolMenu([null]);

    const output = outputLines.join("\n");
    expect(output).toContain("read");
    expect(output).toContain("write");
    expect(output).toContain("edit");
    expect(output).toContain("bash");
    expect(output).toContain("grep");
    expect(output).toContain("find");
    expect(output).toContain("ls");
    expect(output).toContain("Tools");
  });

  it("numbers tools from 1 to 7", async () => {
    await renderToolMenu([null]);

    const output = outputLines.join("\n");
    expect(output).toContain("1.");
    expect(output).toContain("7.");
  });

  it("shows enabled tools before disabled tools with descriptions", async () => {
    const input = new MockPromptComposer([null]);

    await showToolMenu(input, mockAgent as any, mockUi as any);

    const output = outputLines.join("\n");
    expect(output.indexOf("read")).toBeLessThan(output.indexOf("grep"));
    expect(output).toContain("Read a text file.");
    expect(output).toContain("Search file contents recursively.");
  });

  it("disables enabled tools without confirmation", async () => {
    const input = new MockPromptComposer(["1", ""]);

    await showToolMenu(input, mockAgent as any, mockUi as any);

    expect(mockAgent.isToolEnabled("read")).toBe(false);
    expect(outputLines.join("\n")).toContain("Disabled tool: read");
  });

  it("enables disabled non-dangerous tools without confirmation", async () => {
    const customAgent = new MockAgent();
    customAgent.disableTool("grep");
    const input = new MockPromptComposer(["5", ""]);

    await showToolMenu(input, customAgent as any, mockUi as any);

    expect(customAgent.isToolEnabled("grep")).toBe(true);
    expect(outputLines.join("\n")).toContain("Enabled tool: grep");
  });

  it("enables bash immediately when it is disabled", async () => {
    const input = new MockPromptComposer(["4", ""]);

    mockAgent.disableTool("bash");
    await showToolMenu(input, mockAgent as any, mockUi as any);

    expect(mockAgent.isToolEnabled("bash")).toBe(true);
    expect(outputLines.join("\n")).toContain("Enabled tool: bash");
  });

  it("reprompts after invalid input", async () => {
    const input = new MockPromptComposer(["abc", ""]);

    await showToolMenu(input, mockAgent as any, mockUi as any);

    const output = outputLines.join("\n");
    expect(output).toContain(
      "Invalid input. Please enter a valid tool number.",
    );
    expect(input.prompts.length).toBeGreaterThanOrEqual(2);
  });

  it("exits on blank input", async () => {
    const input = new MockPromptComposer([""]);

    await showToolMenu(input, mockAgent as any, mockUi as any);

    expect(outputLines.join("\n")).not.toContain("Invalid input.");
  });

  it("supports bulk enable, disable, and defaults actions", async () => {
    const input = new MockPromptComposer(["all off", "all on", "defaults", ""]);

    await showToolMenu(input, mockAgent as any, mockUi as any);

    expect(mockAgent.isToolEnabled("read")).toBe(true);
    expect(mockAgent.isToolEnabled("write")).toBe(true);
    expect(mockAgent.isToolEnabled("grep")).toBe(false);
    expect(outputLines.join("\n")).toContain("Disabled all tools.");
    expect(outputLines.join("\n")).toContain("Enabled all tools.");
    expect(outputLines.join("\n")).toContain("Restored manifest defaults.");
  });
});
