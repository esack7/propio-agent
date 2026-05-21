import { createSessionVisibilityState } from "../sessionVisibility.js";

describe("sessionVisibility", () => {
  it("defaults to showing tool calls and thinking while preserving baseline visibility flags", () => {
    const baseline = {
      showStatus: false,
      showReasoningSummary: true,
      showContextStats: false,
      showPromptPlan: true,
    };

    const state = createSessionVisibilityState(baseline);

    expect(state.getSnapshot()).toEqual({
      ...baseline,
      showToolCalls: true,
      showThinking: true,
    });
    expect(baseline).toEqual({
      showStatus: false,
      showReasoningSummary: true,
      showContextStats: false,
      showPromptPlan: true,
    });
  });

  it("toggles tool calls and thinking without mutating the baseline snapshot", () => {
    const baseline = {
      showStatus: true,
      showReasoningSummary: false,
      showContextStats: true,
      showPromptPlan: false,
    };

    const state = createSessionVisibilityState(baseline);

    expect(state.toggleToolCalls()).toEqual({
      ...baseline,
      showToolCalls: false,
      showThinking: true,
    });
    expect(state.getSnapshot()).toEqual({
      ...baseline,
      showToolCalls: false,
      showThinking: true,
    });
    expect(state.toggleThinking()).toEqual({
      ...baseline,
      showToolCalls: false,
      showThinking: false,
    });
    expect(state.toggleToolCalls()).toEqual({
      ...baseline,
      showToolCalls: true,
      showThinking: false,
    });
  });
});
