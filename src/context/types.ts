/** Application compatibility types. Reusable consumers import context/index.js. */
export * from "./coreTypes.js";
import type { ConversationState as CoreConversationState } from "./coreTypes.js";
import type { InvokedSkillRecord } from "../skills/types.js";

export interface ConversationState extends CoreConversationState {
  readonly invokedSkills?: ReadonlyArray<InvokedSkillRecord>;
}
