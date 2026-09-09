import {
  ConversationManager,
  type BuildPromptPlanOptions,
} from "./conversationManager.js";
import type { ConversationState } from "./types.js";
import type { InvokedSkillRecord } from "../skills/types.js";
import { cloneInvokedSkillRecord } from "../skills/shared.js";
import { renderInvokedSkillBlock } from "./invokedSkillRenderer.js";
import {
  isSyntheticMentionAssistantMessage,
  isSyntheticMentionToolMessage,
  collectMentionToolCallIds,
} from "../fileSearch/syntheticMention.js";

/** CLI adapter: application skill state stays outside the reusable model. */
export class ContextManager extends ConversationManager {
  private invokedSkills: InvokedSkillRecord[] = [];

  recordInvokedSkill(record: InvokedSkillRecord): void {
    this.invokedSkills.push(cloneInvokedSkillRecord(record));
  }

  override clear(): void {
    super.clear();
    this.invokedSkills = [];
  }

  override importState(state: ConversationState): void {
    super.importState(state);
    this.invokedSkills = (state.invokedSkills ?? []).map(
      cloneInvokedSkillRecord,
    );
  }

  override getConversationState(): ConversationState {
    return {
      ...super.getConversationState(),
      invokedSkills: this.invokedSkills.map(cloneInvokedSkillRecord),
    };
  }

  override buildPromptPlan(
    systemPrompt: string,
    extraUserInstruction?: string,
    options?: BuildPromptPlanOptions,
  ) {
    const skills = renderInvokedSkillBlock(this.invokedSkills);
    return super.buildPromptPlan(systemPrompt, extraUserInstruction, {
      ...options,
      supplementalContext: [
        ...(skills ? [skills] : []),
        ...(options?.supplementalContext ?? []),
      ],
    });
  }

  abandonSyntheticMentionOnlyTurn(): void {
    this.discardIncompleteTurnWhen((turn) => {
      if (turn.entries.length !== 2) return false;
      const [assistant, tool] = turn.entries;
      return (
        assistant.kind === "assistant" &&
        tool.kind === "tool" &&
        isSyntheticMentionAssistantMessage(assistant.message) &&
        isSyntheticMentionToolMessage(
          tool.message,
          collectMentionToolCallIds(assistant.message),
        )
      );
    });
  }
}
