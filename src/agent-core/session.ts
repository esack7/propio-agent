import type { ApprovalAnswer, ApprovalRequest } from "../policy/index.js";
import {
  parseSessionCommand,
  type CommandRejection,
  type CommandResult,
  type SessionCommand,
} from "./commands.js";
import type { GuidanceMessage, GuidanceSource } from "./events.js";
import type { PromptSubmission } from "./input.js";

/** What a running turn is handed by the session that started it. */
export interface SessionTurnControl<TEvent> {
  /** Aborted, with reason "interrupt", when an interrupt command arrives. */
  readonly abortSignal: AbortSignal;
  /** Guide commands accepted while the turn runs. */
  readonly guidance: GuidanceSource;
  /** Forward one of the turn's own events to the session's subscribers. */
  emit(event: TEvent): void;
}

/** Runs one turn to its final answer. Rejects if the turn fails or is cancelled. */
export type SessionTurnRunner<TEvent> = (
  submission: PromptSubmission,
  control: SessionTurnControl<TEvent>,
) => Promise<string>;

/** Events the session itself adds to the ones a turn emits. All plain JSON. */
export type SessionOwnEvent =
  | { readonly type: "session_turn_started"; readonly commandId: string }
  | {
      readonly type: "session_turn_ended";
      /** The submit command that started the turn. */
      readonly commandId: string;
      readonly outcome: "completed" | "cancelled" | "failed";
      /** The final answer of a completed turn. */
      readonly result?: string;
      readonly error?: { readonly name: string; readonly message: string };
      /** Guidance accepted but never given to the model. */
      readonly undelivered: readonly GuidanceMessage[];
    }
  | {
      readonly type: "guidance_queued";
      /** The guide command; the same id marks its delivery. */
      readonly id: string;
      readonly text: string;
    }
  | { readonly type: "approval_requested"; readonly request: ApprovalRequest }
  | {
      readonly type: "approval_resolved";
      readonly requestId: string;
      /** The decision given, or "withdrawn" if the question was dropped. */
      readonly resolution: ApprovalAnswer["decision"] | "withdrawn";
    };

export type SessionEvent<TEvent> = TEvent | SessionOwnEvent;

interface PendingApproval {
  resolve(answer: ApprovalAnswer): void;
  reject(error: Error): void;
}

interface RunningTurn {
  readonly commandId: string;
  readonly controller: AbortController;
  queue: GuidanceMessage[];
}

export interface AgentSessionOptions<TEvent> {
  readonly runTurn: SessionTurnRunner<TEvent>;
}

/**
 * One conversation, driven by commands and observed through events.
 *
 * The session reads no input and draws nothing. A terminal, a server, or a
 * test dispatches commands and subscribes to events; an approval is a
 * request event and a later answer command, whoever gives the answer. All
 * state is held by the instance.
 */
export class AgentSession<TEvent = never> {
  private readonly runTurn: SessionTurnRunner<TEvent>;
  private readonly listeners = new Set<(event: SessionEvent<TEvent>) => void>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private turn: RunningTurn | undefined;
  private turnSettled: Promise<void> = Promise.resolve();

  /**
   * Puts approval requests to this session's subscribers. Give it to
   * whatever authorizes tool calls; it matches the approval channel shape.
   */
  readonly approvalChannel = {
    request: (
      request: ApprovalRequest,
      signal?: AbortSignal,
    ): Promise<ApprovalAnswer> => this.requestApproval(request, signal),
  };

  constructor(options: AgentSessionOptions<TEvent>) {
    this.runTurn = options.runTurn;
  }

  get running(): boolean {
    return this.turn !== undefined;
  }

  /** Resolves when no turn is running. Never rejects. */
  settled(): Promise<void> {
    return this.turnSettled;
  }

  /** Listeners are trusted code: one that throws fails the turn it is called from. */
  subscribe(listener: (event: SessionEvent<TEvent>) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Apply a command. Returns at once: a submit starts the turn and its
   * outcome arrives as a `session_turn_ended` event.
   */
  dispatch(value: SessionCommand): CommandResult {
    const parsed = parseSessionCommand(value);
    if (!parsed.ok)
      return this.reject(parsed.commandId, "invalid", parsed.message);
    const command = parsed.command;
    switch (command.type) {
      case "submit":
        return this.submit(command);
      case "guide":
        return this.guide(command);
      case "interrupt":
        return this.interrupt(command.commandId);
      case "answer_approval":
        return this.answerApproval(command.commandId, command.answer);
    }
  }

  /**
   * Stop the running turn because the host is going away, not because the
   * operator asked. This is not a command: it is for the process that owns
   * the session, such as a CLI exiting or a server shutting down. The turn's
   * signal aborts with `reason`, so it is not recorded as an interrupt.
   * Returns false when no turn is running.
   */
  stop(reason: string): boolean {
    const turn = this.turn;
    if (!turn) return false;
    if (!turn.controller.signal.aborted) {
      turn.controller.abort(reason);
      this.withdrawApprovals("The session is stopping");
    }
    return true;
  }

  private reject(
    commandId: string,
    code: CommandRejection,
    message: string,
  ): CommandResult {
    return { commandId, accepted: false, code, message };
  }

  private emit(event: SessionEvent<TEvent>): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  private submit(
    command: Extract<SessionCommand, { type: "submit" }>,
  ): CommandResult {
    if (this.turn)
      return this.reject(
        command.commandId,
        "turn_running",
        "A turn is already running; guide or interrupt it instead",
      );
    const turn: RunningTurn = {
      commandId: command.commandId,
      controller: new AbortController(),
      queue: [],
    };
    this.turn = turn;
    const submission: PromptSubmission = {
      text: command.text,
      ...(command.images && command.images.length > 0
        ? { images: [...command.images] }
        : {}),
    };
    this.turnSettled = this.run(turn, submission);
    return { commandId: command.commandId, accepted: true };
  }

  private async run(
    turn: RunningTurn,
    submission: PromptSubmission,
  ): Promise<void> {
    let ended: Omit<
      Extract<SessionOwnEvent, { type: "session_turn_ended" }>,
      "type" | "commandId" | "undelivered"
    >;
    try {
      this.emit({ type: "session_turn_started", commandId: turn.commandId });
      const result = await this.runTurn(submission, {
        abortSignal: turn.controller.signal,
        guidance: {
          drain: () => {
            const waiting = turn.queue;
            turn.queue = [];
            return waiting;
          },
        },
        emit: (event) => this.emit(event),
      });
      ended = { outcome: "completed", result };
    } catch (error) {
      ended = {
        outcome: turn.controller.signal.aborted ? "cancelled" : "failed",
        error: {
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    this.turn = undefined;
    this.withdrawApprovals("The turn ended");
    try {
      this.emit({
        type: "session_turn_ended",
        commandId: turn.commandId,
        ...ended,
        undelivered: turn.queue,
      });
    } catch {
      // The turn is over; a listener failing now has nothing left to fail.
    }
  }

  private guide(
    command: Extract<SessionCommand, { type: "guide" }>,
  ): CommandResult {
    const turn = this.turn;
    if (!turn || turn.controller.signal.aborted)
      return this.reject(
        command.commandId,
        "no_turn",
        "No turn is running; submit the message instead",
      );
    turn.queue.push({ id: command.commandId, text: command.text });
    this.emit({
      type: "guidance_queued",
      id: command.commandId,
      text: command.text,
    });
    return { commandId: command.commandId, accepted: true };
  }

  private interrupt(commandId: string): CommandResult {
    const turn = this.turn;
    if (!turn) return this.reject(commandId, "no_turn", "No turn is running");
    if (!turn.controller.signal.aborted) {
      turn.controller.abort("interrupt");
      this.withdrawApprovals("The turn was interrupted");
    }
    return { commandId, accepted: true };
  }

  private answerApproval(
    commandId: string,
    answer: ApprovalAnswer,
  ): CommandResult {
    const pending = this.pendingApprovals.get(answer.requestId);
    if (!pending)
      return this.reject(
        commandId,
        "unknown_approval",
        `No approval request ${answer.requestId} is waiting`,
      );
    this.pendingApprovals.delete(answer.requestId);
    pending.resolve(answer);
    this.emit({
      type: "approval_resolved",
      requestId: answer.requestId,
      resolution: answer.decision,
    });
    return { commandId, accepted: true };
  }

  private requestApproval(
    request: ApprovalRequest,
    signal?: AbortSignal,
  ): Promise<ApprovalAnswer> {
    if (signal?.aborted)
      return Promise.reject(new Error("Approval request cancelled"));
    return new Promise<ApprovalAnswer>((resolve, reject) => {
      const onAbort = (): void => {
        if (!this.pendingApprovals.delete(request.id)) return;
        reject(new Error("Approval request cancelled"));
        this.emit({
          type: "approval_resolved",
          requestId: request.id,
          resolution: "withdrawn",
        });
      };
      this.pendingApprovals.set(request.id, {
        resolve: (answer) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(answer);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      this.emit({ type: "approval_requested", request });
    });
  }

  private withdrawApprovals(reason: string): void {
    for (const [requestId, pending] of [...this.pendingApprovals]) {
      this.pendingApprovals.delete(requestId);
      pending.reject(new Error(`Approval request cancelled: ${reason}`));
      try {
        this.emit({
          type: "approval_resolved",
          requestId,
          resolution: "withdrawn",
        });
      } catch {
        // Withdrawal must reach every pending request.
      }
    }
  }
}
