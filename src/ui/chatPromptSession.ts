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
import { openPromptEditor, type PromptEditorRunner } from "./promptEditor.js";
import { watchTerminalResize } from "./terminalWriter.js";

export interface ChatPromptSessionState {
  buffer: string;
  cursor: number;
  historySearch?: ReturnType<typeof getHistorySearchSummary>;
  typeahead?: TypeaheadSummary;
  multiline?: boolean;
  editorStatus?: string;
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
  enableReverseHistorySearch: boolean;
  workspaceRoot: string;
  typeaheadProviders: readonly TypeaheadProvider[];
  editorRunner?: PromptEditorRunner;
  editorEnv?: NodeJS.ProcessEnv;
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

function sanitizePromptPreview(text: string): string {
  return text.replace(/\r?\n/g, " ⏎ ");
}

function getLineStartIndex(buffer: string, cursor: number): number {
  const clampedCursor = clampPromptCursor(cursor, buffer.length);
  const previousNewline = buffer.lastIndexOf("\n", clampedCursor - 1);
  return previousNewline >= 0 ? previousNewline + 1 : 0;
}

function getLineEndIndex(buffer: string, cursor: number): number {
  const clampedCursor = clampPromptCursor(cursor, buffer.length);
  const nextNewline = buffer.indexOf("\n", clampedCursor);
  return nextNewline >= 0 ? nextNewline : buffer.length;
}

function getLineColumn(buffer: string, cursor: number): number {
  return (
    clampPromptCursor(cursor, buffer.length) - getLineStartIndex(buffer, cursor)
  );
}

function isWhitespaceCharacter(character: string | undefined): boolean {
  return character !== undefined && /\s/.test(character);
}

function getPreviousWordBoundary(buffer: string, cursor: number): number {
  let nextCursor = clampPromptCursor(cursor, buffer.length);

  while (nextCursor > 0 && isWhitespaceCharacter(buffer[nextCursor - 1])) {
    nextCursor -= 1;
  }

  while (nextCursor > 0 && !isWhitespaceCharacter(buffer[nextCursor - 1])) {
    nextCursor -= 1;
  }

  return nextCursor;
}

function getNextWordBoundary(buffer: string, cursor: number): number {
  let nextCursor = clampPromptCursor(cursor, buffer.length);

  while (
    nextCursor < buffer.length &&
    isWhitespaceCharacter(buffer[nextCursor])
  ) {
    nextCursor += 1;
  }

  while (
    nextCursor < buffer.length &&
    !isWhitespaceCharacter(buffer[nextCursor])
  ) {
    nextCursor += 1;
  }

  return nextCursor;
}

interface WrappedPromptSegment {
  text: string;
  start: number;
  end: number;
}

function splitLongTokenByWidth(
  token: string,
  tokenStart: number,
  width: number,
): WrappedPromptSegment[] {
  const segments: WrappedPromptSegment[] = [];
  let current = "";
  let currentWidth = 0;
  let currentStart = tokenStart;
  let offset = 0;

  for (const character of token) {
    const characterWidth = getDisplayWidth(character);
    const characterStart = tokenStart + offset;
    const characterEnd = characterStart + character.length;

    if (current.length > 0 && currentWidth + characterWidth > width) {
      segments.push({
        text: current,
        start: currentStart,
        end: characterStart,
      });
      current = character;
      currentWidth = characterWidth;
      currentStart = characterStart;
      offset += character.length;
      continue;
    }

    if (current.length === 0 && characterWidth > width) {
      segments.push({
        text: character,
        start: characterStart,
        end: characterEnd,
      });
      offset += character.length;
      currentStart = characterEnd;
      continue;
    }

    current += character;
    currentWidth += characterWidth;
    offset += character.length;
  }

  if (current.length > 0) {
    segments.push({
      text: current,
      start: currentStart,
      end: tokenStart + token.length,
    });
  }

  return segments;
}

function wrapLineByWidth(line: string, width: number): WrappedPromptSegment[] {
  if (!Number.isFinite(width) || width <= 0) {
    return [{ text: line, start: 0, end: line.length }];
  }

  const segments: WrappedPromptSegment[] = [];
  let current = "";
  let currentWidth = 0;
  let currentStart = 0;
  const tokenPattern = /[^\S\n]+|\S+/g;
  const tokens = line.matchAll(tokenPattern);

  for (const match of tokens) {
    const token = match[0];
    const tokenStart = match.index ?? 0;
    const tokenEnd = tokenStart + token.length;
    const tokenWidth = getDisplayWidth(token);

    if (current.length > 0 && currentWidth + tokenWidth > width) {
      segments.push({
        text: current,
        start: currentStart,
        end: tokenStart,
      });
      current = "";
      currentWidth = 0;
      currentStart = tokenStart;
    }

    if (tokenWidth > width) {
      if (current.length > 0) {
        segments.push({
          text: current,
          start: currentStart,
          end: tokenStart,
        });
        current = "";
        currentWidth = 0;
      }

      segments.push(...splitLongTokenByWidth(token, tokenStart, width));
      currentStart = tokenEnd;
      continue;
    }

    if (current.length === 0) {
      currentStart = tokenStart;
    }

    current += token;
    currentWidth += tokenWidth;
  }

  if (current.length > 0 || line.length === 0) {
    segments.push({
      text: current,
      start: currentStart,
      end: currentStart + current.length,
    });
  }

  return segments;
}

interface PromptLayout {
  lines: string[];
  cursorRow: number;
  cursorCol: number;
  totalRows: number;
}

function buildPromptLayout(
  promptText: string,
  buffer: string,
  cursor: number,
  statusLine: string | null,
  outputStream: NodeJS.WriteStream,
): PromptLayout {
  const promptWidth = getDisplayWidth(promptText);
  const availableWidth = outputStream.isTTY
    ? Math.max(1, (outputStream.columns ?? 80) - promptWidth)
    : Number.POSITIVE_INFINITY;
  const indent = " ".repeat(promptWidth);
  const logicalLines = buffer.split("\n");
  const lines: string[] = [];
  let cursorRow = 0;
  let cursorCol = promptWidth;
  let consumedCharacters = 0;
  let renderedRows = 0;

  for (let lineIndex = 0; lineIndex < logicalLines.length; lineIndex += 1) {
    const line = logicalLines[lineIndex];
    const wrapped = wrapLineByWidth(line, availableWidth);

    for (
      let segmentIndex = 0;
      segmentIndex < wrapped.length;
      segmentIndex += 1
    ) {
      const prefix =
        lineIndex === 0 && segmentIndex === 0 ? promptText : indent;
      lines.push(`${prefix}${wrapped[segmentIndex].text}`);
    }

    const lineLength = line.length;
    const cursorLineEnd = consumedCharacters + lineLength;
    const cursorLineStart = consumedCharacters;

    if (cursor >= cursorLineStart && cursor <= cursorLineEnd) {
      const lineCursorOffset = cursor - cursorLineStart;
      const segmentIndex = Math.max(
        0,
        wrapped.findIndex(
          (segment, index) =>
            lineCursorOffset >= segment.start &&
            (lineCursorOffset < segment.end ||
              index === wrapped.length - 1 ||
              lineCursorOffset === segment.start),
        ),
      );
      const segment = wrapped[segmentIndex];
      const columnInSegment = getDisplayWidth(
        line.slice(segment.start, lineCursorOffset),
      );
      cursorRow = renderedRows + segmentIndex;
      cursorCol = promptWidth + columnInSegment;
    }

    renderedRows += wrapped.length;
    consumedCharacters += lineLength + 1;
  }

  if (statusLine) {
    lines.push(statusLine);
  }

  return {
    lines,
    cursorRow,
    cursorCol,
    totalRows: renderedRows + (statusLine ? 1 : 0),
  };
}

export function renderPromptFrame(
  outputStream: NodeJS.WriteStream,
  promptText: string,
  buffer: string,
  cursor: number,
  searchState: HistorySearchState | null,
  typeaheadState: TypeaheadState | null,
  editorStatus: string | undefined,
): PromptLayout {
  if (searchState) {
    const searchSummary = getHistorySearchSummary(searchState);
    const searchPrefix = `${promptText}history search: `;
    const searchSuffix = searchSummary.match
      ? `  match: ${sanitizePromptPreview(searchSummary.match)}`
      : "  no matches";
    const line = `${searchPrefix}${sanitizePromptPreview(searchState.query)}${searchSuffix}`;
    const cursorPosition =
      getDisplayWidth(searchPrefix) + getDisplayWidth(searchState.query);

    return {
      lines: [line],
      cursorRow: 0,
      cursorCol: cursorPosition,
      totalRows: 1,
    };
  }

  const statusLine = editorStatus
    ? editorStatus
    : typeaheadState
      ? formatTypeaheadSummary(getTypeaheadSummary(typeaheadState))
      : null;

  return buildPromptLayout(
    promptText,
    buffer,
    cursor,
    statusLine,
    outputStream,
  );
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
  let editorStatus: string | undefined;
  let pendingEditorHandoff = false;
  let rawModeEnabled = false;
  let active = true;
  let lastLayout: PromptLayout | null = null;

  const render = (): void => {
    const layout = renderPromptFrame(
      outputStream,
      request.promptText,
      buffer,
      cursor,
      searchState,
      typeaheadState,
      editorStatus,
    );

    callbacks.render({
      buffer,
      cursor,
      historySearch: searchState
        ? getHistorySearchSummary(searchState)
        : undefined,
      typeahead: typeaheadState
        ? getTypeaheadSummary(typeaheadState)
        : undefined,
      multiline: buffer.includes("\n"),
      editorStatus,
    });

    if (outputStream.isTTY) {
      if (lastLayout) {
        try {
          readline.moveCursor(
            outputStream,
            -lastLayout.cursorCol,
            -lastLayout.cursorRow,
          );
          readline.cursorTo(outputStream, 0);
          readline.clearScreenDown(outputStream);
        } catch {
          // best effort only
        }
      }
    } else if (lastLayout) {
      outputStream.write("\r");
    }

    outputStream.write(layout.lines.join("\n"));

    if (outputStream.isTTY) {
      try {
        readline.moveCursor(
          outputStream,
          0,
          layout.cursorRow - layout.totalRows + 1,
        );
        readline.cursorTo(outputStream, layout.cursorCol);
      } catch {
        // best effort only
      }
    }

    lastLayout = layout;
  };

  const unwatchResize = watchTerminalResize(outputStream, () => {
    if (active) {
      render();
    }
  });

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

  const clearTransientStatus = (): void => {
    editorStatus = undefined;
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
    clearTransientStatus();
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
    clearTransientStatus();
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
    clearTransientStatus();
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
    clearTransientStatus();
    if (!searchState) {
      return;
    }

    searchState = updateHistorySearchQuery(searchState, nextQuery);
    syncFromSearchState();
    render();
  };

  const cancelSearch = (): void => {
    clearTransientStatus();
    if (!searchState) {
      return;
    }

    exitSearch(cancelHistorySearch(searchState));
  };

  const acceptSearch = (): void => {
    clearTransientStatus();
    if (!searchState) {
      return;
    }

    exitSearch(acceptHistorySearch(searchState));
  };

  const moveHistory = (direction: "up" | "down"): void => {
    clearTransientStatus();
    if (typeaheadState) {
      cancelTypeahead(false);
    }

    if (searchState) {
      return;
    }

    const currentLineStart = getLineStartIndex(buffer, cursor);
    const currentLineEnd = getLineEndIndex(buffer, cursor);
    const lineIndex = buffer.slice(0, currentLineStart).split("\n").length - 1;
    const totalLines = buffer.length === 0 ? 1 : buffer.split("\n").length;

    if (direction === "up" && lineIndex > 0) {
      clearTransientStatus();
      const previousLineStart = buffer.lastIndexOf("\n", currentLineStart - 2);
      const previousLineEnd = currentLineStart - 1;
      const targetColumn = getLineColumn(buffer, cursor);
      const targetStart = previousLineStart >= 0 ? previousLineStart + 1 : 0;
      cursor = Math.min(targetStart + targetColumn, previousLineEnd);
      render();
      return;
    }

    if (direction === "up") {
      if (historySnapshot.length === 0) {
        return;
      }

      if (historyIndex === null) {
        clearTransientStatus();
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

    if (direction === "down" && lineIndex < totalLines - 1) {
      clearTransientStatus();
      const targetColumn = getLineColumn(buffer, cursor);
      const nextLineStart = currentLineEnd + 1;
      const nextLineEnd = buffer.indexOf("\n", nextLineStart);
      cursor = Math.min(
        nextLineStart + targetColumn,
        nextLineEnd >= 0 ? nextLineEnd : buffer.length,
      );
      render();
      return;
    }

    if (historySnapshot.length === 0) {
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
    clearTransientStatus();
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
    clearTransientStatus();
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
    clearTransientStatus();
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

  const deleteWordBeforeCursor = (): void => {
    clearTransientStatus();
    if (typeaheadState) {
      cancelTypeahead(false);
    }

    if (searchState) {
      const nextCursor = getPreviousWordBoundary(
        searchState.query,
        searchState.query.length,
      );
      updateSearchQuery(searchState.query.slice(0, nextCursor));
      return;
    }

    if (historyIndex !== null) {
      clearHistoryNavigation();
    }

    if (cursor === 0) {
      return;
    }

    const nextCursor = getPreviousWordBoundary(buffer, cursor);
    buffer = `${buffer.slice(0, nextCursor)}${buffer.slice(cursor)}`;
    cursor = nextCursor;
    render();
  };

  const moveCursor = (direction: "left" | "right" | "home" | "end"): void => {
    clearTransientStatus();
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
      cursor = getLineStartIndex(buffer, cursor);
    } else {
      cursor = getLineEndIndex(buffer, cursor);
    }

    render();
  };

  const moveCursorByWord = (direction: "left" | "right"): void => {
    clearTransientStatus();
    if (typeaheadState) {
      cancelTypeahead(false);
    }

    if (searchState) {
      return;
    }

    cursor =
      direction === "left"
        ? getPreviousWordBoundary(buffer, cursor)
        : getNextWordBoundary(buffer, cursor);
    render();
  };

  const openEditor = (): void => {
    if (searchState) {
      return;
    }

    pendingEditorHandoff = false;
    clearTransientStatus();

    if (typeaheadState) {
      cancelTypeahead(false);
    }

    clearHistoryNavigation();

    const wasRawModeEnabled = rawModeEnabled;
    if (wasRawModeEnabled) {
      setRawMode(inputStream, false);
      rawModeEnabled = false;
    }

    inputStream.pause();

    try {
      const result = openPromptEditor({
        buffer,
        workspaceRoot: options.workspaceRoot,
        env: options.editorEnv,
        runEditor: options.editorRunner,
      });

      if (result.status === "edited") {
        buffer = result.buffer;
        cursor = buffer.length;
        editorStatus = undefined;
      } else {
        editorStatus = result.message;
      }
    } finally {
      inputStream.resume();
      if (wasRawModeEnabled) {
        setRawMode(inputStream, true);
        rawModeEnabled = true;
      }
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
      if (!options.enableReverseHistorySearch) {
        return;
      }
      cancelTypeahead(false);
      enterSearch();
      return;
    }

    if (pendingEditorHandoff) {
      pendingEditorHandoff = false;
      if (key.name === "e" && key.ctrl) {
        openEditor();
        return;
      }
    }

    if (key.name === "x" && key.ctrl) {
      if (!searchState) {
        pendingEditorHandoff = true;
      }
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

    if (!searchState && ((key.name === "j" && key.ctrl) || str === "\n")) {
      insertText("\n");
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

    if (
      (key.name === "left" || key.name === "right") &&
      (key.ctrl || key.meta)
    ) {
      moveCursorByWord(key.name);
      return;
    }

    if (key.meta && (key.name === "b" || key.name === "f")) {
      moveCursorByWord(key.name === "b" ? "left" : "right");
      return;
    }

    switch (key.name) {
      case "backspace":
        if (key.meta) {
          deleteWordBeforeCursor();
          return;
        }
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

    inputStream.pause();
  };

  const cleanup = (): void => {
    if (!active) {
      return;
    }

    active = false;
    unwatchResize();
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
