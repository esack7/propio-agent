import { createToolCallVisibilityState } from "../toolCallVisibility.js";

describe("toolCallVisibility", () => {
  it("defaults to showing tool calls while preserving baseline visibility flags", () => {
    const baseline = {
      showStatus: false,
      showReasoningSummary: true,
      showContextStats: false,
      showPromptPlan: true,
    };

    const state = createToolCallVisibilityState(baseline);

    expect(state.getSnapshot()).toEqual({
      ...baseline,
      showToolCalls: true,
    });
    expect(baseline).toEqual({
      showStatus: false,
      showReasoningSummary: true,
      showContextStats: false,
      showPromptPlan: true,
    });
  });

  it("toggles tool calls without mutating the baseline snapshot", () => {
    const baseline = {
      showStatus: true,
      showReasoningSummary: false,
      showContextStats: true,
      showPromptPlan: false,
    };

    const state = createToolCallVisibilityState(baseline);

    expect(state.toggleToolCalls()).toEqual({
      ...baseline,
      showToolCalls: false,
    });
    expect(state.getSnapshot()).toEqual({
      ...baseline,
      showToolCalls: false,
    });
    expect(state.toggleToolCalls()).toEqual({
      ...baseline,
      showToolCalls: true,
    });
  });
});
