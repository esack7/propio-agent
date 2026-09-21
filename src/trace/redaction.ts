const SENSITIVE_KEY =
  /(^|[-_])(api[-_]?key|authorization|cookie|credential|password|secret|token)([-_]|$)/i;
const SENSITIVE_VALUE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bAIza[A-Za-z0-9_-]{12,}\b/g,
];

function redactString(value: string): string {
  return SENSITIVE_VALUE_PATTERNS.reduce(
    (redacted, pattern) => redacted.replace(pattern, "[REDACTED]"),
    value,
  );
}

/** Standard capture redaction. Full payload capture requires a separate policy. */
export function redactTraceValue(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactTraceValue);
  if (value === null || typeof value !== "object") return value;

  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] = SENSITIVE_KEY.test(key)
      ? entry === undefined
        ? undefined
        : "[REDACTED]"
      : redactTraceValue(entry);
  }
  return redacted;
}
