import * as readline from "readline";
import { Agent } from "../../agent.js";
import { showToolMenu } from "../toolMenu.js";

// Mock Agent class
class MockAgent {
  private tools = new Map([
    ["read_file", true],
    ["write_file", true],
    ["search_code", true],
    ["run_bash", false],
    ["remove", false],
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

// Mock readline.Interface
class MockReadlineInterface {
  questionCallback: ((input: string) => void) | null = null;

  question(prompt: string, callback: (input: string) => void): void {
    this.questionCallback = callback;
  }

  // Helper to simulate user input
  simulateInput(input: string): void {
    if (this.questionCallback) {
      this.questionCallback(input);
    }
  }

  close(): void {
    // No-op for tests
  }
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

  describe("Tool List Display", () => {
    it("should display all registered tools with their status", () => {
      showToolMenu(mockRl as any, mockAgent as any, () => {}, mockUi as any);

      const output = outputLines.join("\n");

      // Should show Tools header
      expect(output).toContain("Tools:");

      // Should show all tools with status
      expect(output).toContain("read_file");
      expect(output).toContain("write_file");
      expect(output).toContain("search_code");
      expect(output).toContain("run_bash");
      expect(output).toContain("remove");

      // Should show enabled/disabled status
      expect(output).toContain("[enabled]");
      expect(output).toContain("[disabled]");
    });

    it("should number tools starting from 1", () => {
      showToolMenu(mockRl as any, mockAgent as any, () => {}, mockUi as any);

      const output = outputLines.join("\n");

      expect(output).toContain("1.");
      expect(output).toContain("2.");
      expect(output).toContain("3.");
      expect(output).toContain("4.");
      expect(output).toContain("5.");
    });
  });

  describe("Toggle Enabled → Disabled", () => {
    it("should disable an enabled tool when its number is entered", () => {
      let onDoneCalled = false;
      showToolMenu(
        mockRl as any,
        mockAgent as any,
        () => {
          onDoneCalled = true;
        },
        mockUi as any,
      );

      // Tool 1 is read_file (enabled)
      expect(mockAgent.isToolEnabled("read_file")).toBe(true);

      outputLines = [];
      mockRl.simulateInput("1");

      expect(mockAgent.isToolEnabled("read_file")).toBe(false);

      // Should show success message
      const output = outputLines.join("\n");
      expect(output).toContain("Disabled tool");
      expect(output).toContain("read_file");

      // Should re-display menu (not call onDone)
      expect(onDoneCalled).toBe(false);
    });
  });

  describe("Toggle Disabled → Enabled (Non-Dangerous)", () => {
    it("should enable a disabled non-dangerous tool when its number is entered", () => {
      // Add a non-dangerous disabled tool
      const customAgent = new MockAgent();
      customAgent.disableTool("search_code");

      let onDoneCalled = false;
      showToolMenu(
        mockRl as any,
        customAgent as any,
        () => {
          onDoneCalled = true;
        },
        mockUi as any,
      );

      // Tool 3 is search_code (disabled, non-dangerous)
      expect(customAgent.isToolEnabled("search_code")).toBe(false);

      outputLines = [];
      mockRl.simulateInput("3");

      expect(customAgent.isToolEnabled("search_code")).toBe(true);

      // Should show success message
      const output = outputLines.join("\n");
      expect(output).toContain("Enabled tool");
      expect(output).toContain("search_code");

      // Should re-display menu (not call onDone)
      expect(onDoneCalled).toBe(false);
    });
  });

  describe("Dangerous Tool Confirmation", () => {
    it("should show warning and enable dangerous tool when user confirms with y", () => {
      let onDoneCalled = false;
      showToolMenu(
        mockRl as any,
        mockAgent as any,
        () => {
          onDoneCalled = true;
        },
        mockUi as any,
      );

      // Tool 4 is run_bash (disabled, dangerous)
      expect(mockAgent.isToolEnabled("run_bash")).toBe(false);

      outputLines = [];
      mockRl.simulateInput("4");

      // Should show warning
      const warningOutput = outputLines.join("\n");
      expect(warningOutput).toContain("WARNING");
      expect(warningOutput).toContain("run_bash");
      expect(warningOutput).toContain("dangerous");

      // Simulate confirmation
      outputLines = [];
      mockRl.simulateInput("y");

      expect(mockAgent.isToolEnabled("run_bash")).toBe(true);

      // Should show success message
      const successOutput = outputLines.join("\n");
      expect(successOutput).toContain("Enabled tool");
      expect(successOutput).toContain("run_bash");

      expect(onDoneCalled).toBe(false);
    });

    it("should keep tool disabled when user declines with n", () => {
      let onDoneCalled = false;
      showToolMenu(
        mockRl as any,
        mockAgent as any,
        () => {
          onDoneCalled = true;
        },
        mockUi as any,
      );

      // Tool 5 is remove (disabled, dangerous)
      expect(mockAgent.isToolEnabled("remove")).toBe(false);

      outputLines = [];
      mockRl.simulateInput("5");

      // Simulate decline
      outputLines = [];
      mockRl.simulateInput("n");

      expect(mockAgent.isToolEnabled("remove")).toBe(false);

      // Should show message that tool remains disabled
      const output = outputLines.join("\n");
      expect(output).toContain("remains disabled");
      expect(output).toContain("remove");

      expect(onDoneCalled).toBe(false);
    });

    it("should keep tool disabled when user enters anything other than y", () => {
      let onDoneCalled = false;
      showToolMenu(
        mockRl as any,
        mockAgent as any,
        () => {
          onDoneCalled = true;
        },
        mockUi as any,
      );

      expect(mockAgent.isToolEnabled("run_bash")).toBe(false);

      mockRl.simulateInput("4");

      // Test various non-y inputs
      const nonYInputs = ["N", "no", "yes", "maybe", "", "   "];

      nonYInputs.forEach((input) => {
        mockAgent.disableTool("run_bash");
        showToolMenu(mockRl as any, mockAgent as any, () => {}, mockUi as any);
        mockRl.simulateInput("4");
        mockRl.simulateInput(input);
        expect(mockAgent.isToolEnabled("run_bash")).toBe(false);
      });
    });

    it("should NOT require confirmation when disabling a dangerous tool", () => {
      // First, enable run_bash
      mockAgent.enableTool("run_bash");

      let onDoneCalled = false;
      showToolMenu(
        mockRl as any,
        mockAgent as any,
        () => {
          onDoneCalled = true;
        },
        mockUi as any,
      );

      expect(mockAgent.isToolEnabled("run_bash")).toBe(true);

      outputLines = [];
      mockRl.simulateInput("4");

      // Should disable immediately without confirmation
      expect(mockAgent.isToolEnabled("run_bash")).toBe(false);

      // Should show disabled message
      const output = outputLines.join("\n");
      expect(output).toContain("Disabled tool");

      // Should NOT show warning
      expect(output).not.toContain("WARNING");

      expect(onDoneCalled).toBe(false);
    });
  });

  describe("Invalid Input Handling", () => {
    it("should show error for non-numeric input", () => {
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
      mockRl.simulateInput("abc");

      const output = outputLines.join("\n");
      expect(output).toContain("Invalid input");

      // Should re-display menu (not call onDone)
      expect(onDoneCalled).toBe(false);
    });

    it("should show error for out-of-range number (too high)", () => {
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
      mockRl.simulateInput("999");

      const output = outputLines.join("\n");
      expect(output).toContain("Invalid input");

      expect(onDoneCalled).toBe(false);
    });

    it("should show error for out-of-range number (zero)", () => {
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
      mockRl.simulateInput("0");

      const output = outputLines.join("\n");
      expect(output).toContain("Invalid input");

      expect(onDoneCalled).toBe(false);
    });

    it("should show error for negative numbers", () => {
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
      mockRl.simulateInput("-1");

      const output = outputLines.join("\n");
      expect(output).toContain("Invalid input");

      expect(onDoneCalled).toBe(false);
    });
  });

  describe("Exit Handling", () => {
    it("should call onDone when user enters q", () => {
      let onDoneCalled = false;
      showToolMenu(
        mockRl as any,
        mockAgent as any,
        () => {
          onDoneCalled = true;
        },
        mockUi as any,
      );

      mockRl.simulateInput("q");

      expect(onDoneCalled).toBe(true);
    });

    it("should call onDone when user enters Q (uppercase)", () => {
      let onDoneCalled = false;
      showToolMenu(
        mockRl as any,
        mockAgent as any,
        () => {
          onDoneCalled = true;
        },
        mockUi as any,
      );

      mockRl.simulateInput("Q");

      expect(onDoneCalled).toBe(true);
    });

    it("should call onDone when user enters empty input", () => {
      let onDoneCalled = false;
      showToolMenu(
        mockRl as any,
        mockAgent as any,
        () => {
          onDoneCalled = true;
        },
        mockUi as any,
      );

      mockRl.simulateInput("");

      expect(onDoneCalled).toBe(true);
    });

    it("should call onDone when user enters whitespace-only input", () => {
      let onDoneCalled = false;
      showToolMenu(
        mockRl as any,
        mockAgent as any,
        () => {
          onDoneCalled = true;
        },
        mockUi as any,
      );

      mockRl.simulateInput("   ");

      expect(onDoneCalled).toBe(true);
    });
  });
});
