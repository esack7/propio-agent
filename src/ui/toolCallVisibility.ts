export interface ToolCallVisibilityBaseline {
  readonly showActivity: boolean;
  readonly showStatus: boolean;
  readonly showReasoningSummary: boolean;
  readonly showContextStats: boolean;
  readonly showPromptPlan: boolean;
}

export interface ToolCallVisibilitySnapshot extends ToolCallVisibilityBaseline {
  readonly showToolCalls: boolean;
}

export interface ToolCallVisibilityState {
  getSnapshot(): ToolCallVisibilitySnapshot;
  toggleToolCalls(): ToolCallVisibilitySnapshot;
}

export function createToolCallVisibilityState(
  baseline: ToolCallVisibilityBaseline,
  initialShowToolCalls = true,
): ToolCallVisibilityState {
  const baselineSnapshot: ToolCallVisibilityBaseline = { ...baseline };
  let showToolCalls = initialShowToolCalls;

  return {
    getSnapshot(): ToolCallVisibilitySnapshot {
      return {
        ...baselineSnapshot,
        showToolCalls,
      };
    },
    toggleToolCalls(): ToolCallVisibilitySnapshot {
      showToolCalls = !showToolCalls;
      return {
        ...baselineSnapshot,
        showToolCalls,
      };
    },
  };
}
