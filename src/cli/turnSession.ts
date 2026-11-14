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
  /**
   * Guidance the last turn accepted but never gave the model, oldest first.
   * Each call returns it once.
   */
  takeUndelivered(): string[];
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
  // The submission as the terminal produced it. The submit command carries
  // the same images as strings, but no string form keeps every adapter's
  // handling of bytes; in one process the originals are handed over as is.
  let original: PromptSubmission | undefined;
  let undelivered: string[] = [];
  const session = new AgentSession({
    runTurn: async (submission, control) => {
      const given = original ?? submission;
      original = undefined;
      try {
        lastResult = await streamAssistantTurn(
          agent,
          given,
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

  session.subscribe((event) => {
    if (event.type === "session_turn_started") undelivered = [];
    if (event.type === "session_turn_ended")
      undelivered = event.undelivered.map((message) => message.text);
  });

  return {
    session,
    takeUndelivered() {
      const taken = undelivered;
      undelivered = [];
      return taken;
    },
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
        original = {
          text: submission.text,
          ...(submission.images ? { images: submission.images } : {}),
        };
        const accepted = session.dispatch({
          type: "submit",
          commandId,
          text: submission.text,
          ...(images && images.length > 0 ? { images } : {}),
        });
        if (!accepted.accepted) {
          original = undefined;
          throw new Error(accepted.message);
        }
        if ((await ended) === "completed") return lastResult!;
        throw lastError;
      } finally {
        abortSignal.removeEventListener("abort", interrupt);
      }
    },
  };
}

/**
 * An approval channel that takes the keyboard and the screen from the line
 * being typed to the running turn, and gives them back when it has its
 * answer. The line's draft is kept meanwhile.
 */
export function borrowingKeyboard(
  channel: ApprovalChannel,
  typing: () => { suspend(): void; resume(): void } | null,
): ApprovalChannel {
  return {
    request: async (request, signal) => {
      const active = typing();
      active?.suspend();
      try {
        return await channel.request(request, signal);
      } finally {
        active?.resume();
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
