import {
  applySubmittedText,
  clampPromptCursor,
  createPromptState,
} from "../promptState.js";

describe("promptState", () => {
  it("initializes with an empty buffer and cursor at 0", () => {
    const state = createPromptState({
      promptText: "Name? ",
      mode: "chat",
    });

    expect(state.buffer).toBe("");
    expect(state.cursor).toBe(0);
    expect(state.historySearch).toBeUndefined();
  });

  it("stores mode, placeholder, footer, and history", () => {
    const history = ["first", "second"];
    const state = createPromptState({
      promptText: "Name? ",
      mode: "menu",
      placeholder: "Type a number",
      footer: "Press Enter to continue",
      history,
      defaultValue: "abc",
    });

    expect(state.mode).toBe("menu");
    expect(state.placeholder).toBe("Type a number");
    expect(state.footer).toBe("Press Enter to continue");
    expect(state.history).toEqual(history);
    expect(state.history).not.toBe(history);
    expect(state.buffer).toBe("abc");
    expect(state.cursor).toBe(3);
    expect(state.multiline).toBe(false);
  });

  it("marks multiline buffers in prompt state", () => {
    const state = createPromptState({
      promptText: "Name? ",
      mode: "chat",
      defaultValue: "hello\nworld",
    });

    expect(state.multiline).toBe(true);
  });

  it("applies submitted text and moves the cursor to the end", () => {
    const state = createPromptState({
      promptText: "Name? ",
      mode: "chat",
      defaultValue: "hello",
    });

    const next = applySubmittedText(state, "world");

    expect(next.buffer).toBe("world");
    expect(next.cursor).toBe(5);
    expect(next.multiline).toBe(false);
  });

  it("clamps cursor values to the buffer bounds", () => {
    expect(clampPromptCursor(-10, 5)).toBe(0);
    expect(clampPromptCursor(99, 5)).toBe(5);
    expect(clampPromptCursor(3, 5)).toBe(3);
  });
});
