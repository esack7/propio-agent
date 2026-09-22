import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ContextManager } from "../../context/contextManager.js";
import type { ConversationRecoveryChange } from "../../context/conversationManager.js";
import {
  serializeSession,
  type SessionMetadata,
} from "../../context/persistence.js";
import {
  DEFAULT_BUDGET_POLICY,
  DEFAULT_SUMMARY_POLICY,
} from "../../context/types.js";
import {
  appendRecoveryJournal,
  readRecoveryJournal,
  writeRecoveryJournalBase,
} from "../recoveryJournal.js";

const sessionId = "11111111-1111-4111-8111-111111111111";
const metadata: SessionMetadata = {
  providerName: "fixture",
  modelKey: "fixture",
  systemPrompt: "",
  promptBudgetPolicy: DEFAULT_BUDGET_POLICY,
  summaryPolicy: DEFAULT_SUMMARY_POLICY,
  contextWindowTokens: 128_000,
  sessionId,
};

class TestContextManager extends ContextManager {
  discardCurrentTurn(): void {
    this.discardIncompleteTurnWhen(() => true);
  }
}

function toolCall(id: string) {
  return { id, function: { name: "fixture_tool", arguments: {} } };
}

function createJournalVerifier() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "propio-journal-state-"));
  const context = new TestContextManager();
  let position = writeRecoveryJournalBase(
    dir,
    serializeSession(context.getConversationState(), metadata),
  );
  const changes: ConversationRecoveryChange[] = [];
  let skillCount = 0;
  context.setRecoveryChangeListener((change) => changes.push(change));

  function checkpoint(): void {
    position = appendRecoveryJournal(
      dir,
      sessionId,
      position,
      metadata,
      changes,
      context.getInvokedSkillsSince(skillCount),
    );
    changes.length = 0;
    skillCount = context.getInvokedSkillCount();
    const recovered = JSON.parse(readRecoveryJournal(dir, sessionId)!.json);
    const live = JSON.parse(
      serializeSession(context.getConversationState(), metadata),
    );
    expect(recovered.context).toEqual(live.context);
    expect(recovered.metadata).toEqual({
      ...live.metadata,
      recoveryCheckpoint: true,
    });
  }

  return {
    context,
    checkpoint,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

describe("recovery journal state equivalence", () => {
  it("matches a full export after every turn, result, summary, memory, and skill change", () => {
    const { context, checkpoint, cleanup } = createJournalVerifier();
    try {
      context.beginUserTurn("Inspect the file", [new Uint8Array([1, 2, 3])]);
      checkpoint();
      context.commitAssistantResponse("", [
        toolCall("first"),
        toolCall("second"),
      ]);
      checkpoint();
      context.recordToolResults([
        {
          toolCallId: "first",
          toolName: "fixture_tool",
          status: "success",
          rawContent: "first result",
        },
      ]);
      checkpoint();
      context.recordToolResults([
        {
          toolCallId: "second",
          toolName: "fixture_tool",
          status: "success",
          rawContent: new Uint8Array([4, 5, 6]),
        },
      ]);
      checkpoint();
      context.commitAssistantResponse("Done");
      checkpoint();

      context.setRollingSummary({
        content: "The file was inspected.",
        updatedAt: new Date().toISOString(),
        coveredTurnIds: [context.getConversationState().turns[0]!.id],
        estimatedTokens: 7,
      });
      checkpoint();
      const memoryId = context.pinFact({
        kind: "fact",
        content: "The file exists",
        source: { origin: "tool" },
      });
      checkpoint();
      const replacementId = context.updateMemory(memoryId, {
        content: "The file was inspected",
      });
      checkpoint();
      context.unpinFact(replacementId);
      checkpoint();

      context.recordInvokedSkill({
        name: "review",
        source: "project",
        skillRoot: "/skills",
        skillFile: "/skills/review/SKILL.md",
        content: "Review the file.",
        invokedAt: new Date().toISOString(),
        scope: {
          invocationSource: "user",
          skillName: "review",
          skillRoot: "/skills",
          skillFile: "/skills/review/SKILL.md",
        },
      });
      checkpoint();
    } finally {
      cleanup();
    }
  });

  it("matches a full export after unresolved assistants and turns are removed", () => {
    const { context, checkpoint, cleanup } = createJournalVerifier();
    try {
      context.beginUserTurn("Cancelled before a response");
      checkpoint();
      context.abandonIncompleteTurn();
      checkpoint();

      context.beginUserTurn("Cancelled after a proposed tool call");
      context.commitAssistantResponse("", [toolCall("pending")]);
      checkpoint();
      context.removeLastUnresolvedAssistantMessage();
      checkpoint();
      context.abandonIncompleteTurn();
      checkpoint();

      context.beginUserTurn("Discard synthetic work");
      context.commitAssistantResponse("", [toolCall("discard")]);
      context.recordToolResults([
        {
          toolCallId: "discard",
          toolName: "fixture_tool",
          status: "success",
          rawContent: "discarded result",
        },
      ]);
      checkpoint();
      context.discardCurrentTurn();
      checkpoint();
    } finally {
      cleanup();
    }
  });

  it("matches a full export after preamble additions and removal", () => {
    const { context, checkpoint, cleanup } = createJournalVerifier();
    try {
      context.commitAssistantResponse("", [toolCall("preamble")]);
      checkpoint();
      context.removeLastUnresolvedAssistantMessage();
      checkpoint();
      context.recordToolResults([
        {
          toolCallId: "orphan",
          toolName: "fixture_tool",
          status: "error",
          rawContent: new Uint8Array([7, 8, 9]),
        },
      ]);
      checkpoint();
    } finally {
      cleanup();
    }
  });
});
