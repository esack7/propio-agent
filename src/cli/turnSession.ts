import { randomUUID } from "node:crypto";
import {
  AgentSession,
  encodeCommandImage,
  type PromptSubmission,
} from "../agent-core/index.js";
import type { ApprovalChannel } from "../permissions/approvalChannel.js";
import type { ApprovalAnswer } from "../policy/index.js";
import {
  streamAssistantTurn,
  type AssistantTurnAgent,
  type AssistantTurnResult,
  type AssistantTurnVisibilitySource,
} from "../ui/assistantTurnRenderer.js";
import type { TerminalUi } from "../ui/terminal.js";

/**
 * The CLI's side of the session protocol. The terminal does not call the
 * agent: it dispatches commands to an `AgentSession`, in this process, the
 * way another frontend would over a transport.
 */
export interface CliTurnSession {
  readonly session: AgentSession;
  /**
   * Submit a message and wait for the turn. Aborting the signal with reason
   * "escape" dispatches an interrupt; any other reason stops the session's
   * turn with that reason. Resolves and rejects as the turn itself does.
   */
  runTurn(
    submission: PromptSubmission,
    abortSignal: AbortSignal,
  ): Promise<AssistantTurnResult>;
}

export function createCliTurnSession(
  agent: AssistantTurnAgent,
  ui: TerminalUi,
  visibility: AssistantTurnVisibilitySource,
): CliTurnSession {
  // Both sides are in one process, so the rendered result and the original
  // error are kept as they are rather than rebuilt from the ended event.
  let lastResult: AssistantTurnResult | undefined;
  let lastError: unknown;
  const session = new AgentSession({
    runTurn: async (submission, control) => {
      try {
        lastResult = await streamAssistantTurn(
          agent,
          submission,
          ui,
          control.abortSignal,
          visibility,
          control.guidance,
        );
        return lastResult.response;
      } catch (error) {
        lastError = error;
        throw error;
      }
    },
  });

  return {
    session,
    async runTurn(submission, abortSignal) {
      if (abortSignal.aborted) throw new Error("Request cancelled");
      const commandId = randomUUID();
      const ended = new Promise<"completed" | "cancelled" | "failed">(
        (resolve) => {
          const unsubscribe = session.subscribe((event) => {
            if (
              event.type === "session_turn_ended" &&
              event.commandId === commandId
            ) {
              unsubscribe();
              resolve(event.outcome);
            }
          });
        },
      );
      // Escape is the operator interrupting. Anything else, such as Ctrl+C,
      // is the CLI going away: the turn stops with that reason, so an
      // unanswered message is kept in the saved session as before.
      const interrupt = (): void => {
        if (abortSignal.reason === "escape") {
          session.dispatch({ type: "interrupt", commandId: randomUUID() });
        } else {
          session.stop(String(abortSignal.reason ?? "aborted"));
        }
      };
      abortSignal.addEventListener("abort", interrupt, { once: true });
      try {
        const images = submission.images?.map((image) =>
          image instanceof Uint8Array ? encodeCommandImage(image) : image,
        );
        const accepted = session.dispatch({
          type: "submit",
          commandId,
          text: submission.text,
          ...(images && images.length > 0 ? { images } : {}),
        });
        if (!accepted.accepted) throw new Error(accepted.message);
        if ((await ended) === "completed") return lastResult!;
        throw lastError;
      } finally {
        abortSignal.removeEventListener("abort", interrupt);
      }
    },
  };
}

/**
 * Answer the session's approval requests by asking through `channel`, here
 * the terminal prompt. The answer goes back as a command, as it would from
 * any other frontend. Returns a function that stops answering.
 */
export function answerApprovalsThrough(
  session: AgentSession,
  channel: ApprovalChannel,
): () => void {
  const open = new Map<string, AbortController>();
  return session.subscribe((event) => {
    if (event.type === "approval_resolved") {
      // Withdrawn while the question was showing: close the prompt.
      const asking = open.get(event.requestId);
      open.delete(event.requestId);
      asking?.abort();
      return;
    }
    if (event.type !== "approval_requested") return;
    const { request } = event;
    const asking = new AbortController();
    open.set(request.id, asking);
    const deny = (reason: string): ApprovalAnswer => ({
      requestId: request.id,
      decision: "deny",
      reason,
    });
    void channel
      .request(request, asking.signal)
      .catch((error: unknown) =>
        deny(
          `The approval prompt failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      )
      .then((answer) => {
        if (!open.delete(request.id)) return;
        const send = (chosen: ApprovalAnswer) =>
          session.dispatch({
            type: "answer_approval",
            commandId: randomUUID(),
            answer: chosen,
          });
        // An answer the session refuses must not leave the call waiting.
        if (!send(answer).accepted)
          send(deny("The approval prompt gave an answer that does not fit"));
      });
  });
}
