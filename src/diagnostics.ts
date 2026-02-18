export type AgentDiagnosticEvent =
  | {
      type: "request_started";
      provider: string;
      model: string;
      iteration: number;
      contextMessages: number;
      enabledTools: number;
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
    };
