/** Documentation evidence, not account-specific subscription entitlement. */
export interface DocumentedModelCapacity {
  contextWindowTokens: number;
  maxInputTokens?: number;
  maxOutputTokens: number;
  sourceUrl: string;
  checkedAt: string;
}

// Exact IDs only: a future model/snapshot must never inherit guessed limits.
const capacities = new Map<string, DocumentedModelCapacity>();
for (const key of [
  "gpt-6.1-sol",
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
]) {
  capacities.set(key, {
    contextWindowTokens: 1050000,
    maxInputTokens: 922000,
    maxOutputTokens: 128000,
    sourceUrl: `https://developers.openai.com/api/docs/models/${key}`,
    checkedAt: "2026-10-11",
  });
}
for (const key of ["gpt-5.5", "gpt-5.5-2026-04-23"]) {
  capacities.set(key, {
    contextWindowTokens: 1050000,
    maxOutputTokens: 128000,
    sourceUrl: "https://developers.openai.com/api/docs/models/gpt-5.5",
    checkedAt: "2026-10-11",
  });
}

export function documentedModelCapacity(
  key: string,
): DocumentedModelCapacity | undefined {
  const capacity = capacities.get(key);
  return capacity ? { ...capacity } : undefined;
}
