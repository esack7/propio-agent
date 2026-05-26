import { isSafeSessionId } from "../sessionId.js";

describe("isSafeSessionId", () => {
  it("accepts UUIDs", () => {
    expect(isSafeSessionId("11111111-1111-4111-8111-111111111111")).toBe(true);
  });

  it("accepts snapshot-style ids", () => {
    expect(isSafeSessionId("2026-03-29T10-00-00.000Z-abc123")).toBe(true);
  });

  it("rejects path separators and traversal", () => {
    expect(isSafeSessionId("../../etc")).toBe(false);
    expect(isSafeSessionId("a/b")).toBe(false);
    expect(isSafeSessionId("..")).toBe(false);
    expect(isSafeSessionId(".")).toBe(false);
  });
});
