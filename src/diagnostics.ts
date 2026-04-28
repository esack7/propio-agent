import { ChatMessage } from "./providers/types.js";

export const RESERVED_OUTPUT_TOKENS = 2048;

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

export function measureMessages(
  messages: ReadonlyArray<Readonly<ChatMessage>>,
): {
  messageCount: number;
  totalChars: number;
  estimatedTokens: number;
} {
  let totalChars = 0;
  for (const msg of messages) {
    totalChars += msg.content.length;
    if (msg.toolCalls) {
      totalChars += JSON.stringify(msg.toolCalls).length;
    }
    if (msg.toolResults) {
      totalChars += JSON.stringify(msg.toolResults).length;
    }
  }
  return {
    messageCount: messages.length,
    totalChars,
    estimatedTokens: estimateTokens(totalChars),
  };
}

export type AgentDiagnosticEvent =
  | {
      type: "context_snapshot";
      messageCount: number;
      totalChars: number;
      estimatedTokens: number;
    }
  | {
      type: "request_started";
      provider: string;
      model: string;
      iteration: number;
      contextMessages: number;
      enabledTools: number;
      promptMessageCount: number;
      promptChars: number;
      estimatedPromptTokens: number;
      reservedOutputTokens: number;
    }
  | {
      type: "chunk_received";
      provider: string;
      model: string;
      iteration: number;
      chunkIndex: number;
      chunkChars: number;
      accumulatedChars: number;
    }
  | {
      type: "tool_calls_received";
      provider: string;
      model: string;
      iteration: number;
      count: number;
      tools: string[];
    }
  | {
      type: "tool_execution_started";
      provider: string;
      model: string;
      iteration: number;
      toolName: string;
      toolCallId: string;
      argsChars: number;
    }
  | {
      type: "tool_execution_finished";
      provider: string;
      model: string;
      iteration: number;
      toolName: string;
      toolCallId: string;
      resultChars: number;
      truncatedForContext: boolean;
      status: "success" | "tool_not_found" | "tool_disabled" | "error";
    }
  | {
      type: "iteration_finished";
      provider: string;
      model: string;
      iteration: number;
      responseChars: number;
      responseIsEmpty: boolean;
      toolCalls: number;
    }
  | {
      type: "empty_response";
      provider: string;
      model: string;
      iteration: number;
      contextMessages: number;
    }
  | {
      type: "max_iterations_reached";
      provider: string;
      model: string;
      maxIterations: number;
    }
  | {
      type: "tool_loop_detected";
      provider: string;
      model: string;
      iteration: number;
      emptyToolOnlyStreak: number;
      threshold: number;
      action: "fallback_no_tools" | "abort";
    }
  | {
      type: "provider_error";
      provider: string;
      model: string;
      iteration: number;
      errorName: string;
      message: string;
    }
  | {
      type: "provider_retry";
      provider: string;
      model: string;
      iteration: number;
      reason: string;
      disabledTools: true;
    }
  | {
      type: "prompt_plan";
      provider: string;
      model: string;
      iteration: number;
      contextWindowTokens: number;
      availableInputBudget: number;
      estimatedPromptTokens: number;
      reservedOutputTokens: number;
      retryLevel: number;
      includedTurnCount: number;
      omittedTurnCount: number;
      includedArtifactCount: number;
      usedRollingSummary: boolean;
    }
  | {
      type: "summary_refresh_started";
      provider: string;
      model: string;
      eligibleTurnCount: number;
      newEligibleCount: number;
      reason: "turn_cadence" | "context_pressure" | "synchronous_shrink";
      promptMessageCount: number;
      promptChars: number;
      estimatedPromptTokens: number;
    }
  | {
      type: "summary_refresh_completed";
      provider: string;
      model: string;
      coveredTurnCount: number;
      summaryTokens: number;
      durationMs: number;
    }
  | {
      type: "summary_refresh_failed";
      provider: string;
      model: string;
      errorName: string;
      message: string;
    };
