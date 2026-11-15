import type { SessionEventBody } from "../agent-core/protocol.js";
import { formatPromptPlanSummary } from "./contextInspector.js";
import { TerminalUi } from "./terminal.js";
import type {
  AssistantTurnVisibilitySource,
  AssistantTurnVisibilityOptions,
} from "./assistantTurnRenderer.js";

/** The same stateful renderer consumes live normalized events and stored events. */
export function createTurnEventRenderer(
  ui: TerminalUi,
  visibility: AssistantTurnVisibilitySource,
) {
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
    event: Extract<SessionEventBody, { type: "thinking_delta" }>,
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
    event: Extract<SessionEventBody, { type: "status" }>,
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
    event: Extract<SessionEventBody, { type: "thinking_delta" }>,
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
      SessionEventBody,
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
    event: Extract<SessionEventBody, { type: "prompt_plan_built" }>,
  ): void => {
    clearThinkingStatusForAnswer();
    if (currentVisibility.showPromptPlan) {
      mdStream.flush();
      ui.newline();
      ui.subtle(formatPromptPlanSummary(event.snapshot));
    }
  };

  const renderOutputEvent = (
    visible: boolean,
    event: Extract<SessionEventBody, { type: "tool_output" }>,
  ) => {
    if (visible)
      ui.updateToolOutput(
        event.toolCallId,
        event.stream,
        event.text,
        event.elapsedMs,
        event.droppedBytes,
      );
  };

  const renderVisibilityEvent = (event: SessionEventBody): void => {
    const currentVisibility = getVisibility();

    if (event.type === "tool_output") {
      renderOutputEvent(currentVisibility.showToolCalls, event);
      return;
    }

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

  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
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
  };

  const renderText = (delta: string): void => {
    if (ui.isJsonMode()) return;
    if (delta.trim().length > 0) {
      clearThinkingStatusForAnswer();
      clearHiddenToolStatus();
    }
    beginAssistantResponseIfNeeded();
    mdStream.push(delta);
  };
  const renderCompleted = (result: string): void => {
    finish();
    if (ui.isJsonMode()) return;
    if (!result.trim())
      ui.warn(
        "Assistant returned an empty response. Re-run with --debug-llm or --debug-llm-file <path> to inspect provider events.",
      );
    ui.newline();
  };
  const renderSummary = (
    event: Extract<SessionEventBody, { type: "reasoning_summary" }>,
  ): void => {
    if (!ui.isJsonMode() && getVisibility().showReasoningSummary)
      ui.reasoningSummary(event.summary, event.source);
  };
  const renderStats = (text: string): void => {
    if (!ui.isJsonMode() && getVisibility().showContextStats) ui.subtle(text);
  };
  const renderTerminalEvent = (event: SessionEventBody): boolean => {
    switch (event.type) {
      case "assistant_text":
        renderText(event.delta);
        return true;
      case "turn_completed":
        renderCompleted(event.result);
        return true;
      case "turn_failed":
      case "turn_cancelled":
        finish();
        return true;
      case "reasoning_summary":
        renderSummary(event);
        return true;
      case "context_stats":
        renderStats(event.text);
        return true;
      default:
        return false;
    }
  };
  return {
    accept: (event: SessionEventBody) => {
      if (!renderTerminalEvent(event)) renderVisibilityEvent(event);
    },
    finish,
  };
}
