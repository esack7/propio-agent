import { ChatMessage } from "../providers/types.js";

export type ToolExecutionStatus =
  | "success"
  | "tool_not_found"
  | "tool_disabled"
  | "error";

export interface ToolExecutionResult {
  status: ToolExecutionStatus;
  content: string;
}

/**
 * ToolContext interface for dependency injection.
 *
 * Tools that need agent state receive a ToolContext instance rather than coupling
 * to the Agent class directly. This enables testing with mock contexts and maintains
 * separation of concerns.
 *
 * **Property Getter Pattern:**
 * The Agent creates ToolContext using JavaScript property getters, not static snapshots.
 * This ensures tools always read fresh values when they access context properties.
 *
 * Example implementation in Agent:
 * ```typescript
 * const toolContext: ToolContext = {
 *   get systemPrompt() { return this.systemPrompt; },
 *   get sessionContext() { return this.sessionContext; },
 *   get sessionContextFilePath() { return this.sessionContextFilePath; }
 * };
 * ```
 *
 * This pattern is critical because agent state can change after context creation:
 * - `clearContext()` reassigns sessionContext to empty array
 * - `setSystemPrompt()` updates systemPrompt
 *
 * Property getters ensure these changes propagate to tools that read context later.
 */
export interface ToolContext {
  /**
   * Current system prompt for the agent.
   * Use property getter to ensure fresh value after setSystemPrompt().
   */
  readonly systemPrompt: string;

  /**
   * Current session context messages (read-only view).
   * Use property getter to ensure fresh value after clearContext() or new messages.
   * Tools must not mutate this array or its elements.
   */
  readonly sessionContext: ReadonlyArray<Readonly<ChatMessage>>;

  /**
   * File path where session context is persisted.
   * Use property getter in case this becomes configurable in the future.
   */
  readonly sessionContextFilePath: string;
}
