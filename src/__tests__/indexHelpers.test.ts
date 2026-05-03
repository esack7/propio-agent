import { isLlmDebugEnabled, renderStyledLines } from "../indexHelpers.js";

describe("isLlmDebugEnabled", () => {
  const originalEnv = process.env.PROPIO_DEBUG_LLM;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.PROPIO_DEBUG_LLM;
      return;
    }

    process.env.PROPIO_DEBUG_LLM = originalEnv;
  });

  it("returns true when the parsed flag is enabled", () => {
    process.env.PROPIO_DEBUG_LLM = "false";

    expect(isLlmDebugEnabled(true)).toBe(true);
  });

  it("reads truthy env values when the parsed flag is disabled", () => {
    process.env.PROPIO_DEBUG_LLM = "yes";

    expect(isLlmDebugEnabled(false)).toBe(true);
  });

  it("treats missing env values as disabled", () => {
    delete process.env.PROPIO_DEBUG_LLM;

    expect(isLlmDebugEnabled(false)).toBe(false);
  });
});

describe("renderStyledLines", () => {
  it("dispatches each line to the matching ui method", () => {
    const ui = {
      command: jest.fn(),
      info: jest.fn(),
      subtle: jest.fn(),
      section: jest.fn(),
    };

    renderStyledLines(ui, [
      { text: "A", style: "section" },
      { text: "B", style: "info" },
      { text: "C", style: "subtle" },
    ]);

    expect(ui.section).toHaveBeenCalledWith("A");
    expect(ui.info).toHaveBeenCalledWith("B");
    expect(ui.subtle).toHaveBeenCalledWith("C");
  });
});
