import { showToolMenu } from "../toolMenu.js";
import type {
  PromptComposer,
  PromptConfirmRequest,
  PromptRequest,
  PromptResult,
} from "../promptComposer.js";
import type { OverlayState } from "../replUi.js";

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

class MockPromptComposer implements PromptComposer {
  readonly prompts: string[] = [];

  constructor(private readonly responses: Array<string | null>) {}

  async compose({ promptText }: PromptRequest): Promise<PromptResult> {
    this.prompts.push(promptText);
    if (this.responses.length === 0) {
      return { status: "closed" };
    }
    const next = this.responses.shift();
    if (next === null || next === undefined) {
      return { status: "closed" };
    }
    return { status: "submitted", text: next };
  }

  async confirm(_request: PromptConfirmRequest): Promise<boolean> {
    throw new Error("confirm() is not used by the tool menu");
  }

  getCloseReason(): "closed" | "interrupted" | null {
    return null;
  }

  getState() {
    return null;
  }

  close(): void {}
}

describe("showToolMenu", () => {
  let mockAgent: MockAgent;
  let outputLines: string[];
  let closeOverlayCalls: number;
  let mockUi: {
    closeOverlay: () => void;
    command: (text: string) => void;
    error: (text: string) => void;
    info: (text: string) => void;
    openOverlay: (overlay: OverlayState) => void;
    prompt: (text: string) => string;
    success: (text: string) => void;
  };

  beforeEach(() => {
    mockAgent = new MockAgent();
    outputLines = [];
    closeOverlayCalls = 0;
    mockUi = {
      closeOverlay: () => {
        closeOverlayCalls += 1;
      },
      command: (text: string) => outputLines.push(text),
      error: (text: string) => outputLines.push(text),
      info: (text: string) => outputLines.push(text),
      openOverlay: (overlay: OverlayState) => {
        for (const entry of overlay.entries) {
          outputLines.push(entry.text);
        }
      },
      prompt: (text: string) => text,
      success: (text: string) => outputLines.push(text),
    };
  });

  it("shows the seven built-in tools in order", async () => {
    const input = new MockPromptComposer([null]);

    await showToolMenu(input, mockAgent as any, mockUi as any);

    const output = outputLines.join("\n");
    expect(output).toContain("read");
    expect(output).toContain("write");
    expect(output).toContain("edit");
    expect(output).toContain("bash");
    expect(output).toContain("grep");
    expect(output).toContain("find");
    expect(output).toContain("ls");
  });

  it("numbers tools from 1 to 7", async () => {
    const input = new MockPromptComposer([null]);

    await showToolMenu(input, mockAgent as any, mockUi as any);

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
    expect(closeOverlayCalls).toBe(1);
  });

  it("closes overlay when prompt composer closes", async () => {
    const input = new MockPromptComposer([null]);

    await showToolMenu(input, mockAgent as any, mockUi as any);

    expect(closeOverlayCalls).toBe(1);
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
