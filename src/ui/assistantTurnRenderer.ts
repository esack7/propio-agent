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
  showStatus: boolean;
  showReasoningSummary: boolean;
  showContextStats: boolean;
  showPromptPlan: boolean;
}

export type AssistantTurnAgent = Pick<
  Agent,
  "streamChat" | "getLastTurnReasoningSummary" | "getConversationState"
>;

export interface AssistantTurnResult {
  response: string;
  reasoningSummary?: TurnReasoningSummary;
}

const HIDDEN_TOOL_STATUS_MIN_VISIBLE_MS = 300;

function sleepSync(ms: number): void {
  if (ms <= 0) {
    return;
  }

  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export async function streamAssistantTurn(
  agent: AssistantTurnAgent,
  userInput: string,
  ui: TerminalUi,
  abortSignal: AbortSignal,
  visibility: AssistantTurnVisibilityOptions,
): Promise<AssistantTurnResult> {
  const mdStream = ui.createMarkdownStream();
  const useLabelByCallId = new Map<string, string>();
  let hiddenToolStatusActive = false;
  let hiddenToolStatusStartedAtMs = 0;

  if (!ui.isJsonMode()) {
    ui.beginAssistantResponse();
  }

  const clearHiddenToolStatus = (): void => {
    if (!hiddenToolStatusActive) {
      return;
    }

    const visibleForMs = Date.now() - hiddenToolStatusStartedAtMs;
    const remainingVisibleMs = HIDDEN_TOOL_STATUS_MIN_VISIBLE_MS - visibleForMs;
    sleepSync(remainingVisibleMs);
    hiddenToolStatusActive = false;
    ui.done();
  };

  const renderVisibilityEvent = (event: AgentVisibilityEvent): void => {
    if (event.type === "status") {
      if (visibility.showStatus) {
        mdStream.flush();
        ui.traceStatus(event.status);
      }
      return;
    }

    if (
      event.type === "tool_started" ||
      event.type === "tool_finished" ||
      event.type === "tool_failed"
    ) {
      if (!visibility.showToolCalls) {
        if (event.type === "tool_started") {
          if (!hiddenToolStatusActive) {
            mdStream.flush();
            hiddenToolStatusActive = true;
            hiddenToolStatusStartedAtMs = Date.now();
            ui.status("Working", "tool call");
          }
        }
        return;
      }

      if (event.type === "tool_started") {
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
        ui.upsertToolCallView(runningView);
        return;
      }

      if (event.type === "tool_finished") {
        const useLabel =
          useLabelByCallId.get(event.toolCallId) ?? event.activityLabel;
        const successView: ToolCallView = {
          id: event.toolCallId,
          toolName: event.toolName,
          status: "success",
          useLabel,
          resultLabel: event.resultPreview,
        };
        ui.upsertToolCallView(successView);
        return;
      }

      const useLabel =
        useLabelByCallId.get(event.toolCallId) ?? event.activityLabel;
      const errorView: ToolCallView = {
        id: event.toolCallId,
        toolName: event.toolName,
        status: "error",
        useLabel,
        resultLabel: event.resultPreview,
      };
      ui.upsertToolCallView(errorView);
      return;
    }

    if (event.type === "prompt_plan_built") {
      if (visibility.showPromptPlan) {
        mdStream.flush();
        ui.newline();
        ui.subtle(formatPromptPlanCompact(event.snapshot));
      }
      return;
    }
  };

  const response = await agent.streamChat(
    userInput,
    (token) => {
      if (!ui.isJsonMode()) {
        if (token.trim().length > 0) {
          clearHiddenToolStatus();
        }
        mdStream.push(token);
      }
    },
    {
      abortSignal,
      onEvent: renderVisibilityEvent,
    },
  );

  clearHiddenToolStatus();
  mdStream.finish();
  ui.done();

  if (!ui.isJsonMode()) {
    if (response.trim().length === 0) {
      ui.warn(
        "Assistant returned an empty response. Re-run with --debug-llm or --debug-llm-file <path> to inspect provider events.",
      );
    }
    ui.newline();
  }

  const reasoningSummary = agent.getLastTurnReasoningSummary() ?? undefined;
  if (visibility.showReasoningSummary && reasoningSummary && !ui.isJsonMode()) {
    ui.reasoningSummary(reasoningSummary.summary, reasoningSummary.source);
  }

  if (!ui.isJsonMode() && visibility.showContextStats) {
    const state = agent.getConversationState();
    ui.subtle(formatContextStats(state));
  }

  return { response, reasoningSummary };
}
