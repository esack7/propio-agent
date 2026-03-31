import * as readline from "readline";
import { showToolMenu } from "../toolMenu.js";

class MockAgent {
  private tools = new Map([
    ["read", true],
    ["write", true],
    ["edit", true],
    ["bash", true],
    ["grep", false],
    ["find", false],
    ["ls", false],
  ]);

  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  isToolEnabled(name: string): boolean {
    return this.tools.get(name) || false;
  }

  enableTool(name: string): void {
    if (this.tools.has(name)) {
      this.tools.set(name, true);
    }
  }

  disableTool(name: string): void {
    if (this.tools.has(name)) {
      this.tools.set(name, false);
    }
  }
}

class MockReadlineInterface {
  questionCallback: ((input: string) => void) | null = null;

  question(_prompt: string, callback: (input: string) => void): void {
    this.questionCallback = callback;
  }

  simulateInput(input: string): void {
    this.questionCallback?.(input);
  }

  close(): void {}
}

describe("showToolMenu", () => {
  let mockAgent: MockAgent;
  let mockRl: MockReadlineInterface;
  let outputLines: string[];
  let mockUi: {
    command: (text: string) => void;
    error: (text: string) => void;
    info: (text: string) => void;
    prompt: (text: string) => string;
    success: (text: string) => void;
  };

  beforeEach(() => {
    mockAgent = new MockAgent();
    mockRl = new MockReadlineInterface();
    outputLines = [];
    mockUi = {
      command: (text: string) => outputLines.push(text),
      error: (text: string) => outputLines.push(text),
      info: (text: string) => outputLines.push(text),
      prompt: (text: string) => text,
      success: (text: string) => outputLines.push(text),
    };
  });

  it("shows the seven built-in tools in order", () => {
    showToolMenu(mockRl as any, mockAgent as any, () => {}, mockUi as any);

    const output = outputLines.join("\n");
    expect(output).toContain("read");
    expect(output).toContain("write");
    expect(output).toContain("edit");
    expect(output).toContain("bash");
    expect(output).toContain("grep");
    expect(output).toContain("find");
    expect(output).toContain("ls");
  });

  it("numbers tools from 1 to 7", () => {
    showToolMenu(mockRl as any, mockAgent as any, () => {}, mockUi as any);

    const output = outputLines.join("\n");
    expect(output).toContain("1.");
    expect(output).toContain("7.");
  });

  it("disables enabled tools without confirmation", () => {
    let onDoneCalled = false;
    showToolMenu(
      mockRl as any,
      mockAgent as any,
      () => {
        onDoneCalled = true;
      },
      mockUi as any,
    );

    outputLines = [];
    mockRl.simulateInput("1");

    expect(mockAgent.isToolEnabled("read")).toBe(false);
    expect(outputLines.join("\n")).toContain("Disabled tool: read");
    expect(onDoneCalled).toBe(false);
  });

  it("enables disabled non-dangerous tools without confirmation", () => {
    const customAgent = new MockAgent();
    customAgent.disableTool("grep");

    showToolMenu(mockRl as any, customAgent as any, () => {}, mockUi as any);

    outputLines = [];
    mockRl.simulateInput("5");

    expect(customAgent.isToolEnabled("grep")).toBe(true);
    expect(outputLines.join("\n")).toContain("Enabled tool: grep");
  });

  it("enables bash immediately when it is disabled", () => {
    showToolMenu(mockRl as any, mockAgent as any, () => {}, mockUi as any);

    outputLines = [];
    mockAgent.disableTool("bash");
    mockRl.simulateInput("4");

    expect(mockAgent.isToolEnabled("bash")).toBe(true);
    expect(outputLines.join("\n")).toContain("Enabled tool: bash");
  });
});
