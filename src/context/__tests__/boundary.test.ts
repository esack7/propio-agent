import { jest } from "@jest/globals";
import {
  ConversationManager,
  SummaryManager,
  characterTokenEstimator,
  serializeContext,
  parseContext,
  DEFAULT_SUMMARY_POLICY,
  DEFAULT_BUDGET_POLICY,
  type TokenEstimator,
  type ConversationState,
} from "../index.js";
import { ContextManager } from "../contextManager.js";
import {
  serializeSession,
  parseSession,
  restoreConversationState,
} from "../persistence.js";
import {
  buildPopulatedManager,
  TEST_METADATA,
  toolResult,
} from "./testHelpers.js";
import { legacySessionFixture } from "./fixtures/legacySessions.js";

describe("reusable context boundary", () => {
  it("serializes omitted pinned memory from JavaScript consumers as an empty list", () => {
    const state = {
      preamble: [],
      turns: [],
      artifacts: [],
    } as unknown as ConversationState;
    expect(parseContext(serializeContext(state)).pinnedMemory).toEqual([]);
    expect(
      restoreConversationState(
        parseSession(serializeSession(state, TEST_METADATA)),
      ).pinnedMemory,
    ).toEqual([]);
  });

  it.each([0, 1, 2, 3])(
    "preserves prompt plans and tool associations at retry level %i",
    (retryLevel) => {
      const app = buildPopulatedManager();
      app.beginUserTurn("Read more");
      app.commitAssistantResponse("", [
        { id: "pending", function: { name: "read", arguments: {} } },
      ]);
      app.recordToolResults([toolResult("pending", "read", "x".repeat(20000))]);
      const core = new ConversationManager();
      core.importState(app.getConversationState());
      const options = { retryLevel, contextWindowTokens: 4000 };
      const actual = core.buildPromptPlan("System", undefined, options);
      expect(actual).toEqual(app.buildPromptPlan("System", undefined, options));
      const calls = actual.messages.flatMap(
        (m) => m.toolCalls?.map((call) => call.id) ?? [],
      );
      const results = actual.messages.flatMap(
        (m) => m.toolResults?.map((result) => result.toolCallId) ?? [],
      );
      expect(results).toEqual(calls);
      expect(actual.includedArtifactIds).toHaveLength(1);
      expect(actual.messages.at(-1)?.toolResults?.[0].content).toContain(
        "output truncated",
      );
    },
  );

  it("uses injected message estimation for history selection and final measurement", () => {
    const estimator: TokenEstimator = {
      estimateText: () => 100,
      estimateMessages: (messages) => messages.length * 100,
      estimateCharacters: () => 100,
    };
    const core = new ConversationManager({ tokenEstimator: estimator });
    core.importState(buildPopulatedManager().getConversationState());
    const plan = core.buildPromptPlan("System", undefined, {
      contextWindowTokens: 150,
      policy: { ...DEFAULT_BUDGET_POLICY, reservedOutputTokens: 0 },
    });
    expect(plan.includedTurnIds).toEqual([]);
    expect(plan.omittedTurnIds).toHaveLength(2);
    expect(plan.estimatedPromptTokens).toBe(100);
  });

  it("renders supplemental context after pinned memory without skill dependencies", () => {
    const core = new ConversationManager();
    core.pinFact({
      kind: "fact",
      content: "Remember",
      source: { origin: "application" },
    });
    core.beginUserTurn("Hello");
    const content = core.buildPromptPlan("System", undefined, {
      supplementalContext: ["Contribution one", "Contribution two"],
    }).messages[0].content;
    expect(content.indexOf("Remember")).toBeLessThan(
      content.indexOf("Contribution one"),
    );
    expect(content).toMatch(/Contribution one\n\nContribution two$/);
  });

  it("resolves artifacts through a supplied lookup and retains external storage metadata on import", () => {
    const lookup = jest.fn((id: string) => ({
      ...artifact,
      id,
      content: "adapter content",
    }));
    const source = new ConversationManager();
    source.beginUserTurn("Read");
    source.commitAssistantResponse("", [
      { id: "read", function: { name: "read", arguments: {} } },
    ]);
    source.recordToolResults([
      {
        ...toolResult("read", "read", "original"),
        externalStorage: {
          externalPath: "/caller/output",
          externalSizeBytes: 8,
          externalLineCount: 1,
        },
      },
    ]);
    const artifact = source.getConversationState().artifacts[0];
    const restored = new ConversationManager({ artifactLookup: lookup });
    restored.importState(
      parseContext(serializeContext(source.getConversationState())),
    );
    expect(restored.getConversationState().artifacts[0]).toEqual(artifact);
    expect(
      restored.buildPromptPlan("System").messages.at(-1)?.toolResults?.[0]
        .content,
    ).toBe("adapter content");
    expect(lookup).toHaveBeenCalledWith(artifact.id);
  });

  it("round trips binary images, reasoning continuation, memory and summaries through the core codec", () => {
    const core = new ConversationManager();
    core.beginUserTurn("Image", [
      new Uint8Array([0, 128, 255]),
      "data:image/png;base64,AA==",
    ]);
    core.commitAssistantResponse("Answer", undefined, {
      reasoningContent: '{"opaque":"continuation"}',
    });
    core.pinFact({
      kind: "constraint",
      content: "Keep state",
      source: { origin: "user" },
    });
    core.setRollingSummary({
      content: "Summary",
      estimatedTokens: 2,
      updatedAt: "2026-01-01",
      coveredTurnIds: [],
      sections: { goals: "Goal" },
    });
    expect(parseContext(serializeContext(core.getConversationState()))).toEqual(
      core.getConversationState(),
    );
    expect(() => parseContext('{"version":2,"context":{}}')).toThrow(
      "Unsupported context version",
    );
    expect(() =>
      parseContext('{"version":1,"context":{"preamble":[]}}'),
    ).toThrow("context.turns");
  });

  it.each([1, 2, 3, 4])(
    "loads legacy session v%i and writes compatible v4 state",
    (version) => {
      const fixture = legacySessionFixture(version);
      const parsed = parseSession(JSON.stringify(fixture));
      const app = new ContextManager();
      app.importState(restoreConversationState(parsed));
      const rewritten = parseSession(
        serializeSession(app.getConversationState(), parsed.metadata),
      );
      expect(rewritten.version).toBe(4);
      expect(rewritten.metadata).toEqual(fixture.metadata);
      expect(restoreConversationState(rewritten)).toEqual(
        app.getConversationState(),
      );
      expect(app.getSnapshot()[0].images?.[0]).toEqual(
        new Uint8Array([0, 128, 255]),
      );
      expect(app.getSnapshot()[1].reasoningContent).toBe(
        '{"opaque":"continuation"}',
      );
      expect(app.getConversationState().invokedSkills).toHaveLength(
        version >= 3 ? 1 : 0,
      );
    },
  );

  it("summarizes through a callback and uses the supplied estimator", async () => {
    const estimator = { ...characterTokenEstimator, estimateText: () => 17 };
    const summary = new SummaryManager(estimator);
    const generate = jest.fn(async () => "Summary from consumer");
    const result = await summary.generateSummary(
      generate,
      "caller-model",
      buildPopulatedManager().getConversationState().turns,
      undefined,
      DEFAULT_SUMMARY_POLICY,
    );
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "caller-model" }),
    );
    expect(result.summary.content).toBe("Summary from consumer");
    expect(result.summary.estimatedTokens).toBe(17);
  });

  it("does not accept a callback summary after cancellation", async () => {
    const controller = new AbortController();
    const generate = async () => {
      controller.abort();
      return "Cancelled";
    };
    await expect(
      new SummaryManager().generateSummary(
        generate,
        "model",
        buildPopulatedManager().getConversationState().turns,
        undefined,
        DEFAULT_SUMMARY_POLICY,
        controller.signal,
      ),
    ).rejects.toThrow("cancelled");
  });
});
