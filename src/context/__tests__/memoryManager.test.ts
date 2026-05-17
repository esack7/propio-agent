import {
  MemoryValidationError,
  validatePinInput,
  validateUpdateInput,
  normalizeContent,
  isDuplicateActive,
  supersedRecord,
  removeRecord,
  renderPinnedMemoryBlock,
  clonePinnedRecord,
} from "../memoryManager.js";
import type {
  MemoryKind,
  PinnedMemoryRecord,
  PinFactInput,
  UpdateMemoryInput,
} from "../types.js";

const userSource = { origin: "user" as const };

function pinBase(overrides: Partial<PinFactInput> = {}): PinFactInput {
  return {
    kind: "fact",
    content: "Short fact",
    source: userSource,
    ...overrides,
  };
}

function record(
  overrides: Partial<PinnedMemoryRecord> = {},
): PinnedMemoryRecord {
  return {
    id: "r1",
    kind: "fact",
    scope: "session",
    content: "alpha",
    source: userSource,
    createdAt: "2026-01-01T12:00:00.000Z",
    updatedAt: "2026-01-01T12:00:00.000Z",
    lifecycle: "active",
    ...overrides,
  };
}

describe("validatePinInput", () => {
  it("accepts valid input", () => {
    expect(() => validatePinInput(pinBase())).not.toThrow();
  });

  it("rejects empty content", () => {
    expect(() => validatePinInput(pinBase({ content: "" }))).toThrow(
      MemoryValidationError,
    );
    expect(() => validatePinInput(pinBase({ content: "   " }))).toThrow(
      MemoryValidationError,
    );
  });

  it("rejects content longer than default limit (2000 chars)", () => {
    const content = "x".repeat(2001);
    expect(() => validatePinInput(pinBase({ content }))).toThrow(
      MemoryValidationError,
    );
    expect(() =>
      validatePinInput(pinBase({ content: "x".repeat(2000) })),
    ).not.toThrow();
  });

  it("respects a custom maxContentLength when provided", () => {
    const content = "x".repeat(501);
    expect(() => validatePinInput(pinBase({ content }), 500)).toThrow(
      MemoryValidationError,
    );
    expect(() => validatePinInput(pinBase({ content }), 2000)).not.toThrow();
  });

  it("rejects content with code fences", () => {
    expect(() =>
      validatePinInput(pinBase({ content: "has ```fence```" })),
    ).toThrow(MemoryValidationError);
    expect(() =>
      validatePinInput(pinBase({ content: "```ts\nx\n```" })),
    ).toThrow(MemoryValidationError);
  });

  it("rejects content with more than 5 lines", () => {
    const five = ["a", "b", "c", "d", "e"].join("\n");
    const six = ["a", "b", "c", "d", "e", "f"].join("\n");
    expect(() => validatePinInput(pinBase({ content: five }))).not.toThrow();
    expect(() => validatePinInput(pinBase({ content: six }))).toThrow(
      MemoryValidationError,
    );
  });

  it("rejects invalid kind", () => {
    const input = {
      ...pinBase(),
      kind: "preference" as MemoryKind,
    };
    expect(() => validatePinInput(input)).toThrow(MemoryValidationError);
  });

  it("rejects invalid scope", () => {
    expect(() => validatePinInput(pinBase({ scope: "global" as any }))).toThrow(
      MemoryValidationError,
    );
    expect(() => validatePinInput(pinBase({ scope: "session" }))).not.toThrow();
    expect(() => validatePinInput(pinBase({ scope: "project" }))).not.toThrow();
  });

  it("accepts undefined scope", () => {
    expect(() => validatePinInput(pinBase({ scope: undefined }))).not.toThrow();
  });

  it("rejects missing source", () => {
    expect(() =>
      validatePinInput({ ...pinBase(), source: null as any }),
    ).toThrow(MemoryValidationError);
    expect(() =>
      validatePinInput({ ...pinBase(), source: undefined as any }),
    ).toThrow(MemoryValidationError);
  });

  it("rejects invalid source.origin", () => {
    expect(() =>
      validatePinInput(pinBase({ source: { origin: "system" as any } })),
    ).toThrow(MemoryValidationError);
  });

  it("accepts all valid source origins", () => {
    for (const origin of [
      "user",
      "assistant",
      "tool",
      "application",
    ] as const) {
      expect(() =>
        validatePinInput(pinBase({ source: { origin } })),
      ).not.toThrow();
    }
  });

  it("rejects non-string source.turnId", () => {
    expect(() =>
      validatePinInput(
        pinBase({ source: { origin: "user", turnId: 42 as any } }),
      ),
    ).toThrow(MemoryValidationError);
  });

  it("rejects non-string source.toolCallId", () => {
    expect(() =>
      validatePinInput(
        pinBase({ source: { origin: "tool", toolCallId: true as any } }),
      ),
    ).toThrow(MemoryValidationError);
  });

  it("accepts source with optional string turnId and toolCallId", () => {
    expect(() =>
      validatePinInput(
        pinBase({
          source: { origin: "tool", turnId: "t-1", toolCallId: "tc-1" },
        }),
      ),
    ).not.toThrow();
  });

  it("rejects non-string rationale", () => {
    expect(() => validatePinInput(pinBase({ rationale: 42 as any }))).toThrow(
      MemoryValidationError,
    );
    expect(() => validatePinInput(pinBase({ rationale: true as any }))).toThrow(
      MemoryValidationError,
    );
    expect(() => validatePinInput(pinBase({ rationale: {} as any }))).toThrow(
      MemoryValidationError,
    );
  });

  it("accepts undefined and string rationale", () => {
    expect(() => validatePinInput(pinBase())).not.toThrow();
    expect(() =>
      validatePinInput(pinBase({ rationale: "a good reason" })),
    ).not.toThrow();
  });
});

describe("validateUpdateInput", () => {
  it("accepts valid content updates", () => {
    expect(() =>
      validateUpdateInput({
        content: "Updated text",
      } satisfies UpdateMemoryInput),
    ).not.toThrow();
  });

  it("accepts undefined content", () => {
    expect(() => validateUpdateInput({})).not.toThrow();
    expect(() => validateUpdateInput({ rationale: "why" })).not.toThrow();
  });

  it("rejects empty content when provided", () => {
    expect(() => validateUpdateInput({ content: "" })).toThrow(
      MemoryValidationError,
    );
    expect(() => validateUpdateInput({ content: "  \t  " })).toThrow(
      MemoryValidationError,
    );
  });

  it("rejects oversized content (default limit 2000 chars)", () => {
    expect(() => validateUpdateInput({ content: "y".repeat(2001) })).toThrow(
      MemoryValidationError,
    );
    expect(() =>
      validateUpdateInput({ content: "y".repeat(501) }, 500),
    ).toThrow(MemoryValidationError);
  });

  it("rejects code fences in content", () => {
    expect(() => validateUpdateInput({ content: "see ```here```" })).toThrow(
      MemoryValidationError,
    );
  });

  it("rejects more than 5 lines", () => {
    const six = "1\n2\n3\n4\n5\n6";
    expect(() => validateUpdateInput({ content: six })).toThrow(
      MemoryValidationError,
    );
  });

  it("rejects non-string rationale", () => {
    expect(() => validateUpdateInput({ rationale: 123 as any })).toThrow(
      MemoryValidationError,
    );
    expect(() => validateUpdateInput({ rationale: false as any })).toThrow(
      MemoryValidationError,
    );
  });

  it("accepts undefined and string rationale", () => {
    expect(() => validateUpdateInput({})).not.toThrow();
    expect(() => validateUpdateInput({ rationale: "reason" })).not.toThrow();
  });
});

describe("normalizeContent", () => {
  it("trims leading and trailing whitespace", () => {
    expect(normalizeContent("  hello  ")).toBe("hello");
  });

  it("lowercases", () => {
    expect(normalizeContent("HeLLo WoRLd")).toBe("hello world");
  });

  it("collapses internal whitespace", () => {
    expect(normalizeContent("a\t\tb  \n c")).toBe("a b c");
  });
});

describe("isDuplicateActive", () => {
  it("returns true when an active record matches kind, scope, and normalized content", () => {
    const records = [
      record({
        id: "a",
        kind: "fact",
        scope: "project",
        content: "  Same TEXT  ",
      }),
    ];
    expect(isDuplicateActive(records, "fact", "project", "same text")).toBe(
      true,
    );
  });

  it("returns false when kind differs", () => {
    const records = [record({ kind: "fact", content: "x" })];
    expect(isDuplicateActive(records, "constraint", "session", "x")).toBe(
      false,
    );
  });

  it("returns false when scope differs", () => {
    const records = [record({ scope: "session", content: "x" })];
    expect(isDuplicateActive(records, "fact", "project", "x")).toBe(false);
  });

  it("ignores superseded records", () => {
    const records = [
      record({
        lifecycle: "superseded",
        content: "only in superseded",
        supersededById: "new-id",
      }),
    ];
    expect(
      isDuplicateActive(records, "fact", "session", "only in superseded"),
    ).toBe(false);
  });

  it("ignores removed records", () => {
    const records = [record({ lifecycle: "removed", content: "gone" })];
    expect(isDuplicateActive(records, "fact", "session", "gone")).toBe(false);
  });
});

describe("supersedRecord", () => {
  it("sets lifecycle to superseded and supersededById", () => {
    const r = record({ lifecycle: "active" });
    const next = supersedRecord(r, "replacement-99");
    expect(next.lifecycle).toBe("superseded");
    expect(next.supersededById).toBe("replacement-99");
    expect(next.id).toBe(r.id);
    expect(next.content).toBe(r.content);
  });

  it("updates updatedAt", () => {
    const r = record({ updatedAt: "2020-01-01T00:00:00.000Z" });
    jest
      .spyOn(Date.prototype, "toISOString")
      .mockReturnValueOnce("2026-06-15T10:00:00.000Z");
    const next = supersedRecord(r, "rep");
    expect(next.updatedAt).toBe("2026-06-15T10:00:00.000Z");
  });
});

describe("removeRecord", () => {
  it("sets lifecycle to removed", () => {
    const r = record();
    const next = removeRecord(r);
    expect(next.lifecycle).toBe("removed");
  });

  it("preserves rationale when not provided", () => {
    const r = record({ rationale: "original" });
    expect(removeRecord(r).rationale).toBe("original");
  });

  it("overwrites rationale when provided", () => {
    const r = record({ rationale: "original" });
    expect(removeRecord(r, "new reason").rationale).toBe("new reason");
  });

  it("updates updatedAt", () => {
    const r = record({ updatedAt: "2020-01-01T00:00:00.000Z" });
    jest
      .spyOn(Date.prototype, "toISOString")
      .mockReturnValueOnce("2026-07-01T12:00:00.000Z");
    expect(removeRecord(r).updatedAt).toBe("2026-07-01T12:00:00.000Z");
  });
});

describe("renderPinnedMemoryBlock", () => {
  it("returns empty string when there are no active records", () => {
    expect(renderPinnedMemoryBlock([])).toBe("");
    expect(
      renderPinnedMemoryBlock([
        record({ lifecycle: "removed" }),
        record({ lifecycle: "superseded", supersededById: "x" }),
      ]),
    ).toBe("");
  });

  it("renders a single constraint", () => {
    const out = renderPinnedMemoryBlock([
      record({
        kind: "constraint",
        content: "Use TypeScript",
        createdAt: "2026-01-02T00:00:00.000Z",
      }),
    ]);
    expect(out).toBe(
      "<pinned_memory>\nConstraints:\n- Use TypeScript\n</pinned_memory>",
    );
  });

  it("orders sections constraints, facts, decisions and sorts by createdAt within each", () => {
    const out = renderPinnedMemoryBlock([
      record({
        id: "d-new",
        kind: "decision",
        content: "Pick B",
        createdAt: "2026-01-03T00:00:00.000Z",
      }),
      record({
        id: "f-old",
        kind: "fact",
        content: "First fact",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      record({
        id: "c1",
        kind: "constraint",
        content: "C older",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      record({
        id: "f-new",
        kind: "fact",
        content: "Second fact",
        createdAt: "2026-01-02T00:00:00.000Z",
      }),
      record({
        id: "d-old",
        kind: "decision",
        content: "Pick A",
        createdAt: "2026-01-02T00:00:00.000Z",
      }),
      record({
        id: "c2",
        kind: "constraint",
        content: "C newer",
        createdAt: "2026-01-02T00:00:00.000Z",
      }),
    ]);
    expect(out).toBe(
      [
        "<pinned_memory>",
        "Constraints:",
        "- C older",
        "- C newer",
        "",
        "Facts:",
        "- First fact",
        "- Second fact",
        "",
        "Decisions:",
        "- Pick A",
        "- Pick B",
        "</pinned_memory>",
      ].join("\n"),
    );
  });

  it("omits non-active records", () => {
    const out = renderPinnedMemoryBlock([
      record({ id: "a", content: "keep", lifecycle: "active" }),
      record({
        id: "b",
        content: "drop",
        lifecycle: "removed",
      }),
    ]);
    expect(out).toBe("<pinned_memory>\nFacts:\n- keep\n</pinned_memory>");
  });
});

describe("clonePinnedRecord", () => {
  it("deep-clones the source object so mutations do not leak", () => {
    const original = record({
      source: { origin: "tool", turnId: "t-1", toolCallId: "tc-1" },
    });
    const cloned = clonePinnedRecord(original);

    (cloned.source as any).origin = "MUTATED";
    (cloned.source as any).turnId = "MUTATED";

    expect(original.source.origin).toBe("tool");
    expect(original.source.turnId).toBe("t-1");
  });

  it("produces an independent top-level copy", () => {
    const original = record();
    const cloned = clonePinnedRecord(original);

    (cloned as any).content = "MUTATED";

    expect(original.content).toBe("alpha");
  });
});
