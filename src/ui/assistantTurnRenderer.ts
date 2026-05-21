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
import type { ToolCallView } from "./toolCallView.js";

export interface AssistantTurnVisibilityOptions {
  showToolCalls: boolean;
  showThinking: boolean;
  showStatus: boolean;
  showReasoningSummary: boolean;
  showContextStats: boolean;
  showPromptPlan: boolean;
}

export type AssistantTurnVisibilitySource =
  | AssistantTurnVisibilityOptions
  | (() => AssistantTurnVisibilityOptions);

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
  userInput: string,
  ui: TerminalUi,
  abortSignal: AbortSignal,
  visibility: AssistantTurnVisibilitySource,
): Promise<AssistantTurnResult> {
  const mdStream = ui.createMarkdownStream();
  const useLabelByCallId = new Map<string, string>();
  let hiddenToolStatusVisible = false;
  let hiddenToolCallInProgress = false;
  let hiddenThinkingStatusActive = false;
  let assistantResponseStarted = false;
  let thinkingStarted = false;
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

    if (!thinkingStarted) {
      thinkingStarted = true;
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

  const renderVisibleToolStarted = (
    currentVisibility: AssistantTurnVisibilityOptions,
    event: Extract<AgentVisibilityEvent, { type: "tool_started" }>,
  ): void => {
    clearThinkingStatusForAnswer();
    const toolLabel =
      event.toolName.charAt(0).toUpperCase() + event.toolName.slice(1);
    const useLabel =
      event.useLabel != null
        ? `${toolLabel} ${event.useLabel}`
        : event.activityLabel;
    useLabelByCallId.set(event.toolCallId, useLabel);
    mdStream.flush();
    const runningView: ToolCallView = {
      id: event.toolCallId,
      toolName: event.toolName,
      status: "running",
      useLabel,
      resultLabel: null,
    };
    if (canRenderVisibleThinking(currentVisibility)) {
      ui.appendToolCallView(runningView);
    } else {
      ui.upsertToolCallView(runningView);
    }
  };

  const renderVisibleToolFinished = (
    currentVisibility: AssistantTurnVisibilityOptions,
    event: Extract<AgentVisibilityEvent, { type: "tool_finished" }>,
  ): void => {
    clearThinkingStatusForAnswer();
    const useLabel =
      useLabelByCallId.get(event.toolCallId) ?? event.activityLabel;
    const successView: ToolCallView = {
      id: event.toolCallId,
      toolName: event.toolName,
      status: "success",
      useLabel,
      resultLabel: event.resultPreview,
    };
    if (canRenderVisibleThinking(currentVisibility)) {
      ui.appendToolCallView(successView);
    } else {
      ui.upsertToolCallView(successView);
    }
  };

  const renderVisibleToolFailed = (
    currentVisibility: AssistantTurnVisibilityOptions,
    event: Extract<AgentVisibilityEvent, { type: "tool_failed" }>,
  ): void => {
    clearThinkingStatusForAnswer();
    const useLabel =
      useLabelByCallId.get(event.toolCallId) ?? event.activityLabel;
    const errorView: ToolCallView = {
      id: event.toolCallId,
      toolName: event.toolName,
      status: "error",
      useLabel,
      resultLabel: event.resultPreview,
    };
    if (canRenderVisibleThinking(currentVisibility)) {
      ui.appendToolCallView(errorView);
    } else {
      ui.upsertToolCallView(errorView);
    }
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
        finishHiddenToolStatus();
      }
      return;
    }

    if (event.type === "tool_started") {
      renderVisibleToolStarted(currentVisibility, event);
      return;
    }

    if (event.type === "tool_finished") {
      renderVisibleToolFinished(currentVisibility, event);
      return;
    }

    renderVisibleToolFailed(currentVisibility, event);
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

    if (event.type === "prompt_plan_built") {
      renderPromptPlanEvent(currentVisibility, event);
    }
  };

  let response = "";
  try {
    response = await agent.streamChat(
      userInput,
      (token) => {
        if (!ui.isJsonMode()) {
          if (token.trim().length > 0) {
            clearThinkingStatusForAnswer();
            clearHiddenToolStatus();
            ui.clearEphemeralSurfaces();
          }
          beginAssistantResponseIfNeeded();
          mdStream.push(token);
        }
      },
      {
        abortSignal,
        onEvent: renderVisibilityEvent,
        requestReasoning: getVisibility().showThinking,
      },
    );
  } finally {
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
