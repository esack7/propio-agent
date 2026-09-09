import {
  ConversationManager,
  characterTokenEstimator,
  DEFAULT_BUDGET_POLICY,
  type TokenEstimator,
} from "../index.js";
import { toolResult } from "./testHelpers.js";

const equivalentEstimators: TokenEstimator[] = [
  characterTokenEstimator,
  { ...characterTokenEstimator },
  {
    estimateText: (text) => characterTokenEstimator.estimateText(text),
    estimateMessages: (messages) =>
      characterTokenEstimator.estimateMessages(messages),
    estimateCharacters: (chars) =>
      characterTokenEstimator.estimateCharacters(chars),
  },
];

function historyWithPendingTools(): ConversationManager {
  const manager = new ConversationManager();
  for (let i = 0; i < 12; i++) {
    manager.beginUserTurn("u".repeat(240));
    manager.commitAssistantResponse("a".repeat(240));
  }
  manager.beginUserTurn("Read these files");
  const calls = Array.from({ length: 12 }, (_, i) => ({
    id: `read-${i}`,
    function: { name: "read", arguments: { path: `file-${i}` } },
  }));
  manager.commitAssistantResponse("", calls);
  manager.recordToolResults(
    calls.map((call) => toolResult(call.id, "read", "x".repeat(400))),
  );
  return manager;
}

describe("equivalent token estimators", () => {
  it.each([1200, 1300, 1500])(
    "selects the same tool-heavy history at a %i-token budget",
    (contextWindowTokens) => {
      const state = historyWithPendingTools().getConversationState();
      const plans = equivalentEstimators.map((tokenEstimator) => {
        const manager = new ConversationManager({ tokenEstimator });
        manager.importState(state);
        return manager.buildPromptPlan("System", undefined, {
          contextWindowTokens,
          policy: {
            ...DEFAULT_BUDGET_POLICY,
            reservedOutputTokens: 0,
            maxRecentTurns: 20,
            artifactInlineCharCap: 80,
          },
        });
      });
      for (const plan of plans) {
        expect(plan).toEqual(plans[0]);
        expect(plan.includedTurnIds.length).toBeGreaterThan(1);
        expect(plan.omittedTurnIds.length).toBeGreaterThan(0);
        expect(plan.includedArtifactIds).toHaveLength(12);
        expect(plan.estimatedPromptTokens).toBeLessThanOrEqual(
          contextWindowTokens,
        );
      }
    },
  );

  it.each([false, true])(
    "measures the actual rendered summary (structured: %s)",
    (structured) => {
      const source = new ConversationManager();
      for (let i = 0; i < 2; i++) {
        source.beginUserTurn("u".repeat(80));
        source.commitAssistantResponse("a".repeat(80));
      }
      const state = source.getConversationState();
      const summary = {
        content: "s".repeat(100),
        estimatedTokens: 25,
        updatedAt: "2026-01-01",
        coveredTurnIds: [state.turns[0].id],
        ...(structured ? { sections: { goals: "Goal" } } : {}),
      };
      const rendered = structured
        ? "## Session Summary\n\n### Goals\nGoal"
        : `<session_summary>\n${summary.content}\n</session_summary>`;
      const contextWindowTokens =
        characterTokenEstimator.estimateText("System") +
        characterTokenEstimator.estimateText(rendered) +
        characterTokenEstimator.estimateMessages([
          state.turns[1].userMessage,
          ...state.turns[1].entries.map((entry) => entry.message),
        ]);
      const plans = equivalentEstimators.map((tokenEstimator) => {
        const manager = new ConversationManager({ tokenEstimator });
        manager.importState({ ...state, rollingSummary: summary });
        return manager.buildPromptPlan("System", undefined, {
          contextWindowTokens,
          policy: { ...DEFAULT_BUDGET_POLICY, reservedOutputTokens: 0 },
        });
      });
      for (const plan of plans) {
        expect(plan).toEqual(plans[0]);
        expect(plan.usedRollingSummary).toBe(true);
        expect(plan.includedTurnIds).toEqual([state.turns[1].id]);
        expect(plan.omittedTurnIds).toEqual([state.turns[0].id]);
        expect(plan.messages[0].content).toBe(`System\n\n${rendered}`);
      }
    },
  );
});
