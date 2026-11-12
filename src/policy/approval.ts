import type { Capability } from "./capabilities.js";
import type { PolicyTarget } from "./rules.js";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JsonObject = { readonly [key: string]: JsonValue };

/** A grant the operator can pick instead of approving only this call. */
export interface GrantSuggestion {
  /** A rule in the settings syntax; send it back in the answer to choose it. */
  readonly rule: string;
  readonly scope: "exact" | "tool" | "server" | "capability";
  readonly description: string;
}

/**
 * A question for whoever may approve a call. It is plain JSON, so it can be
 * shown in a terminal, sent to a browser, or answered by another process.
 */
export interface ApprovalRequest {
  readonly id: string;
  readonly sessionId?: string;
  readonly toolCallId?: string;
  readonly toolName: string;
  readonly args: JsonObject;
  readonly capabilities: readonly Capability[];
  readonly target?: PolicyTarget;
  /** Why the call was not simply allowed: a rule or the mode default. */
  readonly reason: string;
  readonly rule: string;
  readonly suggestions: readonly GrantSuggestion[];
}

export type ApprovalAnswer =
  | { readonly requestId: string; readonly decision: "allow_once" }
  | {
      readonly requestId: string;
      readonly decision: "allow_session";
      readonly rule: string;
    }
  | {
      readonly requestId: string;
      readonly decision: "allow_always";
      readonly rule: string;
    }
  | {
      readonly requestId: string;
      readonly decision: "deny";
      /** Returned to the model so it can change course. */
      readonly reason?: string;
    };

export class ApprovalAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalAnswerError";
  }
}
