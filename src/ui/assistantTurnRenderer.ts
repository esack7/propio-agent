import type {
  Agent,
  AgentVisibilityEvent,
  TurnReasoningSummary,
} from "../agent.js";
import type { ToolExecutionStatus } from "../tools/types.js";
import {
  formatContextStats,
  formatPromptPlanCompact,
} from "./contextInspector.js";
import { TerminalUi } from "./terminal.js";

export interface AssistantTurnVisibilityOptions {
  showActivity: boolean;
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

function previewToolResult(result: string, maxLength = 70): string {
  const compact = result.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.substring(0, maxLength)}...`;
}

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
  const latestActivityLabelByToolName = new Map<string, string>();
  let hiddenToolStatusActive = false;
  let hiddenToolStatusStartedAtMs = 0;

  if (!ui.isJsonMode()) {
    ui.beginAssistantResponse();
  }

  const resolveActivityLabel = (toolName: string): string =>
    latestActivityLabelByToolName.get(toolName) ?? toolName;

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

      latestActivityLabelByToolName.set(event.toolName, event.activityLabel);

      if (!visibility.showActivity) {
        return;
      }

      mdStream.flush();
      if (event.type === "tool_started") {
        ui.traceActivity(`Starting ${event.activityLabel}`);
        return;
      }

      if (event.type === "tool_finished") {
        ui.traceActivity(
          `Finished ${event.activityLabel}: ${event.resultPreview}`,
        );
        return;
      }

      ui.traceActivity(
        `Failed ${event.activityLabel}: ${event.resultPreview}`,
        "error",
      );
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

  const shouldRenderLegacyToolCallbacks =
    visibility.showToolCalls && !visibility.showActivity;
  const toolCallbacks = shouldRenderLegacyToolCallbacks
    ? {
        onToolStart: (toolName: string) => {
          mdStream.flush();
          // Keep a durable transcript line so tool progress is visible
          // even when spinner frames are transient.
          const activityLabel = resolveActivityLabel(toolName);
          ui.info(`Starting ${activityLabel}...`);
          ui.status(`Executing ${activityLabel}...`, "tool call");
        },
        onToolEnd: (
          toolName: string,
          result: string,
          status: ToolExecutionStatus,
        ) => {
          const summary = previewToolResult(result);
          const activityLabel = resolveActivityLabel(toolName);
          if (status !== "success") {
            ui.error(`${activityLabel} failed: ${summary}`);
            return;
          }
          ui.success(`${activityLabel} completed: ${summary}`);
        },
      }
    : {
        onToolStart: (_toolName: string) => {
          /* Intentionally blank: suppress fallback token noise. */
        },
        onToolEnd: (
          _toolName: string,
          _result: string,
          _status: ToolExecutionStatus,
        ) => {
          /* Intentionally blank: suppress fallback token noise. */
        },
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
      ...toolCallbacks,
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
