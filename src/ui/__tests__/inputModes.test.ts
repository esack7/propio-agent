import {
  applyInputModeFromBuffer,
  formatBashHistoryEntry,
  getModeFromInput,
  getValueFromInput,
  parseBashHistoryEntry,
} from "../inputModes.js";

describe("inputModes", () => {
  it("detects bash mode from a leading exclamation", () => {
    expect(getModeFromInput("!pwd")).toBe("bash");
    expect(getModeFromInput("pwd")).toBe("prompt");
  });

  it("strips one leading exclamation from bash input", () => {
    expect(getValueFromInput("!pwd")).toBe("pwd");
    expect(getValueFromInput("pwd")).toBe("pwd");
  });

  it("enters bash mode and strips the prefix from the buffer", () => {
    expect(applyInputModeFromBuffer("prompt", "!pwd")).toEqual({
      inputMode: "bash",
      buffer: "pwd",
      cursorAdjusted: -1,
    });
  });

  it("leaves prompt mode buffers unchanged", () => {
    expect(applyInputModeFromBuffer("prompt", "hello")).toEqual({
      inputMode: "prompt",
      buffer: "hello",
      cursorAdjusted: 0,
    });
  });

  it("formats and parses bash history entries", () => {
    expect(formatBashHistoryEntry("git status")).toBe("!git status");
    expect(parseBashHistoryEntry("!git status")).toBe("git status");
  });
});
