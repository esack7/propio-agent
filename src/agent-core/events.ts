import type { ProviderReasoningSummarySource } from "@propio-ai/providers";
import type { ToolExecutionStatus } from "../tools/types.js";
import type { ToolDisplay } from "../tools/display.js";
import type { PromptPlan } from "../context/coreTypes.js";
export type AgentLifecycleEvent =
  | { type: "turn_started" }
  | { type: "assistant_text"; delta: string }
  | { type: "turn_completed"; result: string }
  | {
      type: "turn_cancelled";
      /** What the turn was doing when it was cancelled. */
      phase?: "model" | "tool";
      /** Calls that were running or not yet started, now recorded as interrupted. */
      interruptedToolCallIds?: readonly string[];
    }
  | { type: "turn_failed"; error: unknown };

export type AgentVisibilityEvent =
  | AgentLifecycleEvent
  | { type: "status"; status: string; phase?: string }
  | { type: "thinking_delta"; delta: string }
  /** Operator guidance entered the conversation before the given request. */
  | { type: "guidance_delivered"; id: string; text: string; iteration: number }
  | {
      type: "tool_started";
      toolName: string;
      toolCallId: string;
      activityLabel: string;
      useLabel: string | null;
      args: Record<string, unknown>;
      argumentChars: number;
      argumentPreview: string;
      /** The call as it would run, described before anyone approved it. */
      display: ToolDisplay;
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
      /** The call with what its result added. */
      display: ToolDisplay;
      /** Time spent running the tool, not waiting for approval. */
      durationMs: number;
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
      /** The call with what its result added. */
      display: ToolDisplay;
      /** Time spent running the tool, not waiting for approval. */
      durationMs: number;
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
  readonly abortSignal?: AbortSignal;
};

/** Something the operator said while a turn was running. */
export interface GuidanceMessage {
  /** Chosen by the sender; echoed when the message is delivered. */
  readonly id: string;
  readonly text: string;
}

/**
 * Where a running turn looks for operator guidance. The caller owns the
 * queue; the runtime only takes what is waiting, in order, at each point
 * where the model is about to be asked again.
 */
export interface GuidanceSource {
  /** Remove and return every waiting message, oldest first. */
  drain(): readonly GuidanceMessage[];
}

export type AgentStreamOptions = AgentToolOptions & {
  /** Guidance to deliver between model requests without cancelling the turn. */
  readonly guidance?: GuidanceSource;
  readonly extraUserInstruction?: string;
  readonly maxIterations?: number;
};

/**
 * Snapshot of a prompt plan plus the provider/model metadata that was
 * active when the plan was built. Emitted with prompt_plan_built for consumers
 * to inspect or record.
 */
export interface PromptPlanSnapshot {
  readonly provider: string;
  readonly model: string;
  readonly iteration: number;
  readonly contextWindowTokens: number;
  readonly availableInputBudget: number;
  readonly plan: PromptPlan;
}
