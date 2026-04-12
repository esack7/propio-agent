import {
  acceptHistorySearch,
  cancelHistorySearch,
  cycleHistorySearchMatch,
  getHistorySearchSummary,
  startHistorySearch,
  updateHistorySearchQuery,
} from "../historySearch.js";

describe("historySearch", () => {
  it("starts with the original draft and newest-first matches", () => {
    const state = startHistorySearch(["newest", "older", "oldest"], "draft", 2);

    expect(state.query).toBe("");
    expect(state.entries).toEqual(["newest", "older", "oldest"]);
    expect(state.matches).toEqual(["newest", "older", "oldest"]);
    expect(state.selectedMatchIndex).toBe(0);
    expect(state.originalBuffer).toBe("draft");
    expect(state.originalCursor).toBe(2);
  });

  it("matches case-insensitively and narrows with query edits", () => {
    const state = startHistorySearch(
      ["Alpha", "beta alpha", "gamma"],
      "draft",
      0,
    );
    const narrowed = updateHistorySearchQuery(state, "ALP");

    expect(narrowed.matches).toEqual(["Alpha", "beta alpha"]);
    expect(narrowed.selectedMatchIndex).toBe(0);

    const broadened = updateHistorySearchQuery(narrowed, "AL");
    expect(broadened.matches).toEqual(["Alpha", "beta alpha"]);
  });

  it("treats empty history and no-match queries as stable", () => {
    const empty = startHistorySearch([], "draft", 4);

    expect(empty.matches).toEqual([]);
    expect(empty.selectedMatchIndex).toBe(-1);

    const noMatch = updateHistorySearchQuery(empty, "missing");
    expect(noMatch.matches).toEqual([]);
    expect(noMatch.selectedMatchIndex).toBe(-1);
    expect(acceptHistorySearch(noMatch)).toEqual({
      buffer: "draft",
      cursor: 5,
    });
  });

  it("cycles through older matches and wraps", () => {
    const initial = startHistorySearch(
      ["match 1", "match 2", "match 3"],
      "draft",
      0,
    );
    const query = updateHistorySearchQuery(initial, "match");
    const next = cycleHistorySearchMatch(query);
    const oldest = cycleHistorySearchMatch(next);
    const wrapped = cycleHistorySearchMatch(oldest);

    expect(getHistorySearchSummary(query).match).toBe("match 1");
    expect(getHistorySearchSummary(next).match).toBe("match 2");
    expect(getHistorySearchSummary(oldest).match).toBe("match 3");
    expect(getHistorySearchSummary(wrapped).match).toBe("match 1");
  });

  it("accepts the selected match and cancels back to the draft", () => {
    const initial = startHistorySearch(
      ["newest", "older", "oldest"],
      "draft",
      3,
    );
    const query = updateHistorySearchQuery(initial, "old");
    const cycled = cycleHistorySearchMatch(query);

    expect(acceptHistorySearch(cycled)).toEqual({
      buffer: "oldest",
      cursor: 6,
    });
    expect(cancelHistorySearch(cycled)).toEqual({
      buffer: "draft",
      cursor: 3,
    });
  });
});
