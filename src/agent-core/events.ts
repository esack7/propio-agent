import type { ProviderReasoningSummarySource } from "@propio-ai/providers";
import type { ToolExecutionStatus } from "../tools/types.js";
import type { PromptPlan } from "../context/coreTypes.js";
export type AgentLifecycleEvent =
  | { type: "turn_started" }
  | { type: "assistant_text"; delta: string }
  | { type: "turn_completed"; result: string }
  | { type: "turn_cancelled" }
  | { type: "turn_failed"; error: unknown };

export type AgentVisibilityEvent =
  | AgentLifecycleEvent
  | { type: "status"; status: string; phase?: string }
  | { type: "thinking_delta"; delta: string }
  | {
      type: "tool_started";
      toolName: string;
      toolCallId: string;
      activityLabel: string;
      useLabel: string | null;
      args: Record<string, unknown>;
      argumentChars: number;
      argumentPreview: string;
    }
  | {
      type: "tool_finished";
      toolName: string;
      toolCallId: string;
      activityLabel: string;
      resultPreview: string;
      result: string;
      args: Record<string, unknown>;
      status: ToolExecutionStatus;
    }
  | {
      type: "tool_failed";
      toolName: string;
      toolCallId: string;
      activityLabel: string;
      resultPreview: string;
      result: string;
      args: Record<string, unknown>;
      status: ToolExecutionStatus;
    }
  | {
      type: "reasoning_summary";
      summary: string;
      source: ProviderReasoningSummarySource;
    }
  | {
      type: "prompt_plan_built";
      snapshot: PromptPlanSnapshot;
    };

export interface TurnReasoningSummary {
  summary: string;
  source: ProviderReasoningSummarySource;
}

export type AgentEventOptions = {
  readonly onEvent?: (event: AgentVisibilityEvent) => void;
  readonly requestReasoning?: boolean;
};

export type AgentToolOptions = AgentEventOptions & {
  /**
   * @deprecated Use onEvent with the tool_started event instead.
   */
  readonly onToolStart?: (toolName: string) => void;
  /**
   * @deprecated Use onEvent with tool_finished/tool_failed events instead.
   */
  readonly onToolEnd?: (
    toolName: string,
    result: string,
    status: ToolExecutionStatus,
  ) => void;
  readonly abortSignal?: AbortSignal;
};

export type AgentStreamOptions = AgentToolOptions & {
  readonly extraUserInstruction?: string;
  readonly maxIterations?: number;
};

/**
 * Snapshot of a prompt plan plus the provider/model metadata that was
 * active when the plan was built. Surfaced via Agent.getLastPromptPlan()
 * for the /context prompt introspection command.
 */
export interface PromptPlanSnapshot {
  readonly provider: string;
  readonly model: string;
  readonly iteration: number;
  readonly contextWindowTokens: number;
  readonly availableInputBudget: number;
  readonly plan: PromptPlan;
}
