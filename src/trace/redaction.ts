const SENSITIVE_VALUE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bAIza[A-Za-z0-9_-]{12,}\b/g,
];

function keySegments(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const TOKEN_METRIC_SEGMENTS = new Set([
  "budget",
  "count",
  "estimate",
  "estimated",
  "limit",
  "usage",
]);

function isTokenMetricKey(segments: ReadonlyArray<string>): boolean {
  const tokenIndex = segments.indexOf("token");
  return (
    tokenIndex >= 0 &&
    segments
      .slice(tokenIndex + 1)
      .some((segment) => TOKEN_METRIC_SEGMENTS.has(segment))
  );
}

function isSensitiveKey(key: string): boolean {
  const segments = keySegments(key);
  if (
    segments.some((segment) =>
      [
        "authorization",
        "cookie",
        "credential",
        "credentials",
        "password",
        "secret",
      ].includes(segment),
    )
  ) {
    return true;
  }
  if (segments.includes("token") && !isTokenMetricKey(segments)) return true;
  return segments.some(
    (segment, index) => segment === "api" && segments[index + 1] === "key",
  );
}

function isCredentialPresenceMetadata(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const entries = Object.entries(value);
  return (
    entries.length > 0 &&
    entries.every(([key]) => key === "present" || key === "source") &&
    typeof (value as { present?: unknown }).present === "boolean" &&
    ((value as { source?: unknown }).source === undefined ||
      typeof (value as { source?: unknown }).source === "string")
  );
}

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
    redacted[key] =
      isSensitiveKey(key) && !isCredentialPresenceMetadata(entry)
        ? entry === undefined
          ? undefined
          : "[REDACTED]"
        : redactTraceValue(entry);
  }
  return redacted;
}
