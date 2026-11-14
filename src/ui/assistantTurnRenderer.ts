import type {
  Agent,
  AgentVisibilityEvent,
  TurnReasoningSummary,
} from "../agent.js";
import {
  formatContextStats,
  formatPromptPlanCompact,
} from "./contextInspector.js";
import { TerminalUi } from "./terminal.js";
import type { GuidanceSource, PromptSubmission } from "../agent-core/index.js";

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

export type AssistantTurnAgent = Pick<
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
): Promise<AssistantTurnResult> {
  const mdStream = ui.createMarkdownStream();
  let hiddenToolStatusVisible = false;
  let hiddenToolCallInProgress = false;
  let hiddenThinkingStatusActive = false;
  let assistantResponseStarted = false;
  let visibleThinkingLineOpen = false;
  let pendingThinkingText = "";
  let thinkingFlushScheduled = false;
  let thinkingFlushTimerId: NodeJS.Timeout | null = null;
  const getVisibility =
    typeof visibility === "function" ? visibility : () => visibility;

  const beginAssistantResponseIfNeeded = (): void => {
    if (assistantResponseStarted || ui.isJsonMode()) {
      return;
    }

    assistantResponseStarted = true;
    ui.beginAssistantResponse();
  };

  const clearHiddenToolStatus = (): void => {
    if (!hiddenToolStatusVisible) {
      return;
    }

    hiddenToolStatusVisible = false;
    hiddenToolCallInProgress = false;
    ui.done();
  };

  const clearHiddenThinkingStatus = (): void => {
    if (!hiddenThinkingStatusActive) {
      return;
    }

    hiddenThinkingStatusActive = false;
    ui.done();
  };

  const flushThinkingText = (): void => {
    if (pendingThinkingText.length === 0) {
      return;
    }

    if (!visibleThinkingLineOpen) {
      ui.beginThinkingResponse();
    }

    ui.writeThinking(pendingThinkingText);
    visibleThinkingLineOpen = true;
    pendingThinkingText = "";
  };

  const scheduleThinkingFlush = (): void => {
    if (thinkingFlushScheduled || pendingThinkingText.length === 0) {
      return;
    }

    thinkingFlushScheduled = true;
    thinkingFlushTimerId = setTimeout(() => {
      thinkingFlushTimerId = null;
      thinkingFlushScheduled = false;
      if (pendingThinkingText.length === 0) {
        return;
      }

      flushThinkingText();
    }, 40);
    thinkingFlushTimerId.unref();
  };

  const clearThinkingStatusForAnswer = (): void => {
    clearHiddenThinkingStatus();
    if (pendingThinkingText.length > 0) {
      flushThinkingText();
    }
    if (visibleThinkingLineOpen) {
      ui.newline();
      visibleThinkingLineOpen = false;
    }
  };

  const canRenderVisibleThinking = (
    currentVisibility: AssistantTurnVisibilityOptions,
  ): boolean => currentVisibility.showThinking && ui.supportsVisibleThinking();

  const renderVisibleThinkingDelta = (
    event: Extract<AgentVisibilityEvent, { type: "thinking_delta" }>,
  ): void => {
    clearHiddenThinkingStatus();
    if (assistantResponseStarted) {
      mdStream.flush();
    }
    pendingThinkingText += event.delta;
    scheduleThinkingFlush();
  };

  const renderHiddenThinkingStatus = (): void => {
    if (hiddenToolCallInProgress || !ui.supportsEphemeralStatus()) {
      return;
    }

    if (hiddenToolStatusVisible) {
      clearHiddenToolStatus();
    }
    if (!hiddenThinkingStatusActive) {
      mdStream.flush();
      hiddenThinkingStatusActive = true;
      ui.status("Thinking", "thinking");
    }
  };

  const renderStatusEvent = (
    currentVisibility: AssistantTurnVisibilityOptions,
    event: Extract<AgentVisibilityEvent, { type: "status" }>,
  ): void => {
    if (
      currentVisibility.showThinking &&
      ui.supportsVisibleThinking() &&
      pendingThinkingText.length > 0
    ) {
      flushThinkingText();
    }
    if (currentVisibility.showStatus) {
      mdStream.flush();
      ui.traceStatus(event.status);
    }
  };

  const renderThinkingDeltaEvent = (
    currentVisibility: AssistantTurnVisibilityOptions,
    event: Extract<AgentVisibilityEvent, { type: "thinking_delta" }>,
  ): void => {
    if (canRenderVisibleThinking(currentVisibility)) {
      renderVisibleThinkingDelta(event);
      return;
    }

    if (currentVisibility.showThinking) {
      return;
    }

    renderHiddenThinkingStatus();
  };

  const startHiddenToolStatus = (): void => {
    clearHiddenThinkingStatus();
    hiddenToolCallInProgress = true;
    if (!hiddenToolStatusVisible) {
      mdStream.flush();
      hiddenToolStatusVisible = true;
      ui.status("Working", "tool call");
    }
  };

  const finishHiddenToolStatus = (): void => {
    hiddenToolCallInProgress = false;
  };

  const renderToolEvent = (
    currentVisibility: AssistantTurnVisibilityOptions,
    event: Extract<
      AgentVisibilityEvent,
      { type: "tool_started" | "tool_finished" | "tool_failed" }
    >,
  ): void => {
    if (!currentVisibility.showToolCalls) {
      if (event.type === "tool_started") {
        startHiddenToolStatus();
      } else {
        ui.removeRunningToolCall(event.toolCallId);
        finishHiddenToolStatus();
      }
      return;
    }

    clearThinkingStatusForAnswer();
    mdStream.flush();
    ui.renderToolCall({
      id: event.toolCallId,
      toolName: event.toolName,
      display: event.display,
      status:
        event.type === "tool_started"
          ? "running"
          : event.type === "tool_failed"
            ? "error"
            : "success",
      ...(event.type === "tool_started"
        ? {}
        : {
            durationMs: event.durationMs,
            fullOutputPath: event.fullOutputPath,
          }),
    });
  };

  const renderPromptPlanEvent = (
    currentVisibility: AssistantTurnVisibilityOptions,
    event: Extract<AgentVisibilityEvent, { type: "prompt_plan_built" }>,
  ): void => {
    clearThinkingStatusForAnswer();
    if (currentVisibility.showPromptPlan) {
      mdStream.flush();
      ui.newline();
      ui.subtle(formatPromptPlanCompact(event.snapshot));
    }
  };

  const renderVisibilityEvent = (event: AgentVisibilityEvent): void => {
    const currentVisibility = getVisibility();

    if (event.type === "status") {
      renderStatusEvent(currentVisibility, event);
      return;
    }

    if (event.type === "thinking_delta") {
      renderThinkingDeltaEvent(currentVisibility, event);
      return;
    }

    if (
      event.type === "tool_started" ||
      event.type === "tool_finished" ||
      event.type === "tool_failed"
    ) {
      renderToolEvent(currentVisibility, event);
      return;
    }

    if (event.type === "guidance_delivered") {
      // Shown where the model received it, after what it had said so far.
      mdStream.flush();
      clearThinkingStatusForAnswer();
      ui.guidanceDelivered(event.text);
      return;
    }

    if (event.type === "prompt_plan_built") {
      renderPromptPlanEvent(currentVisibility, event);
    }
  };

  let response = "";
  try {
    response = await agent.streamChat(
      submission,
      (token) => {
        if (!ui.isJsonMode()) {
          if (token.trim().length > 0) {
            clearThinkingStatusForAnswer();
            clearHiddenToolStatus();
          }
          beginAssistantResponseIfNeeded();
          mdStream.push(token);
        }
      },
      {
        abortSignal,
        onEvent: renderVisibilityEvent,
        requestReasoning: getVisibility().showThinking,
        ...(guidance ? { guidance } : {}),
      },
    );
  } finally {
    ui.clearRunningToolCalls();
    clearThinkingStatusForAnswer();
    clearHiddenToolStatus();
    if (thinkingFlushTimerId) {
      clearTimeout(thinkingFlushTimerId);
      thinkingFlushTimerId = null;
      thinkingFlushScheduled = false;
    }
    mdStream.finish();
    ui.done();
  }

  if (!ui.isJsonMode()) {
    if (response.trim().length === 0) {
      ui.warn(
        "Assistant returned an empty response. Re-run with --debug-llm or --debug-llm-file <path> to inspect provider events.",
      );
    }
    ui.newline();
  }

  const reasoningSummary = agent.getLastTurnReasoningSummary() ?? undefined;
  const finalVisibility = getVisibility();
  if (
    finalVisibility.showReasoningSummary &&
    reasoningSummary &&
    !ui.isJsonMode()
  ) {
    ui.reasoningSummary(reasoningSummary.summary, reasoningSummary.source);
  }

  if (!ui.isJsonMode() && finalVisibility.showContextStats) {
    const state = agent.getConversationState();
    ui.subtle(formatContextStats(state));
  }

  return { response, reasoningSummary };
}
