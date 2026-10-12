/** Explicit cross-account transcript transfer retains readable history only. */
export function stripProviderContinuation<T>(value: T): T {
  const clone = structuredClone(value);
  strip(clone);
  return clone;
}

function strip(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach(strip);
    return;
  }
  const record = value as Record<string, unknown>;
  delete record.reasoningContent;
  delete record.thoughtSignature;
  Object.values(record).forEach(strip);
}
