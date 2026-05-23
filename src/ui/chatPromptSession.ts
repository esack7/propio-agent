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
  applyInputModeFromBuffer,
  type InputMode,
} from "./inputModes.js";
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
import { formatSubtle } from "./formatting.js";

export interface ChatPromptSessionState {
  buffer: string;
  cursor: number;
  inputMode: InputMode;
  footer: string | null;
  historySearch?: ReturnType<typeof getHistorySearchSummary>;
  typeahead?: TypeaheadSummary;
  multiline?: boolean;
  editorStatus?: string;
}

export interface ChatPromptSessionCallbacks {
  render(state: ChatPromptSessionState): void;
  submit(text: string, inputMode: InputMode): void;
  interrupt(): void;
  toggleToolCalls?: () => string | null | undefined;
  toggleThinking?: () => string | null | undefined;
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

type CodePointRange = readonly [number, number];

const COMBINING_MARK_RANGES: readonly CodePointRange[] = [
  [0x0300, 0x036f],
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x20d0, 0x20ff],
  [0xfe20, 0xfe2f],
];

const WIDE_CHARACTER_RANGES: readonly CodePointRange[] = [
  [0x1100, 0x115f],
  [0x2329, 0x2329],
  [0x232a, 0x232a],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
];

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, "");
}

function inCodePointRanges(
  codePoint: number,
  ranges: readonly CodePointRange[],
): boolean {
  return ranges.some(([start, end]) => codePoint >= start && codePoint <= end);
}

function isCombiningMark(codePoint: number): boolean {
  return inCodePointRanges(codePoint, COMBINING_MARK_RANGES);
}

function isWideCharacter(codePoint: number): boolean {
  return (
    codePoint !== 0x303f && inCodePointRanges(codePoint, WIDE_CHARACTER_RANGES)
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

function firstLinePreview(text: string): string {
  return text.split(/\r\n|\r|\n/, 1)[0] ?? "";
}

function truncateToDisplayWidth(text: string, maxWidth: number): string {
  if (!Number.isFinite(maxWidth) || getDisplayWidth(text) <= maxWidth) {
    return text;
  }

  if (maxWidth <= 0) {
    return "";
  }

  const marker = maxWidth >= 4 ? "..." : "";
  const contentWidth = Math.max(0, maxWidth - getDisplayWidth(marker));
  let result = "";
  let width = 0;

  for (let index = 0; index < text.length; ) {
    const ansiMatch = text.slice(index).match(/^\x1B\[[0-?]*[ -/]*[@-~]/);
    if (ansiMatch) {
      result += ansiMatch[0];
      index += ansiMatch[0].length;
      continue;
    }

    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) {
      break;
    }

    const character = String.fromCodePoint(codePoint);
    const characterWidth = getDisplayWidth(character);
    if (width + characterWidth > contentWidth) {
      break;
    }

    result += character;
    width += characterWidth;
    index += character.length;
  }

  return `${result}${marker}`;
}

function getPromptStatusLineWidth(outputStream: NodeJS.WriteStream): number {
  if (!outputStream.isTTY) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.max(1, (outputStream.columns ?? 80) - 1);
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

interface WrapLineState {
  current: string;
  currentWidth: number;
  currentStart: number;
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

function flushWrappedLineState(
  segments: WrappedPromptSegment[],
  state: WrapLineState,
  end: number,
): WrapLineState {
  if (state.current.length === 0) {
    return state;
  }

  segments.push({
    text: state.current,
    start: state.currentStart,
    end,
  });
  return {
    current: "",
    currentWidth: 0,
    currentStart: end,
  };
}

function appendWrappedLineToken(
  state: WrapLineState,
  token: string,
  tokenStart: number,
  tokenWidth: number,
): WrapLineState {
  return {
    current: `${state.current}${token}`,
    currentWidth: state.currentWidth + tokenWidth,
    currentStart: state.current.length === 0 ? tokenStart : state.currentStart,
  };
}

function processWrappedLineToken(
  segments: WrappedPromptSegment[],
  state: WrapLineState,
  token: string,
  tokenStart: number,
  width: number,
): WrapLineState {
  const tokenWidth = getDisplayWidth(token);
  const tokenEnd = tokenStart + token.length;
  const nextState =
    state.current.length > 0 && state.currentWidth + tokenWidth > width
      ? flushWrappedLineState(segments, state, tokenStart)
      : state;

  if (tokenWidth > width) {
    const flushedState = flushWrappedLineState(segments, nextState, tokenStart);
    segments.push(...splitLongTokenByWidth(token, tokenStart, width));
    return {
      ...flushedState,
      currentStart: tokenEnd,
    };
  }

  return appendWrappedLineToken(nextState, token, tokenStart, tokenWidth);
}

function wrapLineByWidth(line: string, width: number): WrappedPromptSegment[] {
  if (!Number.isFinite(width) || width <= 0) {
    return [{ text: line, start: 0, end: line.length }];
  }

  const segments: WrappedPromptSegment[] = [];
  const tokenPattern = /[^\S\n]+|\S+/g;
  let state: WrapLineState = {
    current: "",
    currentWidth: 0,
    currentStart: 0,
  };

  for (const match of line.matchAll(tokenPattern)) {
    state = processWrappedLineToken(
      segments,
      state,
      match[0],
      match.index ?? 0,
      width,
    );
  }

  if (state.current.length > 0 || line.length === 0) {
    segments.push({
      text: state.current,
      start: state.currentStart,
      end: state.currentStart + state.current.length,
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

interface PhysicalCursorPosition {
  row: number;
  col: number;
}

function getTerminalColumns(outputStream: NodeJS.WriteStream): number {
  return Math.max(1, outputStream.columns ?? 80);
}

function countPhysicalRows(line: string, columns: number): number {
  const width = getDisplayWidth(line);
  return Math.max(1, Math.ceil(width / columns));
}

function getLayoutCursorPosition(
  layout: PromptLayout,
  outputStream: NodeJS.WriteStream,
): PhysicalCursorPosition {
  const columns = getTerminalColumns(outputStream);
  const cursorLine = layout.lines[layout.cursorRow] ?? "";
  const cursorCol = Math.min(layout.cursorCol, getDisplayWidth(cursorLine));
  const previousRows = layout.lines
    .slice(0, layout.cursorRow)
    .reduce((count, line) => count + countPhysicalRows(line, columns), 0);

  return {
    row: previousRows + Math.floor(cursorCol / columns),
    col: cursorCol % columns,
  };
}

function getLayoutEndRow(
  layout: PromptLayout,
  outputStream: NodeJS.WriteStream,
): number {
  const columns = getTerminalColumns(outputStream);
  const totalRows = layout.lines.reduce(
    (count, line) => count + countPhysicalRows(line, columns),
    0,
  );
  return Math.max(0, totalRows - 1);
}

function formatFooterLines(
  footer: string | undefined,
  outputStream: NodeJS.WriteStream,
): string[] {
  if (!footer) {
    return [];
  }

  const maxLineWidth = getPromptStatusLineWidth(outputStream);
  return footer
    .split(/\r\n|\r|\n/)
    .flatMap((line) =>
      wrapLineByWidth(line, maxLineWidth).map((segment) =>
        formatSubtle(segment.text.trimEnd()),
      ),
    );
}

interface PromptLayoutBuildState {
  lines: string[];
  cursorRow: number;
  cursorCol: number;
  consumedCharacters: number;
  renderedRows: number;
  footerRows: number;
  promptWidth: number;
  indent: string;
}

function appendWrappedPromptLines(
  state: PromptLayoutBuildState,
  promptText: string,
  lineIndex: number,
  wrapped: WrappedPromptSegment[],
): void {
  for (let segmentIndex = 0; segmentIndex < wrapped.length; segmentIndex += 1) {
    const prefix =
      lineIndex === 0 && segmentIndex === 0 ? promptText : state.indent;
    state.lines.push(`${prefix}${wrapped[segmentIndex].text}`);
  }
}

function findWrappedCursorPosition(
  line: string,
  wrapped: WrappedPromptSegment[],
  lineCursorOffset: number,
): { segmentIndex: number; columnInSegment: number } {
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
  return {
    segmentIndex,
    columnInSegment: getDisplayWidth(
      line.slice(segment.start, lineCursorOffset),
    ),
  };
}

function updatePromptLayoutCursor(
  state: PromptLayoutBuildState,
  line: string,
  wrapped: WrappedPromptSegment[],
  cursor: number,
): void {
  const lineLength = line.length;
  const cursorLineStart = state.consumedCharacters;
  const cursorLineEnd = cursorLineStart + lineLength;
  if (cursor < cursorLineStart || cursor > cursorLineEnd) {
    return;
  }

  const lineCursorOffset = cursor - cursorLineStart;
  const { segmentIndex, columnInSegment } = findWrappedCursorPosition(
    line,
    wrapped,
    lineCursorOffset,
  );
  state.cursorRow = state.footerRows + state.renderedRows + segmentIndex;
  state.cursorCol = state.promptWidth + columnInSegment;
}

function appendPromptLayoutLine(
  state: PromptLayoutBuildState,
  promptText: string,
  line: string,
  lineIndex: number,
  availableWidth: number,
  cursor: number,
): void {
  const wrapped = wrapLineByWidth(line, availableWidth);
  appendWrappedPromptLines(state, promptText, lineIndex, wrapped);
  updatePromptLayoutCursor(state, line, wrapped, cursor);
  state.renderedRows += wrapped.length;
  state.consumedCharacters += line.length + 1;
}

function buildPromptLayout(
  promptText: string,
  buffer: string,
  cursor: number,
  footer: string | undefined,
  statusLine: string | null,
  outputStream: NodeJS.WriteStream,
): PromptLayout {
  const promptWidth = getDisplayWidth(promptText);
  const availableWidth = outputStream.isTTY
    ? Math.max(1, (outputStream.columns ?? 80) - promptWidth)
    : Number.POSITIVE_INFINITY;
  const lines = formatFooterLines(footer, outputStream);
  const state: PromptLayoutBuildState = {
    lines,
    cursorRow: lines.length,
    cursorCol: promptWidth,
    consumedCharacters: 0,
    renderedRows: 0,
    footerRows: lines.length,
    promptWidth,
    indent: " ".repeat(promptWidth),
  };

  buffer
    .split("\n")
    .forEach((line, lineIndex) =>
      appendPromptLayoutLine(
        state,
        promptText,
        line,
        lineIndex,
        availableWidth,
        cursor,
      ),
    );

  if (statusLine) {
    state.lines.push(statusLine);
  }

  return {
    lines: state.lines,
    cursorRow: state.cursorRow,
    cursorCol: state.cursorCol,
    totalRows: state.footerRows + state.renderedRows + (statusLine ? 1 : 0),
  };
}

function renderPromptFrame(
  outputStream: NodeJS.WriteStream,
  promptText: string,
  buffer: string,
  cursor: number,
  footer: string | undefined,
  searchState: HistorySearchState | null,
  typeaheadState: TypeaheadState | null,
  editorStatus: string | undefined,
): PromptLayout {
  if (searchState) {
    const searchSummary = getHistorySearchSummary(searchState);
    const searchPrefix = `${promptText}history search: `;
    const queryPreview = firstLinePreview(searchState.query);
    const searchSuffix = searchSummary.match
      ? `  match: ${firstLinePreview(searchSummary.match)}`
      : "  no matches";
    const maxLineWidth = getPromptStatusLineWidth(outputStream);
    const line = truncateToDisplayWidth(
      `${searchPrefix}${queryPreview}${searchSuffix}`,
      maxLineWidth,
    );
    const cursorPosition = Math.min(
      getDisplayWidth(searchPrefix) + getDisplayWidth(queryPreview),
      getDisplayWidth(line),
    );

    const footerLines = formatFooterLines(footer, outputStream);
    return {
      lines: [...footerLines, line],
      cursorRow: footerLines.length,
      cursorCol: cursorPosition,
      totalRows: footerLines.length + 1,
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
    footer,
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

  let inputMode: InputMode = request.inputMode ?? "prompt";
  let buffer = request.defaultValue ?? "";
  let cursor = buffer.length;

  const getActivePromptText = (): string =>
    inputMode === "bash"
      ? (request.bashPromptText ?? request.promptText)
      : request.promptText;

  const syncBufferInputMode = (): void => {
    const result = applyInputModeFromBuffer(inputMode, buffer);
    if (result.inputMode !== inputMode || result.buffer !== buffer) {
      inputMode = result.inputMode;
      buffer = result.buffer;
      cursor = clampPromptCursor(
        cursor + result.cursorAdjusted,
        buffer.length,
      );
    }
  };

  syncBufferInputMode();
  let historyIndex: number | null = null;
  let draftSnapshot: { buffer: string; cursor: number } | null = null;
  let searchState: HistorySearchState | null = null;
  let typeaheadState: TypeaheadState | null = null;
  let typeaheadPreviewApplied = false;
  let mentionTypeaheadRetryTimer: NodeJS.Timeout | null = null;
  let mentionTypeaheadRetryKey = "";
  let mentionTypeaheadRetryCount = 0;
  let editorStatus: string | undefined;
  let pendingEditorHandoff = false;
  let rawModeEnabled = false;
  let active = true;
  let lastLayout: PromptLayout | null = null;
  let activeFooter = request.footer;

  const buildRenderState = (): ChatPromptSessionState => ({
    buffer,
    cursor,
    inputMode,
    footer: activeFooter ?? null,
    historySearch: searchState
      ? getHistorySearchSummary(searchState)
      : undefined,
    typeahead: typeaheadState ? getTypeaheadSummary(typeaheadState) : undefined,
    multiline: buffer.includes("\n"),
    editorStatus,
  });

  const clearPreviousLayout = (): void => {
    if (outputStream.isTTY) {
      if (!lastLayout) {
        return;
      }

      try {
        const previousCursor = getLayoutCursorPosition(
          lastLayout,
          outputStream,
        );
        readline.moveCursor(outputStream, 0, -previousCursor.row);
        readline.cursorTo(outputStream, 0);
        readline.clearScreenDown(outputStream);
      } catch {
        // best effort only
      }
      return;
    }

    if (lastLayout) {
      outputStream.write("\r");
    }
  };

  const writeRenderedLayout = (layout: PromptLayout): void => {
    outputStream.write(layout.lines.join("\n"));

    if (outputStream.isTTY) {
      try {
        const nextCursor = getLayoutCursorPosition(layout, outputStream);
        const endRow = getLayoutEndRow(layout, outputStream);
        readline.moveCursor(outputStream, 0, nextCursor.row - endRow);
        readline.cursorTo(outputStream, nextCursor.col);
      } catch {
        // best effort only
      }
    }

    lastLayout = layout;
  };

  const render = (): void => {
    const layout = renderPromptFrame(
      outputStream,
      getActivePromptText(),
      buffer,
      cursor,
      activeFooter,
      searchState,
      typeaheadState,
      editorStatus,
    );

    callbacks.render(buildRenderState());
    clearPreviousLayout();
    writeRenderedLayout(layout);
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
    typeaheadPreviewApplied = false;
    clearMentionTypeaheadRetry();
  };

  const clearMentionTypeaheadRetry = (): void => {
    if (mentionTypeaheadRetryTimer) {
      clearTimeout(mentionTypeaheadRetryTimer);
      mentionTypeaheadRetryTimer = null;
    }
  };

  const clearTransientStatus = (): void => {
    editorStatus = undefined;
  };

  const cancelTypeahead = (shouldRender: boolean): void => {
    if (!typeaheadState) {
      return;
    }

    if (typeaheadPreviewApplied) {
      const selection = cancelTypeaheadState(typeaheadState);
      buffer = selection.buffer;
      cursor = selection.cursor;
    }
    clearTypeahead();
    if (shouldRender) {
      render();
    }
  };

  const refreshMentionTypeahead = (): void => {
    if (!options.enableTypeahead || searchState) {
      return;
    }

    const nextState = createTypeaheadState({
      buffer,
      cursor,
      workspaceRoot: options.workspaceRoot,
      typeaheadProviders: options.typeaheadProviders,
    });

    if (nextState?.target.kind === "mention") {
      typeaheadState = nextState;
      typeaheadPreviewApplied = false;
      return;
    }

    if (typeaheadState?.target.kind === "mention") {
      clearTypeahead();
    }
  };

  const scheduleMentionTypeaheadRetry = (): void => {
    if (
      !active ||
      !typeaheadState ||
      typeaheadState.target.kind !== "mention" ||
      typeaheadState.suggestions.length > 0
    ) {
      clearMentionTypeaheadRetry();
      mentionTypeaheadRetryKey = "";
      mentionTypeaheadRetryCount = 0;
      return;
    }

    const retryKey = `${buffer}\0${cursor}`;
    if (retryKey !== mentionTypeaheadRetryKey) {
      mentionTypeaheadRetryKey = retryKey;
      mentionTypeaheadRetryCount = 0;
    }

    if (mentionTypeaheadRetryTimer || mentionTypeaheadRetryCount >= 100) {
      return;
    }

    mentionTypeaheadRetryCount += 1;
    mentionTypeaheadRetryTimer = setTimeout(() => {
      mentionTypeaheadRetryTimer = null;
      if (!active) {
        return;
      }

      refreshMentionTypeahead();
      render();
      scheduleMentionTypeaheadRetry();
    }, 100);
  };

  const acceptTypeaheadSelection = (): void => {
    if (!typeaheadState) {
      return;
    }

    clearMentionTypeaheadRetry();

    if (
      typeaheadState.suggestions.length === 0 ||
      typeaheadState.selectedIndex < 0
    ) {
      typeaheadPreviewApplied = false;
      return;
    }

    const selectedSuggestion =
      typeaheadState.suggestions[typeaheadState.selectedIndex];
    const selection = acceptTypeaheadState(typeaheadState);
    buffer = selection.buffer;
    cursor = selection.cursor;

    if (selectedSuggestion?.isDirectory) {
      const refreshedState = createTypeaheadState({
        buffer,
        cursor,
        workspaceRoot: options.workspaceRoot,
        typeaheadProviders: options.typeaheadProviders,
      });
      typeaheadState = refreshedState;
      typeaheadPreviewApplied = false;
      return;
    }

    if (typeaheadState.target.kind === "mention") {
      typeaheadState = null;
      typeaheadPreviewApplied = false;
      return;
    }

    if (typeaheadState.suggestions.length === 1) {
      typeaheadState = null;
      typeaheadPreviewApplied = false;
      return;
    }

    typeaheadPreviewApplied = true;
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
      acceptTypeaheadSelection();
    }
    scheduleMentionTypeaheadRetry();

    render();
  };

  const cycleTypeahead = (): void => {
    clearTransientStatus();
    if (!typeaheadState) {
      return;
    }

    typeaheadState = cycleTypeaheadState(typeaheadState);
    if (typeaheadState.suggestions.length > 0) {
      acceptTypeaheadSelection();
    }
    scheduleMentionTypeaheadRetry();
    render();
  };

  const navigateTypeahead = (direction: "next" | "previous"): void => {
    clearTransientStatus();
    if (!typeaheadState) {
      return;
    }

    typeaheadState = cycleTypeaheadState(typeaheadState, direction);
    if (typeaheadPreviewApplied && typeaheadState.suggestions.length > 0) {
      acceptTypeaheadSelection();
    }
    scheduleMentionTypeaheadRetry();
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
    syncBufferInputMode();
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

  const getBufferLinePosition = () => {
    const currentLineStart = getLineStartIndex(buffer, cursor);
    return {
      currentLineStart,
      currentLineEnd: getLineEndIndex(buffer, cursor),
      lineIndex: buffer.slice(0, currentLineStart).split("\n").length - 1,
      totalLines: buffer.length === 0 ? 1 : buffer.split("\n").length,
    };
  };

  const selectHistoryEntry = (index: number): void => {
    const selected = historySnapshot[index];
    buffer = selected;
    cursor = selected.length;
    syncBufferInputMode();
    render();
  };

  const moveCursorToPreviousLine = (): boolean => {
    const { currentLineStart, lineIndex } = getBufferLinePosition();
    if (lineIndex <= 0) {
      return false;
    }

    const previousLineStart = buffer.lastIndexOf("\n", currentLineStart - 2);
    const previousLineEnd = currentLineStart - 1;
    const targetColumn = getLineColumn(buffer, cursor);
    const targetStart = previousLineStart >= 0 ? previousLineStart + 1 : 0;
    cursor = Math.min(targetStart + targetColumn, previousLineEnd);
    render();
    return true;
  };

  const moveCursorToNextLine = (): boolean => {
    const { currentLineEnd, lineIndex, totalLines } = getBufferLinePosition();
    if (lineIndex >= totalLines - 1) {
      return false;
    }

    const targetColumn = getLineColumn(buffer, cursor);
    const nextLineStart = currentLineEnd + 1;
    const nextLineEnd = buffer.indexOf("\n", nextLineStart);
    cursor = Math.min(
      nextLineStart + targetColumn,
      nextLineEnd >= 0 ? nextLineEnd : buffer.length,
    );
    render();
    return true;
  };

  const moveHistoryUp = (): void => {
    if (historySnapshot.length === 0) {
      return;
    }

    if (historyIndex === null) {
      draftSnapshot = { buffer, cursor };
      historyIndex = 0;
    } else if (historyIndex < historySnapshot.length - 1) {
      historyIndex += 1;
    } else {
      return;
    }

    selectHistoryEntry(historyIndex);
  };

  const moveHistoryDown = (): void => {
    if (historySnapshot.length === 0 || historyIndex === null) {
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
    selectHistoryEntry(historyIndex);
  };

  const moveHistory = (direction: "up" | "down"): void => {
    clearTransientStatus();
    if (typeaheadState) {
      cancelTypeahead(false);
    }

    if (searchState) {
      return;
    }

    if (direction === "up") {
      if (moveCursorToPreviousLine()) {
        return;
      }
      moveHistoryUp();
      return;
    }

    if (moveCursorToNextLine()) {
      return;
    }
    moveHistoryDown();
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
    syncBufferInputMode();
    refreshMentionTypeahead();
    scheduleMentionTypeaheadRetry();
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
    refreshMentionTypeahead();
    scheduleMentionTypeaheadRetry();
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
    refreshMentionTypeahead();
    scheduleMentionTypeaheadRetry();
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
    refreshMentionTypeahead();
    scheduleMentionTypeaheadRetry();
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
        syncBufferInputMode();
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
    callbacks.submit(buffer, inputMode);
  };

  const handleLifecycleKeys = (key: readline.Key): boolean => {
    if (key.name === "c" && key.ctrl) {
      callbacks.interrupt();
      return true;
    }
    if (key.name === "d" && key.ctrl) {
      callbacks.close();
      return true;
    }
    return false;
  };

  const handleEditorHandoffKeys = (key: readline.Key): boolean => {
    if (pendingEditorHandoff) {
      pendingEditorHandoff = false;
      if (key.name === "e" && key.ctrl) {
        openEditor();
        return true;
      }
      return false;
    }

    if (key.name === "x" && key.ctrl) {
      if (!searchState) pendingEditorHandoff = true;
      return true;
    }

    return false;
  };

  const handleSearchCancelKeys = (key: readline.Key): boolean => {
    if (key.name === "r" && key.ctrl) {
      if (options.enableReverseHistorySearch) {
        cancelTypeahead(false);
        enterSearch();
      }
      return true;
    }

    if ((key.name === "g" && key.ctrl) || key.name === "escape") {
      if (searchState) cancelSearch();
      else if (typeaheadState) cancelTypeahead(true);
      else if (inputMode === "bash") {
        inputMode = "prompt";
        render();
      }
      return true;
    }

    return false;
  };

  const handleToolToggleKeys = (key: readline.Key): boolean => {
    const applyFooterToggle = (
      toggle: (() => string | null | undefined) | undefined,
    ): boolean => {
      const nextFooter = toggle?.();
      if (nextFooter !== undefined) {
        activeFooter = nextFooter ?? undefined;
        render();
      }
      return true;
    };

    if (key.name === "o" && key.ctrl) {
      return applyFooterToggle(callbacks.toggleToolCalls);
    }

    if (key.name === "t" && key.ctrl) {
      return applyFooterToggle(callbacks.toggleThinking);
    }

    return false;
  };

  const handleNewlineAndEnterKeys = (
    str: string | undefined,
    key: readline.Key,
  ): boolean => {
    if (!searchState && ((key.name === "j" && key.ctrl) || str === "\n")) {
      insertText("\n");
      return true;
    }
    if (key.name === "return" || key.name === "enter") {
      handleEnter();
      return true;
    }
    return false;
  };

  const handleControlAndSystemKeys = (
    str: string | undefined,
    key: readline.Key,
  ): boolean =>
    handleLifecycleKeys(key) ||
    handleEditorHandoffKeys(key) ||
    handleSearchCancelKeys(key) ||
    handleToolToggleKeys(key) ||
    handleNewlineAndEnterKeys(str, key);

  const handleSearchModeInput = (
    str: string | undefined,
    key: readline.Key,
  ): boolean => {
    if (!searchState) return false;
    if (key.name === "tab") return true;
    if (key.name === "backspace" || key.name === "delete") {
      updateSearchQuery(searchState.query.slice(0, -1));
      return true;
    }
    if (isPrintableKey(str, key)) insertText(str ?? "");
    return true;
  };

  const handleTabKey = (key: readline.Key): boolean => {
    if (key.name !== "tab") {
      return false;
    }

    if (typeaheadState) {
      if (typeaheadPreviewApplied) cycleTypeahead();
      else {
        acceptTypeaheadSelection();
        render();
      }
    } else {
      startTypeahead();
    }

    return true;
  };

  const handleTypeaheadDirectional = (key: readline.Key): boolean => {
    if (!typeaheadState) {
      return false;
    }

    if ((key.name === "up" || key.name === "down") && !key.ctrl && !key.meta) {
      navigateTypeahead(key.name === "up" ? "previous" : "next");
      return true;
    }

    return false;
  };

  const handleWordMovement = (key: readline.Key): boolean => {
    if (
      (key.name === "left" || key.name === "right") &&
      (key.ctrl || key.meta)
    ) {
      moveCursorByWord(key.name);
      return true;
    }

    if (key.meta && (key.name === "b" || key.name === "f")) {
      moveCursorByWord(key.name === "b" ? "left" : "right");
      return true;
    }

    return false;
  };

  const handleBackspaceKey = (key: readline.Key): boolean => {
    if (key.name !== "backspace") {
      return false;
    }

    if (key.meta) {
      deleteWordBeforeCursor();
      return true;
    }

    deleteBeforeCursor();
    return true;
  };

  const handleNavigationKeys = (key: readline.Key): boolean => {
    switch (key.name) {
      case "delete":
        deleteAtCursor();
        return true;
      case "left":
        moveCursor("left");
        return true;
      case "right":
        moveCursor("right");
        return true;
      case "home":
        moveCursor("home");
        return true;
      case "end":
        moveCursor("end");
        return true;
      case "up":
        moveHistory("up");
        return true;
      case "down":
        moveHistory("down");
        return true;
      default:
        return false;
    }
  };

  const handleTypeaheadAndNavigationKeys = (
    _str: string | undefined,
    key: readline.Key,
  ): boolean =>
    handleTabKey(key) ||
    handleTypeaheadDirectional(key) ||
    handleWordMovement(key) ||
    handleBackspaceKey(key) ||
    handleNavigationKeys(key);

  const handleKeypress = (str: string | undefined, key: readline.Key): void => {
    if (!active) return;
    if (handleControlAndSystemKeys(str, key)) return;
    if (handleSearchModeInput(str, key)) return;
    if (handleTypeaheadAndNavigationKeys(str, key)) return;
    if (isPrintableKey(str, key)) insertText(str ?? "");
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
    clearMentionTypeaheadRetry();
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
