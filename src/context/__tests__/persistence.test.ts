import { ContextManager } from "../contextManager.js";
import {
  serializeSession,
  parseSession,
  restoreConversationState,
  SessionParseError,
  SessionMetadata,
  PersistedSessionV1,
} from "../persistence.js";
import {
  ArtifactToolResult,
  RollingSummaryRecord,
  DEFAULT_BUDGET_POLICY,
  DEFAULT_SUMMARY_POLICY,
  ConversationState,
  PinnedMemoryRecord,
} from "../types.js";
import { Buffer } from "buffer";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toolResult(
  toolCallId: string,
  toolName: string,
  rawContent: string | Uint8Array,
  status: "success" | "error" = "success",
  mediaType?: string,
): ArtifactToolResult {
  return { toolCallId, toolName, rawContent, status, mediaType };
}

const TEST_METADATA: SessionMetadata = {
  providerName: "test-provider",
  modelKey: "test-model",
  systemPrompt: "You are a test assistant.",
  promptBudgetPolicy: DEFAULT_BUDGET_POLICY,
  summaryPolicy: DEFAULT_SUMMARY_POLICY,
  contextWindowTokens: 128000,
};

function buildPopulatedManager(): ContextManager {
  const manager = new ContextManager();

  // Turn 1: completed with text tool artifact
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

  // Turn 2: completed with multiple tool calls
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

function roundTrip(manager: ContextManager): ConversationState {
  const state = manager.getConversationState();
  const json = serializeSession(state, TEST_METADATA);
  const parsed = parseSession(json);
  return restoreConversationState(parsed);
}

function roundTripState(state: ConversationState): ConversationState {
  const json = serializeSession(state, TEST_METADATA);
  const parsed = parseSession(json);
  return restoreConversationState(parsed);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("persistence", () => {
  // =================================================================
  // Round-trip: serialize → parse → restore
  // =================================================================

  describe("round-trip", () => {
    it("should round-trip a session with multiple completed turns", () => {
      const manager = buildPopulatedManager();
      const original = manager.getConversationState();
      const restored = roundTrip(manager);

      expect(restored.turns).toHaveLength(original.turns.length);
      expect(restored.preamble).toHaveLength(original.preamble.length);

      for (let i = 0; i < original.turns.length; i++) {
        expect(restored.turns[i].id).toBe(original.turns[i].id);
        expect(restored.turns[i].startedAt).toBe(original.turns[i].startedAt);
        expect(restored.turns[i].completedAt).toBe(
          original.turns[i].completedAt,
        );
        expect(restored.turns[i].importance).toBe(original.turns[i].importance);
        expect(restored.turns[i].userMessage.content).toBe(
          original.turns[i].userMessage.content,
        );
        expect(restored.turns[i].entries).toHaveLength(
          original.turns[i].entries.length,
        );
      }
    });

    it("should round-trip an unfinished current turn", () => {
      const manager = buildPopulatedManager();

      // Add an in-progress turn
      manager.beginUserTurn("Still working");
      manager.commitAssistantResponse("Let me check", [
        { id: "tc-x", function: { name: "search", arguments: { q: "test" } } },
      ]);
      manager.recordToolResults([
        toolResult("tc-x", "search", "search results here"),
      ]);

      const original = manager.getConversationState();
      const restored = roundTrip(manager);

      expect(restored.turns).toHaveLength(3);
      const lastTurn = restored.turns[2];
      expect(lastTurn.completedAt).toBeUndefined();
      expect(lastTurn.userMessage.content).toBe("Still working");
      expect(lastTurn.entries).toHaveLength(2);
    });

    it("should round-trip rolling summary", () => {
      const manager = buildPopulatedManager();
      const state = manager.getConversationState();

      const summary: RollingSummaryRecord = {
        content: "User worked on project configuration and file listing.",
        updatedAt: "2026-03-28T12:00:00Z",
        coveredTurnIds: [state.turns[0].id],
        estimatedTokens: 15,
      };
      manager.setRollingSummary(summary);

      const restored = roundTrip(manager);

      expect(restored.rollingSummary).toBeDefined();
      expect(restored.rollingSummary!.content).toBe(summary.content);
      expect(restored.rollingSummary!.updatedAt).toBe(summary.updatedAt);
      expect(restored.rollingSummary!.coveredTurnIds).toEqual(
        summary.coveredTurnIds,
      );
      expect(restored.rollingSummary!.estimatedTokens).toBe(
        summary.estimatedTokens,
      );
    });

    it("should round-trip invoked skills and keep them active in prompt assembly", () => {
      const manager = new ContextManager();
      manager.recordInvokedSkill({
        name: "review",
        source: "project",
        skillRoot: "/repo/.propio/skills/review",
        skillFile: "/repo/.propio/skills/review/SKILL.md",
        arguments: "src/foo.ts",
        content: "Skill body for review.",
        invokedAt: "2026-03-28T12:00:00Z",
        scope: {
          invocationSource: "user",
          skillName: "review",
          skillRoot: "/repo/.propio/skills/review",
          skillFile: "/repo/.propio/skills/review/SKILL.md",
          allowedTools: ["read"],
          warnings: ["Recorded for persistence testing."],
        },
      });

      const restored = roundTrip(manager);

      expect(restored.invokedSkills).toHaveLength(1);
      const restoredInvokedSkills = restored.invokedSkills ?? [];
      expect(restoredInvokedSkills[0].scope.allowedTools).toEqual(["read"]);
      expect(restoredInvokedSkills[0].scope.warnings).toEqual([
        "Recorded for persistence testing.",
      ]);

      const target = new ContextManager();
      target.importState(restored);

      const plan = target.buildPromptPlan("System prompt");
      expect(plan.messages[0].content).toContain("Skill body for review.");
    });

    it("should round-trip text tool artifacts", () => {
      const manager = buildPopulatedManager();
      const original = manager.getConversationState();
      const restored = roundTrip(manager);

      expect(restored.artifacts).toHaveLength(original.artifacts.length);

      for (let i = 0; i < original.artifacts.length; i++) {
        expect(restored.artifacts[i].id).toBe(original.artifacts[i].id);
        expect(restored.artifacts[i].type).toBe(original.artifacts[i].type);
        expect(restored.artifacts[i].mediaType).toBe(
          original.artifacts[i].mediaType,
        );
        expect(restored.artifacts[i].content).toBe(
          original.artifacts[i].content,
        );
        expect(restored.artifacts[i].contentSizeChars).toBe(
          original.artifacts[i].contentSizeChars,
        );
        expect(restored.artifacts[i].referencingTurnIds).toEqual(
          original.artifacts[i].referencingTurnIds,
        );
      }
    });

    it("should round-trip binary artifacts", () => {
      const manager = new ContextManager();
      const binaryData = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);

      manager.beginUserTurn("Get the image");
      manager.commitAssistantResponse("", [
        { id: "tc-1", function: { name: "read_image", arguments: {} } },
      ]);
      manager.recordToolResults([
        toolResult("tc-1", "read_image", binaryData, "success", "image/png"),
      ]);
      manager.commitAssistantResponse("Here is the image.");

      const original = manager.getConversationState();
      const restored = roundTrip(manager);

      expect(restored.artifacts).toHaveLength(1);
      const artifact = restored.artifacts[0];
      expect(artifact.content).toBeInstanceOf(Uint8Array);
      expect(artifact.content).toEqual(original.artifacts[0].content);
      expect(artifact.mediaType).toBe("image/png");
      expect(artifact.contentSizeChars).toBe(binaryData.byteLength);
    });

    it("should preserve getSnapshot() output through round-trip import", () => {
      const manager = buildPopulatedManager();
      const originalSnapshot = manager.getSnapshot();

      const state = manager.getConversationState();
      const json = serializeSession(state, TEST_METADATA);
      const parsed = parseSession(json);
      const restored = restoreConversationState(parsed);

      const importManager = new ContextManager();
      importManager.importState(restored);
      const restoredSnapshot = importManager.getSnapshot();

      expect(restoredSnapshot).toHaveLength(originalSnapshot.length);
      for (let i = 0; i < originalSnapshot.length; i++) {
        expect(restoredSnapshot[i].role).toBe(originalSnapshot[i].role);
        expect(restoredSnapshot[i].content).toBe(originalSnapshot[i].content);
      }
    });

    it("should preserve artifact references and IDs through import", () => {
      const manager = buildPopulatedManager();
      const original = manager.getConversationState();

      const importManager = new ContextManager();
      importManager.importState(roundTrip(manager));
      const imported = importManager.getConversationState();

      for (let i = 0; i < original.artifacts.length; i++) {
        expect(imported.artifacts[i].id).toBe(original.artifacts[i].id);
      }

      for (let t = 0; t < original.turns.length; t++) {
        for (let e = 0; e < original.turns[t].entries.length; e++) {
          const origEntry = original.turns[t].entries[e];
          const impEntry = imported.turns[t].entries[e];
          if (origEntry.kind === "tool" && impEntry.kind === "tool") {
            for (let inv = 0; inv < origEntry.toolInvocations.length; inv++) {
              expect(impEntry.toolInvocations[inv].artifactId).toBe(
                origEntry.toolInvocations[inv].artifactId,
              );
            }
          }
        }
      }
    });

    it("should preserve token estimate fields through round-trip", () => {
      const manager = buildPopulatedManager();
      const original = manager.getConversationState();
      const restored = roundTrip(manager);

      for (let i = 0; i < original.turns.length; i++) {
        expect(restored.turns[i].estimatedTokens).toBe(
          original.turns[i].estimatedTokens,
        );
        for (let e = 0; e < original.turns[i].entries.length; e++) {
          expect(restored.turns[i].entries[e].estimatedTokens).toBe(
            original.turns[i].entries[e].estimatedTokens,
          );
        }
      }

      for (let i = 0; i < original.artifacts.length; i++) {
        expect(restored.artifacts[i].estimatedTokens).toBe(
          original.artifacts[i].estimatedTokens,
        );
      }
    });
  });

  // =================================================================
  // Metadata
  // =================================================================

  describe("metadata", () => {
    it("should include version 3 in the serialized output", () => {
      const manager = new ContextManager();
      const state = manager.getConversationState();
      const json = serializeSession(state, TEST_METADATA);
      const parsed = parseSession(json);
      expect(parsed.version).toBe(3);
    });

    it("should include savedAt timestamp", () => {
      const manager = new ContextManager();
      const state = manager.getConversationState();
      const json = serializeSession(state, TEST_METADATA);
      const parsed = parseSession(json);
      expect(typeof parsed.savedAt).toBe("string");
      expect(new Date(parsed.savedAt).getTime()).not.toBeNaN();
    });

    it("should preserve runtime metadata", () => {
      const manager = new ContextManager();
      const state = manager.getConversationState();
      const json = serializeSession(state, TEST_METADATA);
      const parsed = parseSession(json);

      expect(parsed.metadata.providerName).toBe("test-provider");
      expect(parsed.metadata.modelKey).toBe("test-model");
      expect(parsed.metadata.systemPrompt).toBe("You are a test assistant.");
      expect(parsed.metadata.contextWindowTokens).toBe(128000);
      expect(parsed.metadata.promptBudgetPolicy).toEqual(DEFAULT_BUDGET_POLICY);
      expect(parsed.metadata.summaryPolicy).toEqual(DEFAULT_SUMMARY_POLICY);
    });
  });

  describe("version 2 pinned memory", () => {
    it("should round-trip pinned memory records through serialize → parse → restore", () => {
      const records: PinnedMemoryRecord[] = [
        {
          id: "pm-a",
          kind: "fact",
          scope: "session",
          content: "Alpha",
          source: { origin: "assistant", turnId: "t1" },
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T01:00:00Z",
          lifecycle: "active",
        },
        {
          id: "pm-b",
          kind: "constraint",
          scope: "project",
          content: "Beta",
          source: { origin: "tool", toolCallId: "tc-9" },
          createdAt: "2026-01-02T00:00:00Z",
          updatedAt: "2026-01-02T00:00:00Z",
          lifecycle: "superseded",
          supersededById: "pm-a",
          rationale: "replaced by newer fact",
        },
      ];

      const state: ConversationState = {
        preamble: [],
        turns: [],
        artifacts: [],
        pinnedMemory: records,
      };

      const restored = roundTripState(state);
      expect(restored.pinnedMemory).toHaveLength(2);
      expect(restored.pinnedMemory[0]).toEqual(records[0]);
      expect(restored.pinnedMemory[1]).toEqual(records[1]);
    });

    it("should preserve lifecycle states (active, superseded, removed)", () => {
      const records: PinnedMemoryRecord[] = [
        {
          id: "l1",
          kind: "fact",
          scope: "session",
          content: "active",
          source: { origin: "user" },
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          lifecycle: "active",
        },
        {
          id: "l2",
          kind: "decision",
          scope: "session",
          content: "superseded",
          source: { origin: "assistant" },
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          lifecycle: "superseded",
          supersededById: "l1",
        },
        {
          id: "l3",
          kind: "constraint",
          scope: "project",
          content: "removed",
          source: { origin: "application" },
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          lifecycle: "removed",
        },
      ];

      const state: ConversationState = {
        preamble: [],
        turns: [],
        artifacts: [],
        pinnedMemory: records,
      };

      const restored = roundTripState(state);
      expect(restored.pinnedMemory.map((r) => r.lifecycle)).toEqual([
        "active",
        "superseded",
        "removed",
      ]);
    });

    it("should preserve source metadata (origin, turnId, toolCallId)", () => {
      const record: PinnedMemoryRecord = {
        id: "src-1",
        kind: "fact",
        scope: "session",
        content: "with source",
        source: {
          origin: "tool",
          turnId: "turn-42",
          toolCallId: "call-99",
        },
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        lifecycle: "active",
      };

      const state: ConversationState = {
        preamble: [],
        turns: [],
        artifacts: [],
        pinnedMemory: [record],
      };

      const restored = roundTripState(state);
      expect(restored.pinnedMemory[0].source).toEqual(record.source);
    });

    it("should preserve rationale and supersededById", () => {
      const record: PinnedMemoryRecord = {
        id: "r1",
        kind: "decision",
        scope: "project",
        content: "pick option A",
        source: { origin: "user", turnId: "t-7" },
        rationale: "user confirmed budget",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
        lifecycle: "superseded",
        supersededById: "r2",
      };

      const state: ConversationState = {
        preamble: [],
        turns: [],
        artifacts: [],
        pinnedMemory: [record],
      };

      const restored = roundTripState(state);
      expect(restored.pinnedMemory[0].rationale).toBe("user confirmed budget");
      expect(restored.pinnedMemory[0].supersededById).toBe("r2");
    });
  });

  describe("version 2 pinned memory validation", () => {
    function v2Session(pinnedMemory: unknown[]): string {
      return JSON.stringify({
        version: 2,
        savedAt: "2026-01-01T00:00:00Z",
        metadata: TEST_METADATA,
        context: {
          preamble: [],
          turns: [],
          artifacts: [],
          pinnedMemory,
        },
      });
    }

    function validRecord(
      overrides: Record<string, unknown> = {},
    ): Record<string, unknown> {
      return {
        id: "pm-1",
        kind: "fact",
        scope: "session",
        content: "test",
        source: { origin: "user" },
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        lifecycle: "active",
        ...overrides,
      };
    }

    it("should reject non-string source.turnId", () => {
      const record = validRecord({
        source: { origin: "user", turnId: 42 },
      });
      expect(() => parseSession(v2Session([record]))).toThrow(
        SessionParseError,
      );
      expect(() => parseSession(v2Session([record]))).toThrow("turnId");
    });

    it("should reject non-string source.toolCallId", () => {
      const record = validRecord({
        source: { origin: "tool", toolCallId: true },
      });
      expect(() => parseSession(v2Session([record]))).toThrow(
        SessionParseError,
      );
      expect(() => parseSession(v2Session([record]))).toThrow("toolCallId");
    });

    it("should reject non-string rationale", () => {
      const record = validRecord({ rationale: 123 });
      expect(() => parseSession(v2Session([record]))).toThrow(
        SessionParseError,
      );
      expect(() => parseSession(v2Session([record]))).toThrow("rationale");
    });

    it("should reject non-string supersededById", () => {
      const record = validRecord({
        lifecycle: "superseded",
        supersededById: 99,
      });
      expect(() => parseSession(v2Session([record]))).toThrow(
        SessionParseError,
      );
      expect(() => parseSession(v2Session([record]))).toThrow("supersededById");
    });

    it("should reject superseded lifecycle without supersededById", () => {
      const record = validRecord({ lifecycle: "superseded" });
      expect(() => parseSession(v2Session([record]))).toThrow(
        SessionParseError,
      );
      expect(() => parseSession(v2Session([record]))).toThrow("supersededById");
    });

    it("should accept superseded record with valid supersededById", () => {
      const record = validRecord({
        lifecycle: "superseded",
        supersededById: "pm-2",
      });
      expect(() => parseSession(v2Session([record]))).not.toThrow();
    });

    it("should accept valid optional string source.turnId and toolCallId", () => {
      const record = validRecord({
        source: { origin: "tool", turnId: "t-1", toolCallId: "tc-1" },
      });
      expect(() => parseSession(v2Session([record]))).not.toThrow();
    });

    it("should accept valid optional rationale", () => {
      const record = validRecord({ rationale: "good reason" });
      expect(() => parseSession(v2Session([record]))).not.toThrow();
    });
  });

  describe("version 1 backward compatibility", () => {
    it("should parse a valid v1 session JSON successfully", () => {
      const data: PersistedSessionV1 = {
        version: 1,
        savedAt: "2026-01-01T00:00:00Z",
        metadata: TEST_METADATA,
        context: {
          preamble: [],
          turns: [],
          artifacts: [],
        },
      };
      const parsed = parseSession(JSON.stringify(data));
      expect(parsed.version).toBe(1);
    });

    it("should restore empty pinnedMemory from v1 sessions", () => {
      const data: PersistedSessionV1 = {
        version: 1,
        savedAt: "2026-01-01T00:00:00Z",
        metadata: TEST_METADATA,
        context: {
          preamble: [],
          turns: [],
          artifacts: [],
        },
      };
      const parsed = parseSession(JSON.stringify(data));
      const restored = restoreConversationState(parsed);
      expect(restored.pinnedMemory).toEqual([]);
    });
  });

  // =================================================================
  // Artifact encoding
  // =================================================================

  describe("artifact encoding", () => {
    it("should encode text artifacts with contentEncoding utf8", () => {
      const manager = new ContextManager();
      manager.beginUserTurn("Read it");
      manager.commitAssistantResponse("", [
        { id: "tc-1", function: { name: "t", arguments: {} } },
      ]);
      manager.recordToolResults([toolResult("tc-1", "t", "hello world")]);
      manager.commitAssistantResponse("Done");

      const state = manager.getConversationState();
      const json = serializeSession(state, TEST_METADATA);
      const parsed = parseSession(json);

      expect(parsed.context.artifacts[0].contentEncoding).toBe("utf8");
      expect(parsed.context.artifacts[0].content).toBe("hello world");
    });

    it("should encode binary artifacts with contentEncoding base64", () => {
      const manager = new ContextManager();
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      manager.beginUserTurn("Get binary");
      manager.commitAssistantResponse("", [
        { id: "tc-1", function: { name: "t", arguments: {} } },
      ]);
      manager.recordToolResults([
        toolResult("tc-1", "t", data, "success", "application/octet-stream"),
      ]);
      manager.commitAssistantResponse("Done");

      const state = manager.getConversationState();
      const json = serializeSession(state, TEST_METADATA);
      const parsed = parseSession(json);

      expect(parsed.context.artifacts[0].contentEncoding).toBe("base64");
      expect(parsed.context.artifacts[0].content).toBe(
        Buffer.from(data).toString("base64"),
      );
    });

    it("should restore binary artifacts to Uint8Array", () => {
      const manager = new ContextManager();
      const data = new Uint8Array([10, 20, 30, 40, 50]);
      manager.beginUserTurn("Get data");
      manager.commitAssistantResponse("", [
        { id: "tc-1", function: { name: "t", arguments: {} } },
      ]);
      manager.recordToolResults([
        toolResult("tc-1", "t", data, "success", "application/octet-stream"),
      ]);
      manager.commitAssistantResponse("Done");

      const restored = roundTrip(manager);
      expect(restored.artifacts[0].content).toBeInstanceOf(Uint8Array);
      expect(restored.artifacts[0].content).toEqual(data);
    });
  });

  // =================================================================
  // Import replaces state (no merge)
  // =================================================================

  describe("import replaces state", () => {
    it("should replace prior in-memory state cleanly", () => {
      const manager = new ContextManager();

      // Initial state
      manager.beginUserTurn("Old message");
      manager.commitAssistantResponse("Old reply");

      const originalCount = manager.messageCount;
      expect(originalCount).toBe(2);

      // Build state to import
      const importManager = buildPopulatedManager();
      const state = importManager.getConversationState();

      // Import replaces everything
      manager.importState(state);

      expect(manager.messageCount).not.toBe(originalCount);
      const snapshot = manager.getSnapshot();
      expect(snapshot[0].content).toBe("Read the config file");
    });

    it("should clear artifacts from prior state on import", () => {
      const manager = new ContextManager();
      manager.beginUserTurn("Task");
      manager.commitAssistantResponse("", [
        { id: "tc-1", function: { name: "t", arguments: {} } },
      ]);
      manager.recordToolResults([toolResult("tc-1", "t", "old artifact")]);

      const priorArtifacts = manager.getConversationState().artifacts;
      expect(priorArtifacts).toHaveLength(1);

      const freshManager = new ContextManager();
      freshManager.beginUserTurn("Fresh");
      freshManager.commitAssistantResponse("Reply");

      manager.importState(freshManager.getConversationState());

      expect(manager.getConversationState().artifacts).toEqual([]);
    });

    it("should clear rolling summary from prior state on import", () => {
      const manager = new ContextManager();
      manager.setRollingSummary({
        content: "Old summary",
        updatedAt: "2026-01-01T00:00:00Z",
        coveredTurnIds: ["old-1"],
        estimatedTokens: 5,
      });

      const freshManager = new ContextManager();
      freshManager.beginUserTurn("New");
      freshManager.commitAssistantResponse("Reply");

      manager.importState(freshManager.getConversationState());

      expect(manager.getRollingSummary()).toBeUndefined();
    });

    it("should deep-clone imported state so external mutations do not affect internal state", () => {
      const manager = new ContextManager();
      const source = buildPopulatedManager();
      const state = source.getConversationState();

      manager.importState(state);

      // Mutate the source state
      (state.turns[0] as any).importance = "high";
      (state.artifacts[0] as any).content = "MUTATED";

      const internal = manager.getConversationState();
      expect(internal.turns[0].importance).toBe("normal");
      expect(internal.artifacts[0].content).not.toBe("MUTATED");
    });
  });

  // =================================================================
  // Rejection: invalid inputs
  // =================================================================

  describe("parseSession rejection", () => {
    it("should reject non-JSON input", () => {
      expect(() => parseSession("not json at all")).toThrow(SessionParseError);
      expect(() => parseSession("not json at all")).toThrow("Invalid JSON");
    });

    it("should reject unknown schema version", () => {
      const data = {
        version: 99,
        savedAt: "2026-01-01T00:00:00Z",
        metadata: TEST_METADATA,
        context: { preamble: [], turns: [], artifacts: [] },
      };
      expect(() => parseSession(JSON.stringify(data))).toThrow(
        SessionParseError,
      );
      expect(() => parseSession(JSON.stringify(data))).toThrow(
        "Unsupported session version: 99. Supported versions: 1, 2, 3.",
      );
    });

    it("should reject missing version field", () => {
      const data = {
        savedAt: "2026-01-01T00:00:00Z",
        metadata: TEST_METADATA,
        context: { preamble: [], turns: [], artifacts: [] },
      };
      expect(() => parseSession(JSON.stringify(data))).toThrow(
        SessionParseError,
      );
      expect(() => parseSession(JSON.stringify(data))).toThrow(
        "Unsupported session version",
      );
    });

    it("should reject missing required metadata fields", () => {
      const data = {
        version: 1,
        savedAt: "2026-01-01T00:00:00Z",
        metadata: { providerName: "test" },
        context: { preamble: [], turns: [], artifacts: [] },
      };
      expect(() => parseSession(JSON.stringify(data))).toThrow(
        SessionParseError,
      );
    });

    it("should reject missing context field", () => {
      const data = {
        version: 1,
        savedAt: "2026-01-01T00:00:00Z",
        metadata: TEST_METADATA,
      };
      expect(() => parseSession(JSON.stringify(data))).toThrow(
        SessionParseError,
      );
    });

    it("should reject when turns is not an array", () => {
      const data = {
        version: 1,
        savedAt: "2026-01-01T00:00:00Z",
        metadata: TEST_METADATA,
        context: { preamble: [], turns: "not-an-array", artifacts: [] },
      };
      expect(() => parseSession(JSON.stringify(data))).toThrow(
        SessionParseError,
      );
      expect(() => parseSession(JSON.stringify(data))).toThrow(
        "must be an array",
      );
    });

    it("should reject a turn with missing id", () => {
      const data = {
        version: 1,
        savedAt: "2026-01-01T00:00:00Z",
        metadata: TEST_METADATA,
        context: {
          preamble: [],
          turns: [
            {
              startedAt: "2026-01-01T00:00:00Z",
              importance: "normal",
              userMessage: { role: "user", content: "hi" },
              entries: [],
            },
          ],
          artifacts: [],
        },
      };
      expect(() => parseSession(JSON.stringify(data))).toThrow(
        SessionParseError,
      );
      expect(() => parseSession(JSON.stringify(data))).toThrow("id");
    });

    it("should reject an entry with invalid kind", () => {
      const data = {
        version: 1,
        savedAt: "2026-01-01T00:00:00Z",
        metadata: TEST_METADATA,
        context: {
          preamble: [],
          turns: [
            {
              id: "t1",
              startedAt: "2026-01-01T00:00:00Z",
              importance: "normal",
              userMessage: { role: "user", content: "hi" },
              entries: [
                {
                  kind: "unknown",
                  createdAt: "2026-01-01T00:00:00Z",
                  message: { role: "assistant", content: "test" },
                },
              ],
            },
          ],
          artifacts: [],
        },
      };
      expect(() => parseSession(JSON.stringify(data))).toThrow(
        SessionParseError,
      );
      expect(() => parseSession(JSON.stringify(data))).toThrow("kind");
    });

    it("should reject a tool entry missing toolInvocations", () => {
      const data = {
        version: 1,
        savedAt: "2026-01-01T00:00:00Z",
        metadata: TEST_METADATA,
        context: {
          preamble: [],
          turns: [
            {
              id: "t1",
              startedAt: "2026-01-01T00:00:00Z",
              importance: "normal",
              userMessage: { role: "user", content: "hi" },
              entries: [
                {
                  kind: "tool",
                  createdAt: "2026-01-01T00:00:00Z",
                  message: { role: "tool", content: "", toolResults: [] },
                },
              ],
            },
          ],
          artifacts: [],
        },
      };
      expect(() => parseSession(JSON.stringify(data))).toThrow(
        SessionParseError,
      );
      expect(() => parseSession(JSON.stringify(data))).toThrow(
        "missing required toolInvocations",
      );
    });

    it("should reject a tool entry whose message role is not tool", () => {
      const data = {
        version: 1,
        savedAt: "2026-01-01T00:00:00Z",
        metadata: TEST_METADATA,
        context: {
          preamble: [],
          turns: [
            {
              id: "t1",
              startedAt: "2026-01-01T00:00:00Z",
              importance: "normal",
              userMessage: { role: "user", content: "hi" },
              entries: [
                {
                  kind: "tool",
                  createdAt: "2026-01-01T00:00:00Z",
                  message: { role: "assistant", content: "oops" },
                  toolInvocations: [],
                },
              ],
            },
          ],
          artifacts: [],
        },
      };
      expect(() => parseSession(JSON.stringify(data))).toThrow(
        SessionParseError,
      );
      expect(() => parseSession(JSON.stringify(data))).toThrow(
        'kind "tool" but message.role is "assistant"',
      );
    });

    it("should reject an assistant entry whose message role is not assistant", () => {
      const data = {
        version: 1,
        savedAt: "2026-01-01T00:00:00Z",
        metadata: TEST_METADATA,
        context: {
          preamble: [],
          turns: [
            {
              id: "t1",
              startedAt: "2026-01-01T00:00:00Z",
              importance: "normal",
              userMessage: { role: "user", content: "hi" },
              entries: [
                {
                  kind: "assistant",
                  createdAt: "2026-01-01T00:00:00Z",
                  message: { role: "tool", content: "" },
                },
              ],
            },
          ],
          artifacts: [],
        },
      };
      expect(() => parseSession(JSON.stringify(data))).toThrow(
        SessionParseError,
      );
      expect(() => parseSession(JSON.stringify(data))).toThrow(
        'kind "assistant" but message.role is "tool"',
      );
    });

    it("should reject a toolCall missing function property", () => {
      const data = {
        version: 1,
        savedAt: "2026-01-01T00:00:00Z",
        metadata: TEST_METADATA,
        context: {
          preamble: [
            {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "tc1" }],
            },
          ],
          turns: [],
          artifacts: [],
        },
      };
      expect(() => parseSession(JSON.stringify(data))).toThrow(
        SessionParseError,
      );
      expect(() => parseSession(JSON.stringify(data))).toThrow("function");
    });

    it("should reject a toolCall with missing function.name", () => {
      const data = {
        version: 1,
        savedAt: "2026-01-01T00:00:00Z",
        metadata: TEST_METADATA,
        context: {
          preamble: [
            {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "tc1", function: { arguments: {} } }],
            },
          ],
          turns: [],
          artifacts: [],
        },
      };
      expect(() => parseSession(JSON.stringify(data))).toThrow(
        SessionParseError,
      );
      expect(() => parseSession(JSON.stringify(data))).toThrow("function.name");
    });

    it("should reject a toolResult with missing fields", () => {
      const data = {
        version: 1,
        savedAt: "2026-01-01T00:00:00Z",
        metadata: TEST_METADATA,
        context: {
          preamble: [
            {
              role: "tool",
              content: "",
              toolResults: [{ toolCallId: "tc1" }],
            },
          ],
          turns: [],
          artifacts: [],
        },
      };
      expect(() => parseSession(JSON.stringify(data))).toThrow(
        SessionParseError,
      );
      expect(() => parseSession(JSON.stringify(data))).toThrow("toolName");
    });

    it("should reject invalid base64 in artifact content", () => {
      const data = {
        version: 1,
        savedAt: "2026-01-01T00:00:00Z",
        metadata: TEST_METADATA,
        context: {
          preamble: [],
          turns: [],
          artifacts: [
            {
              id: "a1",
              type: "tool_result",
              mediaType: "application/octet-stream",
              createdAt: "2026-01-01T00:00:00Z",
              content: "not-valid-base64!!!",
              contentEncoding: "base64",
              contentSizeChars: 10,
              referencingTurnIds: [],
            },
          ],
        },
      };
      expect(() => parseSession(JSON.stringify(data))).toThrow(
        SessionParseError,
      );
      expect(() => parseSession(JSON.stringify(data))).toThrow("base64");
    });

    it("should reject artifact with invalid contentEncoding value", () => {
      const data = {
        version: 1,
        savedAt: "2026-01-01T00:00:00Z",
        metadata: TEST_METADATA,
        context: {
          preamble: [],
          turns: [],
          artifacts: [
            {
              id: "a1",
              type: "tool_result",
              mediaType: "text/plain",
              createdAt: "2026-01-01T00:00:00Z",
              content: "hello",
              contentEncoding: "binary",
              contentSizeChars: 5,
              referencingTurnIds: [],
            },
          ],
        },
      };
      expect(() => parseSession(JSON.stringify(data))).toThrow(
        SessionParseError,
      );
      expect(() => parseSession(JSON.stringify(data))).toThrow(
        "contentEncoding",
      );
    });

    it("should reject a message with invalid role", () => {
      const data = {
        version: 1,
        savedAt: "2026-01-01T00:00:00Z",
        metadata: TEST_METADATA,
        context: {
          preamble: [{ role: "narrator", content: "Once upon a time" }],
          turns: [],
          artifacts: [],
        },
      };
      expect(() => parseSession(JSON.stringify(data))).toThrow(
        SessionParseError,
      );
      expect(() => parseSession(JSON.stringify(data))).toThrow("role");
    });

    it("should reject invalid rolling summary", () => {
      const data = {
        version: 1,
        savedAt: "2026-01-01T00:00:00Z",
        metadata: TEST_METADATA,
        context: {
          preamble: [],
          turns: [],
          artifacts: [],
          rollingSummary: { content: "summary" },
        },
      };
      expect(() => parseSession(JSON.stringify(data))).toThrow(
        SessionParseError,
      );
    });

    it("should reject a JSON array as the top-level value", () => {
      expect(() => parseSession("[]")).toThrow(SessionParseError);
      expect(() => parseSession("[]")).toThrow("must be a non-null object");
    });

    it("should reject null as the top-level value", () => {
      expect(() => parseSession("null")).toThrow(SessionParseError);
    });
  });

  // =================================================================
  // Legacy session_context.txt regression
  // =================================================================

  describe("legacy plain-text rejection", () => {
    it("should reject legacy session_context.txt content as non-importable", () => {
      const legacyContent = `Session Context
================
User: Hello there
Assistant: Hi! How can I help you today?
User: Can you read my package.json?
Assistant: Sure, let me read that file for you.
[Tool: read] Reading package.json...
Result: { "name": "my-project", "version": "1.0.0" }
Assistant: Your project is called my-project version 1.0.0.`;

      expect(() => parseSession(legacyContent)).toThrow(SessionParseError);
      expect(() => parseSession(legacyContent)).toThrow("Invalid JSON");
    });
  });

  // =================================================================
  // ContextManager.importState integration
  // =================================================================

  describe("ContextManager.importState", () => {
    it("should import a full state and produce matching getConversationState()", () => {
      const source = buildPopulatedManager();
      const original = source.getConversationState();

      const target = new ContextManager();
      target.importState(original);
      const result = target.getConversationState();

      expect(result.preamble).toHaveLength(original.preamble.length);
      expect(result.turns).toHaveLength(original.turns.length);
      expect(result.artifacts).toHaveLength(original.artifacts.length);

      for (let i = 0; i < original.turns.length; i++) {
        expect(result.turns[i].id).toBe(original.turns[i].id);
        expect(result.turns[i].completedAt).toBe(original.turns[i].completedAt);
        expect(result.turns[i].entries).toHaveLength(
          original.turns[i].entries.length,
        );
      }
    });

    it("should rebuild prompt plan after import", () => {
      const source = buildPopulatedManager();

      const target = new ContextManager();
      target.importState(source.getConversationState());

      const plan = target.buildPromptPlan("System prompt");
      expect(plan.messages.length).toBeGreaterThan(1);
      expect(plan.includedTurnIds.length).toBeGreaterThan(0);
    });

    it("should import rolling summary state", () => {
      const source = new ContextManager();
      for (let i = 0; i < 5; i++) {
        source.beginUserTurn(`msg ${i}`);
        source.commitAssistantResponse(`reply ${i}`);
      }

      const state = source.getConversationState();
      const summary: RollingSummaryRecord = {
        content: "Covered first 3 turns",
        updatedAt: "2026-03-28T12:00:00Z",
        coveredTurnIds: state.turns.slice(0, 3).map((t) => t.id),
        estimatedTokens: 10,
      };
      source.setRollingSummary(summary);

      const target = new ContextManager();
      target.importState(source.getConversationState());

      const restored = target.getRollingSummary();
      expect(restored).toBeDefined();
      expect(restored!.content).toBe("Covered first 3 turns");
      expect(restored!.coveredTurnIds).toHaveLength(3);
    });

    it("should allow new turns after import", () => {
      const source = buildPopulatedManager();

      const target = new ContextManager();
      target.importState(source.getConversationState());

      target.beginUserTurn("New question after import");
      target.commitAssistantResponse("New answer");

      const state = target.getConversationState();
      expect(state.turns).toHaveLength(3);
      expect(state.turns[2].userMessage.content).toBe(
        "New question after import",
      );
      expect(state.turns[2].completedAt).toBeDefined();
    });
  });

  // =================================================================
  // End-to-end: serialize → parse → restore → import → verify
  // =================================================================

  describe("end-to-end persistence flow", () => {
    it("should survive a full export-import cycle with all features", () => {
      const source = new ContextManager();

      // Turn 1: completed with text artifact
      source.beginUserTurn("Read config");
      source.commitAssistantResponse("", [
        {
          id: "tc-1",
          function: { name: "read", arguments: { path: "cfg" } },
        },
      ]);
      source.recordToolResults([
        toolResult("tc-1", "read", "config_data=true"),
      ]);
      source.commitAssistantResponse("Config loaded.");

      // Turn 2: completed with binary artifact
      source.beginUserTurn("Get image");
      source.commitAssistantResponse("", [
        { id: "tc-2", function: { name: "read_img", arguments: {} } },
      ]);
      source.recordToolResults([
        toolResult(
          "tc-2",
          "read_img",
          new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
          "success",
          "image/jpeg",
        ),
      ]);
      source.commitAssistantResponse("Image retrieved.");

      // Turn 3: in-progress
      source.beginUserTurn("Do more work");
      source.commitAssistantResponse("Working...", [
        { id: "tc-3", function: { name: "search", arguments: { q: "test" } } },
      ]);
      source.recordToolResults([
        toolResult("tc-3", "search", "Found 3 matches"),
      ]);

      // Rolling summary
      const state = source.getConversationState();
      source.setRollingSummary({
        content: "User loaded config and an image.",
        updatedAt: "2026-03-28T14:00:00Z",
        coveredTurnIds: [state.turns[0].id],
        estimatedTokens: 10,
      });

      // Export
      const json = serializeSession(
        source.getConversationState(),
        TEST_METADATA,
      );

      // Parse + restore + import
      const parsed = parseSession(json);
      const restored = restoreConversationState(parsed);

      const target = new ContextManager();
      target.importState(restored);

      // Verify
      const targetState = target.getConversationState();
      expect(targetState.turns).toHaveLength(3);
      expect(targetState.turns[0].completedAt).toBeDefined();
      expect(targetState.turns[1].completedAt).toBeDefined();
      expect(targetState.turns[2].completedAt).toBeUndefined();

      // Text artifact preserved
      const textArtifact = targetState.artifacts.find(
        (a) => a.mediaType === "text/plain",
      );
      expect(textArtifact).toBeDefined();
      expect(textArtifact!.content).toBe("config_data=true");

      // Binary artifact preserved
      const binaryArtifact = targetState.artifacts.find(
        (a) => a.mediaType === "image/jpeg",
      );
      expect(binaryArtifact).toBeDefined();
      expect(binaryArtifact!.content).toBeInstanceOf(Uint8Array);
      expect(binaryArtifact!.content).toEqual(
        new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
      );

      // Rolling summary preserved
      expect(target.getRollingSummary()).toBeDefined();
      expect(target.getRollingSummary()!.content).toBe(
        "User loaded config and an image.",
      );

      // Can continue working after import
      target.commitAssistantResponse("All done.");
      expect(target.getConversationState().turns[2].completedAt).toBeDefined();
    });
  });
});
