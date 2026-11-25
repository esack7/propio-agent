import type {
  Agent,
  AgentVisibilityEvent as CliVisibilityEvent,
  TurnReasoningSummary,
} from "../agent.js";
import { formatContextStats } from "./contextInspector.js";
import { TerminalUi } from "./terminal.js";
import type {
  AgentVisibilityEvent,
  GuidanceSource,
  PromptSubmission,
} from "../agent-core/index.js";
import {
  normalizeSessionEvent,
  type SessionEventBody,
} from "../agent-core/protocol.js";
import { createTurnEventRenderer } from "./turnEventRenderer.js";

export interface AssistantTurnVisibilityOptions {
  showToolCalls: boolean;
  showThinking: boolean;
  showStatus: boolean;
  showReasoningSummary: boolean;
  showContextStats: boolean;
  showPromptPlan: boolean;
}

export type AssistantTurnVisibilitySource =
  AssistantTurnVisibilityOptions | (() => AssistantTurnVisibilityOptions);

export type AssistantTurnAgent = {
  takeRecoveredGuidance?: () => string[];
  recordSessionProtocol?: (
    event: import("../agent-core/protocol.js").ProtocolEvent,
  ) => void;
  getSessionEventLog?: () =>
    import("../agent-core/protocol.js").SessionEventLog | undefined;
} & Pick<
  Agent,
  "streamChat" | "getLastTurnReasoningSummary" | "getConversationState"
>;

export interface AssistantTurnResult {
  response: string;
  reasoningSummary?: TurnReasoningSummary;
}

export async function streamAssistantTurn(
  agent: AssistantTurnAgent,
  submission: PromptSubmission,
  ui: TerminalUi,
  abortSignal: AbortSignal,
  visibility: AssistantTurnVisibilitySource,
  guidance?: GuidanceSource,
  onEvent?: (
    event: AgentVisibilityEvent | CliVisibilityEvent | SessionEventBody,
  ) => SessionEventBody | void,
): Promise<AssistantTurnResult> {
  const renderer = createTurnEventRenderer(ui, visibility);
  const emit = (
    value: AgentVisibilityEvent | CliVisibilityEvent | SessionEventBody,
  ): void => {
    let event: SessionEventBody | void = undefined;
    try {
      event = onEvent?.(value);
    } catch {
      /* Observers cannot replace agent errors. */
    }
    renderer.accept(event ?? normalizeSessionEvent(value).event);
  };
  const getVisibility =
    typeof visibility === "function" ? visibility : () => visibility;
  let response: string;
  try {
    response = await agent.streamChat(
      submission,
      (delta) => emit({ type: "assistant_text", delta }),
      {
        abortSignal,
        // The final summary is emitted after the answer, as in the existing CLI.
        onEvent: (event) => {
          if (event.type !== "reasoning_summary") emit(event);
        },
        requestReasoning: getVisibility().showThinking,
        ...(guidance ? { guidance } : {}),
      },
    );
  } catch (error) {
    emit(
      abortSignal.aborted
        ? { type: "turn_cancelled" }
        : { type: "turn_failed", error },
    );
    throw error;
  } finally {
    renderer.finish();
  }
  emit({ type: "turn_completed", result: response });
  const reasoningSummary = agent.getLastTurnReasoningSummary() ?? undefined;
  if (reasoningSummary)
    emit({ type: "reasoning_summary", ...reasoningSummary });
  if (getVisibility().showContextStats)
    emit({
      type: "context_stats",
      text: formatContextStats(agent.getConversationState()),
    });
  return { response, reasoningSummary };
}
