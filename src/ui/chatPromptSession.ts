import * as readline from "readline";
import {
  acceptHistorySearch,
  cancelHistorySearch,
  cycleHistorySearchMatch,
  getHistorySearchSummary,
  startHistorySearch,
  updateHistorySearchQuery,
  type HistorySearchState,
} from "./historySearch.js";
import { clampPromptCursor, type PromptRequest } from "./promptState.js";
import {
  acceptTypeaheadState,
  cancelTypeaheadState,
  createTypeaheadState,
  cycleTypeaheadState,
  getTypeaheadSummary,
  type TypeaheadProvider,
  type TypeaheadState,
  type TypeaheadSummary,
} from "./typeahead.js";

export interface ChatPromptSessionState {
  buffer: string;
  cursor: number;
  historySearch?: ReturnType<typeof getHistorySearchSummary>;
  typeahead?: TypeaheadSummary;
}

export interface ChatPromptSessionCallbacks {
  render(state: ChatPromptSessionState): void;
  submit(text: string): void;
  interrupt(): void;
  close(): void;
}

export interface ChatPromptSessionOptions {
  inputStream: NodeJS.ReadStream;
  outputStream: NodeJS.WriteStream;
  request: PromptRequest;
  historySnapshot: readonly string[];
  enableTypeahead: boolean;
  workspaceRoot: string;
  typeaheadProviders: readonly TypeaheadProvider[];
  callbacks: ChatPromptSessionCallbacks;
}

export interface ChatPromptSession {
  cleanup(): void;
}

const ANSI_ESCAPE_PATTERN = /\x1B\[[0-?]*[ -/]*[@-~]/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, "");
}

function isCombiningMark(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  );
}

function isWideCharacter(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
      (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  );
}

function getDisplayWidth(text: string): number {
  let width = 0;
  for (const character of stripAnsi(text)) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }

    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      continue;
    }

    if (isCombiningMark(codePoint)) {
      continue;
    }

    width += isWideCharacter(codePoint) ? 2 : 1;
  }

  return width;
}

function renderPromptLine(
  outputStream: NodeJS.WriteStream,
  promptText: string,
  buffer: string,
  cursor: number,
  searchState: HistorySearchState | null,
  typeaheadState: TypeaheadState | null,
): void {
  const searchSummary = searchState
    ? getHistorySearchSummary(searchState)
    : null;
  const typeaheadSummary = typeaheadState
    ? getTypeaheadSummary(typeaheadState)
    : null;
  const searchPrefix = searchState ? `${promptText}history search: ` : "";
  const searchSuffix = searchState
    ? searchSummary?.match
      ? `  match: ${searchSummary.match}`
      : "  no matches"
    : "";
  const line = searchState
    ? `${searchPrefix}${searchState.query}${searchSuffix}`
    : typeaheadSummary
      ? `${promptText}${buffer}  ${formatTypeaheadSummary(typeaheadSummary)}`
      : `${promptText}${buffer}`;
  const cursorPosition = searchState
    ? getDisplayWidth(searchPrefix) + getDisplayWidth(searchState.query)
    : getDisplayWidth(promptText) +
      getDisplayWidth(
        buffer.slice(0, clampPromptCursor(cursor, buffer.length)),
      );

  if (outputStream.isTTY) {
    try {
      readline.cursorTo(outputStream, 0);
      readline.clearLine(outputStream, 0);
    } catch {
      // best effort only
    }
  } else {
    outputStream.write("\r");
  }

  outputStream.write(line);

  if (outputStream.isTTY) {
    try {
      readline.cursorTo(outputStream, cursorPosition);
    } catch {
      // best effort only
    }
  }
}

function formatTypeaheadSummary(summary: TypeaheadSummary): string {
  if (summary.matchCount === 0 || !summary.match) {
    return "tab: no matches";
  }

  if (summary.matchCount === 1) {
    return `tab: ${summary.match}`;
  }

  return `tab: ${summary.match} (${summary.matchIndex + 1}/${summary.matchCount})`;
}

function setRawMode(inputStream: NodeJS.ReadStream, enabled: boolean): void {
  const stream = inputStream as NodeJS.ReadStream & {
    setRawMode?: (mode: boolean) => void;
  };
  stream.setRawMode?.(enabled);
}

function isPrintableKey(str: string | undefined, key: readline.Key): boolean {
  return Boolean(str && !key.ctrl && !key.meta);
}

export function createChatPromptSession(
  options: ChatPromptSessionOptions,
): ChatPromptSession {
  const { callbacks, inputStream, outputStream, request, historySnapshot } =
    options;

  let buffer = request.defaultValue ?? "";
  let cursor = buffer.length;
  let historyIndex: number | null = null;
  let draftSnapshot: { buffer: string; cursor: number } | null = null;
  let searchState: HistorySearchState | null = null;
  let typeaheadState: TypeaheadState | null = null;
  let rawModeEnabled = false;
  let active = true;

  const render = (): void => {
    callbacks.render({
      buffer,
      cursor,
      historySearch: searchState
        ? getHistorySearchSummary(searchState)
        : undefined,
      typeahead: typeaheadState
        ? getTypeaheadSummary(typeaheadState)
        : undefined,
    });
    renderPromptLine(
      outputStream,
      request.promptText,
      buffer,
      cursor,
      searchState,
      typeaheadState,
    );
  };

  const clearHistoryNavigation = (): void => {
    historyIndex = null;
    draftSnapshot = null;
  };

  const syncFromSearchState = (): void => {
    if (!searchState) {
      return;
    }

    const selection = acceptHistorySearch(searchState);
    buffer = selection.buffer;
    cursor = selection.cursor;
  };

  const clearTypeahead = (): void => {
    typeaheadState = null;
  };

  const cancelTypeahead = (shouldRender: boolean): void => {
    if (!typeaheadState) {
      return;
    }

    const selection = cancelTypeaheadState(typeaheadState);
    buffer = selection.buffer;
    cursor = selection.cursor;
    clearTypeahead();
    if (shouldRender) {
      render();
    }
  };

  const startTypeahead = (): void => {
    if (!options.enableTypeahead) {
      return;
    }

    const nextState = createTypeaheadState({
      buffer,
      cursor,
      workspaceRoot: options.workspaceRoot,
      typeaheadProviders: options.typeaheadProviders,
    });

    if (!nextState) {
      return;
    }

    typeaheadState = nextState;
    if (nextState.suggestions.length > 0) {
      const selection = acceptTypeaheadState(nextState);
      buffer = selection.buffer;
      cursor = selection.cursor;
      if (nextState.suggestions.length === 1) {
        typeaheadState = null;
      }
    }

    render();
  };

  const cycleTypeahead = (): void => {
    if (!typeaheadState) {
      return;
    }

    typeaheadState = cycleTypeaheadState(typeaheadState);
    if (typeaheadState.suggestions.length > 0) {
      const selection = acceptTypeaheadState(typeaheadState);
      buffer = selection.buffer;
      cursor = selection.cursor;
    }
    render();
  };

  const exitSearch = (
    nextSelection: ReturnType<typeof cancelHistorySearch>,
  ): void => {
    searchState = null;
    historyIndex = null;
    draftSnapshot = null;
    buffer = nextSelection.buffer;
    cursor = nextSelection.cursor;
    render();
  };

  const enterSearch = (): void => {
    if (searchState) {
      searchState = cycleHistorySearchMatch(searchState);
      syncFromSearchState();
      render();
      return;
    }

    draftSnapshot = { buffer, cursor };
    searchState = startHistorySearch(historySnapshot, buffer, cursor);
    syncFromSearchState();
    render();
  };

  const updateSearchQuery = (nextQuery: string): void => {
    if (!searchState) {
      return;
    }

    searchState = updateHistorySearchQuery(searchState, nextQuery);
    syncFromSearchState();
    render();
  };

  const cancelSearch = (): void => {
    if (!searchState) {
      return;
    }

    exitSearch(cancelHistorySearch(searchState));
  };

  const acceptSearch = (): void => {
    if (!searchState) {
      return;
    }

    exitSearch(acceptHistorySearch(searchState));
  };

  const moveHistory = (direction: "up" | "down"): void => {
    if (typeaheadState) {
      cancelTypeahead(false);
    }

    if (searchState || historySnapshot.length === 0) {
      return;
    }

    if (direction === "up") {
      if (historyIndex === null) {
        draftSnapshot = { buffer, cursor };
        historyIndex = 0;
      } else if (historyIndex < historySnapshot.length - 1) {
        historyIndex += 1;
      } else {
        return;
      }

      const selected = historySnapshot[historyIndex];
      buffer = selected;
      cursor = selected.length;
      render();
      return;
    }

    if (historyIndex === null) {
      return;
    }

    if (historyIndex === 0) {
      const draft = draftSnapshot ?? { buffer: "", cursor: 0 };
      buffer = draft.buffer;
      cursor = clampPromptCursor(draft.cursor, draft.buffer.length);
      clearHistoryNavigation();
      render();
      return;
    }

    historyIndex -= 1;
    const selected = historySnapshot[historyIndex];
    buffer = selected;
    cursor = selected.length;
    render();
  };

  const insertText = (text: string): void => {
    if (typeaheadState) {
      cancelTypeahead(false);
    }

    if (searchState) {
      updateSearchQuery(`${searchState.query}${text}`);
      return;
    }

    if (historyIndex !== null) {
      clearHistoryNavigation();
    }

    buffer = `${buffer.slice(0, cursor)}${text}${buffer.slice(cursor)}`;
    cursor += text.length;
    render();
  };

  const deleteBeforeCursor = (): void => {
    if (typeaheadState) {
      cancelTypeahead(false);
    }

    if (searchState) {
      updateSearchQuery(searchState.query.slice(0, -1));
      return;
    }

    if (historyIndex !== null) {
      clearHistoryNavigation();
    }

    if (cursor === 0) {
      return;
    }

    buffer = `${buffer.slice(0, cursor - 1)}${buffer.slice(cursor)}`;
    cursor -= 1;
    render();
  };

  const deleteAtCursor = (): void => {
    if (typeaheadState) {
      cancelTypeahead(false);
    }

    if (searchState) {
      return;
    }

    if (historyIndex !== null) {
      clearHistoryNavigation();
    }

    if (cursor >= buffer.length) {
      return;
    }

    buffer = `${buffer.slice(0, cursor)}${buffer.slice(cursor + 1)}`;
    render();
  };

  const moveCursor = (direction: "left" | "right" | "home" | "end"): void => {
    if (typeaheadState) {
      cancelTypeahead(false);
    }

    if (searchState) {
      return;
    }

    if (direction === "left") {
      cursor = Math.max(0, cursor - 1);
    } else if (direction === "right") {
      cursor = Math.min(buffer.length, cursor + 1);
    } else if (direction === "home") {
      cursor = 0;
    } else {
      cursor = buffer.length;
    }

    render();
  };

  const handleEnter = (): void => {
    if (typeaheadState) {
      clearTypeahead();
    }

    if (searchState) {
      acceptSearch();
      return;
    }

    outputStream.write("\n");
    callbacks.submit(buffer);
  };

  const handleKeypress = (str: string | undefined, key: readline.Key): void => {
    if (!active) {
      return;
    }

    if (key.name === "c" && key.ctrl) {
      callbacks.interrupt();
      return;
    }

    if (key.name === "d" && key.ctrl) {
      callbacks.close();
      return;
    }

    if (key.name === "r" && key.ctrl) {
      cancelTypeahead(false);
      enterSearch();
      return;
    }

    if (key.name === "g" && key.ctrl) {
      if (searchState) {
        cancelSearch();
      } else if (typeaheadState) {
        cancelTypeahead(true);
      }
      return;
    }

    if (key.name === "escape") {
      if (searchState) {
        cancelSearch();
      } else if (typeaheadState) {
        cancelTypeahead(true);
      }
      return;
    }

    if (key.name === "return" || key.name === "enter") {
      handleEnter();
      return;
    }

    if (searchState) {
      if (key.name === "tab") {
        return;
      }

      if (key.name === "backspace" || key.name === "delete") {
        updateSearchQuery(searchState.query.slice(0, -1));
        return;
      }

      if (isPrintableKey(str, key)) {
        insertText(str ?? "");
      }
      return;
    }

    if (key.name === "tab") {
      if (typeaheadState) {
        cycleTypeahead();
      } else {
        startTypeahead();
      }
      return;
    }

    switch (key.name) {
      case "backspace":
        deleteBeforeCursor();
        return;
      case "delete":
        deleteAtCursor();
        return;
      case "left":
        moveCursor("left");
        return;
      case "right":
        moveCursor("right");
        return;
      case "home":
        moveCursor("home");
        return;
      case "end":
        moveCursor("end");
        return;
      case "up":
        moveHistory("up");
        return;
      case "down":
        moveHistory("down");
        return;
    }

    if (isPrintableKey(str, key)) {
      insertText(str ?? "");
    }
  };

  const restoreRawMode = (): void => {
    if (rawModeEnabled) {
      setRawMode(inputStream, false);
      rawModeEnabled = false;
    }

    inputStream.resume();
  };

  const cleanup = (): void => {
    if (!active) {
      return;
    }

    active = false;
    inputStream.removeListener("keypress", handleKeypress as never);
    restoreRawMode();
  };

  inputStream.on("keypress", handleKeypress as never);
  if (
    typeof (
      inputStream as NodeJS.ReadStream & {
        setRawMode?: (mode: boolean) => void;
      }
    ).setRawMode === "function"
  ) {
    setRawMode(inputStream, true);
    rawModeEnabled = true;
  }
  inputStream.resume();
  render();

  return {
    cleanup,
  };
}
