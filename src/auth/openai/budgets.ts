import {
  documentedModelCapacity,
  type DocumentedModelCapacity,
} from "./modelCapacities.js";

export interface PromptBudget {
  contextWindowTokens: number;
  source:
    | "saved-config"
    | "official-documentation"
    | "user-selected-conservative"
    | "user-supplied-capacity";
  capacity?: DocumentedModelCapacity;
}

export function resolvePromptBudget(
  modelKey: string,
  saved?: number,
): PromptBudget | undefined {
  const capacity = documentedModelCapacity(modelKey);
  if (saved !== undefined && Number.isSafeInteger(saved) && saved >= 1024)
    return { contextWindowTokens: saved, source: "saved-config", capacity };
  if (!capacity) return undefined;
  // The legacy config field is an effective working ceiling. The planner
  // subtracts its additional output reserve; never budget all model context as input.
  const working = capacity.contextWindowTokens - capacity.maxOutputTokens;
  return {
    contextWindowTokens: Math.min(working, capacity.maxInputTokens ?? working),
    source: "official-documentation",
    capacity,
  };
}
