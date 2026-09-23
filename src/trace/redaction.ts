const SENSITIVE_VALUE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bAIza[A-Za-z0-9_-]{12,}\b/g,
];

const FILESYSTEM_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /(?<![A-Za-z0-9/])\/(?:Users|home|var|tmp|private|Volumes|workspace|workspaces|mnt|opt|srv|root|etc|builds|data|app|build|code|repo|usr|run)\/[^\s"'`<>]+/g,
  /\b[A-Za-z]:\\[^\s"'`<>]+/g,
  /\\\\[^\\\s"'`<>]+\\[^\s"'`<>]+/g,
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

const DECIMAL_RATE_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function isPricingValue(value: unknown): boolean {
  return (
    typeof value === "number" ||
    (typeof value === "string" && DECIMAL_RATE_PATTERN.test(value))
  );
}

function isTokenMetricKey(
  segments: ReadonlyArray<string>,
  value: unknown,
): boolean {
  const tokenIndex = segments.indexOf("token");
  return (
    tokenIndex >= 0 &&
    (segments
      .slice(tokenIndex + 1)
      .some((segment) => TOKEN_METRIC_SEGMENTS.has(segment)) ||
      (isPricingValue(value) &&
        segments.some((segment) =>
          ["rate", "price", "cost"].includes(segment),
        )))
  );
}

function isSensitiveKey(key: string, value: unknown): boolean {
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
  if (segments.includes("token") && !isTokenMetricKey(segments, value))
    return true;
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

function isPathKey(key: string | undefined): boolean {
  if (!key) return false;
  const segments = keySegments(key);
  if (
    segments.some((segment) => ["endpoint", "route", "url"].includes(segment))
  )
    return false;
  return segments.some((segment) =>
    ["path", "paths", "file", "files", "directory", "dir", "cwd"].includes(
      segment,
    ),
  );
}

function redactString(
  value: string,
  key?: string,
  preservePaths = false,
): string {
  const credentialSafe = SENSITIVE_VALUE_PATTERNS.reduce(
    (redacted, pattern) => redacted.replace(pattern, "[REDACTED]"),
    value,
  );
  if (
    !preservePaths &&
    isPathKey(key) &&
    /^(?:\/|[A-Za-z]:\\|\\\\)/.test(credentialSafe.trim())
  )
    return "[REDACTED]";
  if (preservePaths) return credentialSafe;
  return FILESYSTEM_PATH_PATTERNS.reduce(
    (redacted, pattern) =>
      redacted.replace(pattern, (match) => {
        const suffix = match.match(/[),.;!?}\]]+$/)?.[0] ?? "";
        return `[REDACTED]${suffix}`;
      }),
    credentialSafe,
  );
}

/** Standard capture redaction. Full payload capture requires a separate policy. */
export function redactTraceValue(
  value: unknown,
  options: { preservePaths?: boolean } = {},
): unknown {
  return redactEntry(value, undefined, options.preservePaths ?? false);
}

function redactEntry(
  value: unknown,
  key?: string,
  preservePaths = false,
): unknown {
  if (typeof value === "string") return redactString(value, key, preservePaths);
  if (Array.isArray(value))
    return value.map((entry) => redactEntry(entry, key, preservePaths));
  if (value === null || typeof value !== "object") return value;

  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] =
      isSensitiveKey(key, entry) && !isCredentialPresenceMetadata(entry)
        ? entry === undefined
          ? undefined
          : "[REDACTED]"
        : redactEntry(entry, key, preservePaths);
  }
  return redacted;
}
