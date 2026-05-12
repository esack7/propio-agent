import {
  PinnedMemoryRecord,
  PinFactInput,
  UpdateMemoryInput,
  MemoryKind,
  MemoryScope,
  MemoryOrigin,
  MemoryLifecycle,
} from "./types.js";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_KINDS = new Set<MemoryKind>(["fact", "constraint", "decision"]);
const VALID_SCOPES = new Set<MemoryScope>(["session", "project"]);
const VALID_ORIGINS = new Set<MemoryOrigin>([
  "user",
  "assistant",
  "tool",
  "application",
]);
const DEFAULT_MAX_CONTENT_LENGTH = 2000;
const CODE_FENCE_PATTERN = /```/;
const MULTILINE_THRESHOLD = 5;

export class MemoryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryValidationError";
  }
}

export function validatePinInput(
  input: PinFactInput,
  maxContentLength = DEFAULT_MAX_CONTENT_LENGTH,
): void {
  if (!VALID_KINDS.has(input.kind)) {
    throw new MemoryValidationError(
      `Invalid memory kind "${input.kind}"; must be one of: fact, constraint, decision`,
    );
  }

  if (input.scope !== undefined && !VALID_SCOPES.has(input.scope)) {
    throw new MemoryValidationError(
      `Invalid memory scope "${input.scope}"; must be one of: session, project`,
    );
  }

  validateSource(input.source, "source");

  if (input.rationale !== undefined && typeof input.rationale !== "string") {
    throw new MemoryValidationError("rationale must be a string if provided");
  }

  if (!input.content || input.content.trim().length === 0) {
    throw new MemoryValidationError("Memory content must not be empty");
  }

  if (input.content.length > maxContentLength) {
    throw new MemoryValidationError(
      `Memory content exceeds ${maxContentLength} chars (got ${input.content.length}); pin concise facts, not raw dumps`,
    );
  }

  if (CODE_FENCE_PATTERN.test(input.content)) {
    throw new MemoryValidationError(
      "Memory content must not contain code fences; pin a concise description instead",
    );
  }

  const lineCount = input.content.split("\n").length;
  if (lineCount > MULTILINE_THRESHOLD) {
    throw new MemoryValidationError(
      `Memory content has ${lineCount} lines (max ${MULTILINE_THRESHOLD}); pin concise facts, not multi-line dumps`,
    );
  }
}

function validateSource(source: unknown, label: string): void {
  if (source == null || typeof source !== "object") {
    throw new MemoryValidationError(`${label} must be a non-null object`);
  }
  const src = source as Record<string, unknown>;
  if (
    typeof src.origin !== "string" ||
    !VALID_ORIGINS.has(src.origin as MemoryOrigin)
  ) {
    throw new MemoryValidationError(
      `${label}.origin must be one of: user, assistant, tool, application`,
    );
  }
  if (src.turnId !== undefined && typeof src.turnId !== "string") {
    throw new MemoryValidationError(
      `${label}.turnId must be a string if provided`,
    );
  }
  if (src.toolCallId !== undefined && typeof src.toolCallId !== "string") {
    throw new MemoryValidationError(
      `${label}.toolCallId must be a string if provided`,
    );
  }
}

export function validateUpdateInput(
  input: UpdateMemoryInput,
  maxContentLength = DEFAULT_MAX_CONTENT_LENGTH,
): void {
  if (input.rationale !== undefined && typeof input.rationale !== "string") {
    throw new MemoryValidationError("rationale must be a string if provided");
  }
  if (input.content !== undefined) {
    if (input.content.trim().length === 0) {
      throw new MemoryValidationError("Updated content must not be empty");
    }
    if (input.content.length > maxContentLength) {
      throw new MemoryValidationError(
        `Updated content exceeds ${maxContentLength} chars (got ${input.content.length})`,
      );
    }
    if (CODE_FENCE_PATTERN.test(input.content)) {
      throw new MemoryValidationError(
        "Updated content must not contain code fences",
      );
    }
    const lineCount = input.content.split("\n").length;
    if (lineCount > MULTILINE_THRESHOLD) {
      throw new MemoryValidationError(
        `Updated content has ${lineCount} lines (max ${MULTILINE_THRESHOLD})`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Deep cloning
// ---------------------------------------------------------------------------

export function clonePinnedRecord(r: PinnedMemoryRecord): PinnedMemoryRecord {
  return {
    ...r,
    source: { ...r.source },
  };
}

// ---------------------------------------------------------------------------
// Normalization (for duplicate detection)
// ---------------------------------------------------------------------------

export function normalizeContent(content: string): string {
  return content.trim().toLowerCase().replace(/\s+/g, " ");
}

export function isDuplicateActive(
  records: ReadonlyArray<PinnedMemoryRecord>,
  kind: MemoryKind,
  scope: string,
  content: string,
): boolean {
  const normalized = normalizeContent(content);
  return records.some(
    (r) =>
      r.lifecycle === "active" &&
      r.kind === kind &&
      r.scope === scope &&
      normalizeContent(r.content) === normalized,
  );
}

// ---------------------------------------------------------------------------
// Lifecycle transitions
// ---------------------------------------------------------------------------

export function supersedRecord(
  record: PinnedMemoryRecord,
  replacementId: string,
): PinnedMemoryRecord {
  return {
    ...record,
    lifecycle: "superseded" as MemoryLifecycle,
    supersededById: replacementId,
    updatedAt: new Date().toISOString(),
  };
}

export function removeRecord(
  record: PinnedMemoryRecord,
  rationale?: string,
): PinnedMemoryRecord {
  return {
    ...record,
    lifecycle: "removed" as MemoryLifecycle,
    rationale: rationale ?? record.rationale,
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Prompt rendering
// ---------------------------------------------------------------------------

/**
 * Render active pinned memory into a deterministic prompt block.
 * Section order: constraints, facts, decisions.
 * Within each section: oldest active first.
 */
export function renderPinnedMemoryBlock(
  records: ReadonlyArray<PinnedMemoryRecord>,
): string {
  const active = records.filter((r) => r.lifecycle === "active");
  if (active.length === 0) return "";

  const constraints = active
    .filter((r) => r.kind === "constraint")
    .sort(byCreatedAt);
  const facts = active.filter((r) => r.kind === "fact").sort(byCreatedAt);
  const decisions = active
    .filter((r) => r.kind === "decision")
    .sort(byCreatedAt);

  const sections: string[] = [];

  if (constraints.length > 0) {
    sections.push(
      "Constraints:\n" + constraints.map((r) => `- ${r.content}`).join("\n"),
    );
  }

  if (facts.length > 0) {
    sections.push("Facts:\n" + facts.map((r) => `- ${r.content}`).join("\n"));
  }

  if (decisions.length > 0) {
    sections.push(
      "Decisions:\n" + decisions.map((r) => `- ${r.content}`).join("\n"),
    );
  }

  return "<pinned_memory>\n" + sections.join("\n\n") + "\n</pinned_memory>";
}

function byCreatedAt(a: PinnedMemoryRecord, b: PinnedMemoryRecord): number {
  return a.createdAt.localeCompare(b.createdAt);
}
