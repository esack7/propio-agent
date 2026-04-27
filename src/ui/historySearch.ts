export interface HistorySearchState {
  query: string;
  entries: readonly string[];
  matches: readonly string[];
  selectedMatchIndex: number;
  originalBuffer: string;
  originalCursor: number;
}

export interface HistorySearchSummary {
  active: boolean;
  query: string;
  match?: string;
  matchIndex: number;
  matchCount: number;
}

export interface HistorySearchSelection {
  buffer: string;
  cursor: number;
}

function normalizeQuery(query: string): string {
  return query.toLowerCase();
}

function findMatches(
  entries: readonly string[],
  query: string,
): readonly string[] {
  const normalizedQuery = normalizeQuery(query);

  if (normalizedQuery.length === 0) {
    return [...entries];
  }

  return entries.filter((entry) =>
    normalizeQuery(entry).includes(normalizedQuery),
  );
}

function createSearchState(
  entries: readonly string[],
  originalBuffer: string,
  originalCursor: number,
  query: string,
): HistorySearchState {
  const matches = findMatches(entries, query);
  return {
    query,
    entries: [...entries],
    matches,
    selectedMatchIndex: matches.length > 0 ? 0 : -1,
    originalBuffer,
    originalCursor,
  };
}

export function startHistorySearch(
  entries: readonly string[],
  originalBuffer: string,
  originalCursor: number,
): HistorySearchState {
  return createSearchState(entries, originalBuffer, originalCursor, "");
}

export function updateHistorySearchQuery(
  state: HistorySearchState,
  query: string,
): HistorySearchState {
  return createSearchState(
    state.entries,
    state.originalBuffer,
    state.originalCursor,
    query,
  );
}

export function cycleHistorySearchMatch(
  state: HistorySearchState,
): HistorySearchState {
  if (state.matches.length === 0) {
    return state;
  }

  return {
    ...state,
    selectedMatchIndex: (state.selectedMatchIndex + 1) % state.matches.length,
  };
}

export function acceptHistorySearch(
  state: HistorySearchState,
): HistorySearchSelection {
  const selectedMatch =
    state.matches.length > 0 && state.selectedMatchIndex >= 0
      ? state.matches[state.selectedMatchIndex]
      : undefined;

  const buffer = selectedMatch ?? state.originalBuffer;
  return {
    buffer,
    cursor: buffer.length,
  };
}

export function cancelHistorySearch(
  state: HistorySearchState,
): HistorySearchSelection {
  return {
    buffer: state.originalBuffer,
    cursor: state.originalCursor,
  };
}

export function getHistorySearchSummary(
  state: HistorySearchState,
): HistorySearchSummary {
  const match =
    state.matches.length > 0 && state.selectedMatchIndex >= 0
      ? state.matches[state.selectedMatchIndex]
      : undefined;

  return {
    active: true,
    query: state.query,
    match,
    matchIndex: state.selectedMatchIndex,
    matchCount: state.matches.length,
  };
}
