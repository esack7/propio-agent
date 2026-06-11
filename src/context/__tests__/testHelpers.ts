import { ContextManager } from "../contextManager.js";
import {
  serializeSession,
  parseSession,
  restoreConversationState,
} from "../persistence.js";
import type {
  ArtifactToolResult,
  ArtifactRecord,
  ConversationState,
  TurnRecord,
  TurnEntry,
  PinnedMemoryRecord,
  SessionMetadata,
} from "../types.js";
import { DEFAULT_BUDGET_POLICY, DEFAULT_SUMMARY_POLICY } from "../types.js";
import type { ChatMessage } from "@propio-ai/providers";
import type {
  PromptBuildRequest,
  PromptBudgetPolicy,
} from "../promptBuilder.js";
import { estimateTokens } from "../../diagnostics.js";

// ---------------------------------------------------------------------------
// ArtifactToolResult helpers
// ---------------------------------------------------------------------------

export function toolResult(
  toolCallId: string,
  toolName: string,
  rawContent: string | Uint8Array,
  status: "success" | "error" = "success",
  mediaType?: string,
): ArtifactToolResult {
  return { toolCallId, toolName, rawContent, status, mediaType };
}

// ---------------------------------------------------------------------------
// TurnRecord / TurnEntry builders (shared by promptBuilder, summaryManager)
// ---------------------------------------------------------------------------

export function makeTurn(opts: {
  id: string;
  userMessage: string;
  entries?: TurnEntry[];
  completedAt?: string;
  importance?: "low" | "normal" | "high";
}): TurnRecord {
  return {
    id: opts.id,
    startedAt: "2026-01-01T00:00:00Z",
    completedAt: opts.completedAt,
    importance: opts.importance ?? "normal",
    userMessage: { role: "user", content: opts.userMessage },
    entries: opts.entries ?? [],
  };
}

export function makeAssistantEntry(content: string): TurnEntry {
  return {
    kind: "assistant",
    createdAt: "2026-01-01T00:00:01Z",
    message: { role: "assistant", content },
  };
}

export function makeToolEntry(
  toolResults: Array<{
    toolCallId: string;
    toolName: string;
    content: string;
    artifactId: string;
  }>,
): TurnEntry {
  return {
    kind: "tool",
    createdAt: "2026-01-01T00:00:02Z",
    message: {
      role: "tool",
      content: "",
      toolResults: toolResults.map((tr) => ({
        toolCallId: tr.toolCallId,
        toolName: tr.toolName,
        content: tr.content,
      })),
    },
    toolInvocations: toolResults.map((tr) => ({
      toolCallId: tr.toolCallId,
      toolName: tr.toolName,
      status: "success" as const,
      resultSummary: tr.content,
      artifactId: tr.artifactId,
      mediaType: "text/plain",
      contentSizeChars: tr.content.length,
    })),
  };
}

export function makeArtifact(
  id: string,
  content: string,
  turnIds: string[] = [],
): ArtifactRecord {
  return {
    id,
    type: "tool_result",
    mediaType: "text/plain",
    createdAt: "2026-01-01T00:00:00Z",
    content,
    contentSizeChars: content.length,
    estimatedTokens: estimateTokens(content.length),
    referencingTurnIds: turnIds,
  };
}

export function makeState(opts?: {
  preamble?: ChatMessage[];
  turns?: TurnRecord[];
  artifacts?: ArtifactRecord[];
  pinnedMemory?: ReadonlyArray<PinnedMemoryRecord>;
}): ConversationState {
  return {
    preamble: opts?.preamble ?? [],
    turns: opts?.turns ?? [],
    artifacts: opts?.artifacts ?? [],
    pinnedMemory: opts?.pinnedMemory ?? [],
  };
}

export function expectThreeMessagePlanRoles(
  plan: { messages: Array<{ role: ChatMessage["role"] }> },
  secondRole: ChatMessage["role"],
): void {
  expect(plan.messages).toHaveLength(3);
  expect(plan.messages[0].role).toBe("system");
  expect(plan.messages[1].role).toBe(secondRole);
}

export function makeRequest(opts: {
  systemPrompt?: string;
  state?: ConversationState;
  contextWindowTokens?: number;
  policy?: PromptBudgetPolicy;
  extraUserInstruction?: string;
  rollingSummary?: string;
  summaryCoveredTurnIds?: ReadonlySet<string>;
  retryLevel?: number;
  artifacts?: Map<string, ArtifactRecord>;
  pinnedMemoryBlock?: string;
}): PromptBuildRequest {
  const artifacts = opts.artifacts ?? new Map();
  const state = opts.state ?? makeState();
  return {
    systemPrompt: opts.systemPrompt ?? "You are a helpful assistant.",
    pinnedMemoryBlock: opts.pinnedMemoryBlock,
    conversationState: state,
    contextWindowTokens: opts.contextWindowTokens ?? 128000,
    policy: opts.policy ?? DEFAULT_BUDGET_POLICY,
    extraUserInstruction: opts.extraUserInstruction,
    rollingSummary: opts.rollingSummary,
    summaryCoveredTurnIds: opts.summaryCoveredTurnIds,
    retryLevel: opts.retryLevel,
    artifactLookup: (id: string) => artifacts.get(id),
    isCurrentTurnUnresolved: (turnId: string) => {
      const turn = state.turns.find((t) => t.id === turnId);
      return turn != null && !turn.completedAt;
    },
  };
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

export const TEST_METADATA: SessionMetadata = {
  providerName: "test-provider",
  modelKey: "test-model",
  systemPrompt: "You are a test assistant.",
  promptBudgetPolicy: DEFAULT_BUDGET_POLICY,
  summaryPolicy: DEFAULT_SUMMARY_POLICY,
  contextWindowTokens: 128000,
};

export function buildPopulatedManager(): ContextManager {
  const manager = new ContextManager();
  manager.beginUserTurn("Read the config file");
  manager.commitAssistantResponse("Sure, reading now", [
    {
      id: "tc-1",
      function: { name: "read", arguments: { path: "config.json" } },
    },
  ]);
  manager.recordToolResults([
    toolResult("tc-1", "read", '{"key": "value", "port": 3000}'),
  ]);
  manager.commitAssistantResponse("The config has key=value and port=3000.");

  manager.beginUserTurn("List the project files");
  manager.commitAssistantResponse("Listing...", [
    { id: "tc-2", function: { name: "ls", arguments: { path: "." } } },
    { id: "tc-3", function: { name: "ls", arguments: { path: "src" } } },
  ]);
  manager.recordToolResults([
    toolResult("tc-2", "ls", "package.json\nsrc/\ntsconfig.json"),
    toolResult("tc-3", "ls", "index.ts\nagent.ts"),
  ]);
  manager.commitAssistantResponse("Found 5 files across root and src.");
  return manager;
}

export function roundTrip(manager: ContextManager): ConversationState {
  const state = manager.getConversationState();
  const json = serializeSession(state, TEST_METADATA);
  const parsed = parseSession(json);
  return restoreConversationState(parsed);
}

export function roundTripState(state: ConversationState): ConversationState {
  const json = serializeSession(state, TEST_METADATA);
  const parsed = parseSession(json);
  return restoreConversationState(parsed);
}

// ---------------------------------------------------------------------------
// ContextManager builder
// ---------------------------------------------------------------------------

export class ContextManagerTestBuilder {
  private readonly manager: ContextManager;

  constructor(manager?: ContextManager) {
    this.manager = manager ?? new ContextManager();
  }

  createCompletedTurn(userMsg: string, assistantMsg: string): this {
    this.manager.beginUserTurn(userMsg);
    this.manager.commitAssistantResponse(assistantMsg);
    return this;
  }

  createToolCallTurn(
    userMsg: string,
    toolCallId: string,
    toolName: string,
    toolResultContent: string,
  ): this {
    this.manager.beginUserTurn(userMsg);
    this.manager.commitAssistantResponse("", [
      { id: toolCallId, function: { name: toolName, arguments: {} } },
    ]);
    this.manager.recordToolResults([
      toolResult(toolCallId, toolName, toolResultContent),
    ]);
    return this;
  }

  assertArtifactProperties(
    artifact: { type?: string; mediaType?: string; content?: string },
    expected: { type?: string; mediaType?: string; content?: string },
  ): void {
    if (expected.type !== undefined) expect(artifact.type).toBe(expected.type);
    if (expected.mediaType !== undefined)
      expect(artifact.mediaType).toBe(expected.mediaType);
    if (expected.content !== undefined)
      expect(artifact.content).toBe(expected.content);
  }

  getManager(): ContextManager {
    return this.manager;
  }
}
