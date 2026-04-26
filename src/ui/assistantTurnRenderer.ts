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

export interface AssistantTurnVisibilityOptions {
  showActivity: boolean;
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

function previewToolResult(result: string, maxLength = 70): string {
  const compact = result.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.substring(0, maxLength)}...`;
}

export async function streamAssistantTurn(
  agent: AssistantTurnAgent,
  userInput: string,
  ui: TerminalUi,
  abortSignal: AbortSignal,
  visibility: AssistantTurnVisibilityOptions,
): Promise<AssistantTurnResult> {
  const mdStream = ui.createMarkdownStream();

  if (!ui.isJsonMode()) {
    ui.beginAssistantResponse();
  }

  const renderVisibilityEvent = (event: AgentVisibilityEvent): void => {
    if (event.type === "status") {
      if (visibility.showStatus) {
        mdStream.flush();
        ui.traceStatus(event.status);
      }
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

    if (event.type === "tool_failed") {
      ui.traceActivity(
        `Failed ${event.activityLabel}: ${event.resultPreview}`,
        "error",
      );
    }
  };

  const useLegacyToolCallbacks = !visibility.showActivity;

  const response = await agent.streamChat(
    userInput,
    (token) => {
      if (!ui.isJsonMode()) {
        mdStream.push(token);
      }
    },
    {
      abortSignal,
      onEvent: renderVisibilityEvent,
      ...(useLegacyToolCallbacks
        ? {
            onToolStart: (toolName: string) => {
              mdStream.flush();
              // Keep a durable transcript line so tool progress is visible
              // even when spinner frames are transient.
              ui.info(`Starting ${toolName}...`);
              ui.status(`Executing ${toolName}...`, "tool call");
            },
            onToolEnd: (toolName: string, result: string, status) => {
              const summary = previewToolResult(result);
              if (status !== "success") {
                ui.error(`${toolName} failed: ${summary}`);
                return;
              }
              ui.success(`${toolName} completed: ${summary}`);
            },
          }
        : {}),
    },
  );

  mdStream.finish();

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
