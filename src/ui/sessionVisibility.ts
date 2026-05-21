export interface SessionVisibilityBaseline {
  readonly showStatus: boolean;
  readonly showReasoningSummary: boolean;
  readonly showContextStats: boolean;
  readonly showPromptPlan: boolean;
}

export interface SessionVisibilitySnapshot extends SessionVisibilityBaseline {
  readonly showToolCalls: boolean;
  readonly showThinking: boolean;
}

export interface SessionVisibilityState {
  getSnapshot(): SessionVisibilitySnapshot;
  toggleToolCalls(): SessionVisibilitySnapshot;
  toggleThinking(): SessionVisibilitySnapshot;
}

function buildSnapshot(
  baseline: SessionVisibilityBaseline,
  showToolCalls: boolean,
  showThinking: boolean,
): SessionVisibilitySnapshot {
  return {
    ...baseline,
    showToolCalls,
    showThinking,
  };
}

export function createSessionVisibilityState(
  baseline: SessionVisibilityBaseline,
  initialShowToolCalls = true,
  initialShowThinking = false,
): SessionVisibilityState {
  const baselineSnapshot: SessionVisibilityBaseline = { ...baseline };
  let showToolCalls = initialShowToolCalls;
  let showThinking = initialShowThinking;

  return {
    getSnapshot(): SessionVisibilitySnapshot {
      return buildSnapshot(baselineSnapshot, showToolCalls, showThinking);
    },
    toggleToolCalls(): SessionVisibilitySnapshot {
      showToolCalls = !showToolCalls;
      return buildSnapshot(baselineSnapshot, showToolCalls, showThinking);
    },
    toggleThinking(): SessionVisibilitySnapshot {
      showThinking = !showThinking;
      return buildSnapshot(baselineSnapshot, showToolCalls, showThinking);
    },
  };
}
