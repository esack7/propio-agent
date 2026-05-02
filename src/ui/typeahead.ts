import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { FileSearchIndex } from "../fileSearch/index.js";
import { getSlashCommandCompletionCommands } from "./slashCommands.js";
import type { Skill } from "../skills/types.js";

export type TypeaheadKind = "command" | "path" | "mention";

export interface TypeaheadTarget {
  readonly kind: TypeaheadKind;
  readonly query: string;
  readonly replaceStart: number;
  readonly replaceEnd: number;
  readonly workspaceRoot: string;
  readonly quoted?: boolean;
}

export interface TypeaheadSuggestion {
  readonly value: string;
  readonly kind: TypeaheadKind;
  readonly isDirectory?: boolean;
}

export interface TypeaheadProvider {
  readonly kind: TypeaheadKind;
  getSuggestions(target: TypeaheadTarget): readonly TypeaheadSuggestion[];
}

export interface TypeaheadState {
  readonly target: TypeaheadTarget;
  readonly baselineBuffer: string;
  readonly baselineCursor: number;
  readonly suggestions: readonly TypeaheadSuggestion[];
  readonly selectedIndex: number;
}

export interface TypeaheadSummary {
  readonly active: boolean;
  readonly kind: TypeaheadKind;
  readonly query: string;
  readonly match?: string;
  readonly matchIndex: number;
  readonly matchCount: number;
  readonly matches: readonly string[];
}

export interface TypeaheadSelection {
  buffer: string;
  cursor: number;
}

const IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  ".propio",
]);

const FILE_REFERENCE_VERBS = new Set([
  "read",
  "open",
  "edit",
  "cat",
  "search",
  "find",
  "inspect",
  "summarize",
  "review",
  "fix",
]);

const COMMAND_SUGGESTIONS = getSlashCommandCompletionCommands();

function isWhitespace(character: string | undefined): boolean {
  return character === " " || character === "\t" || character === "\n";
}

function isQuote(character: string | undefined): boolean {
  return character === '"' || character === "'";
}

function findLeadingWhitespaceIndex(buffer: string): number {
  let index = 0;
  while (index < buffer.length && isWhitespace(buffer[index])) {
    index += 1;
  }
  return index;
}

function findTokenStart(buffer: string, cursor: number): number {
  let index = Math.max(0, Math.min(cursor, buffer.length));
  while (index > 0 && !isWhitespace(buffer[index - 1])) {
    index -= 1;
  }
  return index;
}

function findTokenEnd(buffer: string, cursor: number): number {
  let index = Math.max(0, Math.min(cursor, buffer.length));
  while (index < buffer.length && !isWhitespace(buffer[index])) {
    index += 1;
  }
  return index;
}

function findMentionTokenEnd(buffer: string, tokenStart: number): number {
  let index = Math.max(0, Math.min(tokenStart, buffer.length));
  if (buffer[index] !== "@") {
    return findTokenEnd(buffer, tokenStart);
  }

  index += 1;
  if (isQuote(buffer[index])) {
    const quote = buffer[index];
    index += 1;
    while (index < buffer.length) {
      if (buffer[index] === quote) {
        index += 1;
        break;
      }
      index += 1;
    }
  } else {
    while (index < buffer.length && !isWhitespace(buffer[index])) {
      index += 1;
    }
  }

  while (index < buffer.length && !isWhitespace(buffer[index])) {
    index += 1;
  }

  return index;
}

function findPreviousToken(buffer: string, index: number): string | null {
  let cursor = Math.max(0, Math.min(index, buffer.length));

  while (cursor > 0 && isWhitespace(buffer[cursor - 1])) {
    cursor -= 1;
  }

  if (cursor === 0) {
    return null;
  }

  const end = cursor;
  while (cursor > 0 && !isWhitespace(buffer[cursor - 1])) {
    cursor -= 1;
  }

  return buffer.slice(cursor, end);
}

function isPathLikeToken(query: string, previousToken: string | null): boolean {
  if (
    query.startsWith("./") ||
    query.startsWith("../") ||
    query.startsWith("/") ||
    query.startsWith("~") ||
    query.includes("/")
  ) {
    return true;
  }

  return (
    previousToken !== null &&
    FILE_REFERENCE_VERBS.has(previousToken.toLowerCase())
  );
}

function isMentionPathLike(query: string): boolean {
  return (
    query.startsWith("./") ||
    query.startsWith("../") ||
    query.startsWith("/") ||
    query.startsWith("~") ||
    query.includes("/")
  );
}

function isInsideWorkspaceRoot(
  candidatePath: string,
  workspaceRoot: string,
): boolean {
  const relative = path.relative(workspaceRoot, candidatePath);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

interface PathResolution {
  readonly absoluteBase: string;
  readonly basenamePrefix: string;
  readonly style: "relative" | "dot" | "absolute" | "home";
}

function normalizeHomePath(candidatePath: string): string {
  const home = os.homedir();
  if (!isInsideWorkspaceRoot(candidatePath, home)) {
    return candidatePath;
  }

  const relative = path.relative(home, candidatePath);
  return relative.length === 0 ? "~" : path.join("~", relative);
}

function resolvePathQuery(
  query: string,
  workspaceRoot: string,
): PathResolution | null {
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);

  if (query.startsWith("/")) {
    const absoluteQuery = path.resolve(query);
    if (!isInsideWorkspaceRoot(absoluteQuery, resolvedWorkspaceRoot)) {
      return null;
    }

    const slashIndex = query.lastIndexOf("/");
    const baseQuery = slashIndex >= 0 ? query.slice(0, slashIndex) : "";
    const absoluteBase = baseQuery.length > 0 ? path.resolve(baseQuery) : "/";
    if (!isInsideWorkspaceRoot(absoluteBase, resolvedWorkspaceRoot)) {
      return null;
    }

    return {
      absoluteBase,
      basenamePrefix: slashIndex >= 0 ? query.slice(slashIndex + 1) : query,
      style: "absolute",
    };
  }

  if (query.startsWith("~")) {
    const home = os.homedir();
    const homeQuery =
      query === "~"
        ? ""
        : query.startsWith("~/")
          ? query.slice(2)
          : query.slice(1);
    const absoluteQuery = path.resolve(home, homeQuery);
    if (!isInsideWorkspaceRoot(absoluteQuery, resolvedWorkspaceRoot)) {
      return null;
    }

    const slashIndex = homeQuery.lastIndexOf("/");
    const baseQuery = slashIndex >= 0 ? homeQuery.slice(0, slashIndex) : "";
    const absoluteBase =
      baseQuery.length > 0 ? path.resolve(home, baseQuery) : home;
    if (!isInsideWorkspaceRoot(absoluteBase, resolvedWorkspaceRoot)) {
      return null;
    }

    return {
      absoluteBase,
      basenamePrefix:
        slashIndex >= 0 ? homeQuery.slice(slashIndex + 1) : homeQuery,
      style: "home",
    };
  }

  const relativeQuery = query.startsWith("./") ? query.slice(2) : query;
  const resolvedQuery = path.resolve(resolvedWorkspaceRoot, relativeQuery);
  if (!isInsideWorkspaceRoot(resolvedQuery, resolvedWorkspaceRoot)) {
    return null;
  }

  const slashIndex = relativeQuery.lastIndexOf("/");
  const baseQuery = slashIndex >= 0 ? relativeQuery.slice(0, slashIndex) : "";
  const absoluteBase =
    baseQuery.length > 0
      ? path.resolve(resolvedWorkspaceRoot, baseQuery)
      : resolvedWorkspaceRoot;
  if (!isInsideWorkspaceRoot(absoluteBase, resolvedWorkspaceRoot)) {
    return null;
  }

  return {
    absoluteBase,
    basenamePrefix:
      slashIndex >= 0 ? relativeQuery.slice(slashIndex + 1) : relativeQuery,
    style: query.startsWith("./") ? "dot" : "relative",
  };
}

function formatCandidatePath(
  candidatePath: string,
  workspaceRoot: string,
  style: "relative" | "dot" | "absolute" | "home",
): string {
  const relative = path.relative(workspaceRoot, candidatePath);

  switch (style) {
    case "absolute":
      return candidatePath;
    case "home":
      return normalizeHomePath(candidatePath);
    case "dot":
      return relative.length === 0 ? "." : `./${relative}`;
    case "relative":
      return relative;
  }
}

function createPathTarget(
  buffer: string,
  cursor: number,
  workspaceRoot: string,
): TypeaheadTarget | null {
  const tokenStart = findTokenStart(buffer, cursor);
  const tokenEnd = findTokenEnd(buffer, cursor);
  const rawToken = buffer.slice(tokenStart, tokenEnd);
  const previousToken = findPreviousToken(buffer, tokenStart);

  const quoted = isQuote(rawToken[0]) ? rawToken[0] : null;
  const hasClosingQuote = quoted !== null && rawToken.endsWith(quoted);
  const replaceStart = quoted !== null ? tokenStart + 1 : tokenStart;
  const replaceEnd = hasClosingQuote ? tokenEnd - 1 : tokenEnd;
  const typedPrefix = buffer
    .slice(replaceStart, Math.min(cursor, replaceEnd))
    .replace(/['"]$/, "")
    .split("#", 1)[0];

  if (
    rawToken.length === 0 &&
    (previousToken === null ||
      !FILE_REFERENCE_VERBS.has(previousToken.toLowerCase()))
  ) {
    return null;
  }

  if (rawToken.length > 0 && !isPathLikeToken(typedPrefix, previousToken)) {
    return null;
  }

  return {
    kind: "path",
    query: typedPrefix,
    replaceStart,
    replaceEnd,
    workspaceRoot,
    quoted: quoted !== null,
  };
}

function createMentionTarget(
  buffer: string,
  cursor: number,
  workspaceRoot: string,
): TypeaheadTarget | null {
  const tokenStart = findTokenStart(buffer, cursor);
  const tokenEnd = findMentionTokenEnd(buffer, tokenStart);
  const rawToken = buffer.slice(tokenStart, tokenEnd);

  if (!rawToken.startsWith("@")) {
    return null;
  }

  const rawBody = rawToken.slice(1);
  const quoted = isQuote(rawBody[0]) ? rawBody[0] : null;
  let query = buffer.slice(tokenStart + 1, Math.min(cursor, tokenEnd));
  if (quoted) {
    query = query.slice(1);
    if (query.endsWith(quoted)) {
      query = query.slice(0, -1);
    }
  }
  query = query.split("#", 1)[0];

  return {
    kind: "mention",
    query,
    replaceStart: tokenStart,
    replaceEnd: tokenEnd,
    workspaceRoot,
    quoted: quoted !== null,
  };
}

function createCommandTarget(
  buffer: string,
  cursor: number,
  workspaceRoot: string,
): TypeaheadTarget | null {
  const start = findLeadingWhitespaceIndex(buffer);
  if (start >= buffer.length || buffer[start] !== "/") {
    return null;
  }

  const query = buffer.slice(start, cursor).trimEnd();
  if (query.length === 0) {
    return null;
  }

  const normalizedQuery = query.toLowerCase();
  const hasMatch = COMMAND_SUGGESTIONS.some((command) =>
    command.command.toLowerCase().startsWith(normalizedQuery),
  );

  if (!hasMatch) {
    return null;
  }

  return {
    kind: "command",
    query,
    replaceStart: start,
    replaceEnd: cursor,
    workspaceRoot,
  };
}

function listPathSuggestions(
  target: TypeaheadTarget,
): readonly TypeaheadSuggestion[] {
  const workspaceRoot = path.resolve(target.workspaceRoot);
  const resolution = resolvePathQuery(target.query, workspaceRoot);
  if (!resolution) {
    return [];
  }

  if (!fs.existsSync(resolution.absoluteBase)) {
    return [];
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(resolution.absoluteBase, { withFileTypes: true });
  } catch {
    return [];
  }

  const prefixLower = resolution.basenamePrefix.toLowerCase();
  const allowHidden = resolution.basenamePrefix.startsWith(".");

  const suggestions = entries
    .filter((entry) => {
      if (IGNORED_DIRECTORIES.has(entry.name)) {
        return false;
      }

      if (!allowHidden && entry.name.startsWith(".")) {
        return false;
      }

      return entry.name.toLowerCase().startsWith(prefixLower);
    })
    .map((entry) => {
      const candidatePath = path.join(resolution.absoluteBase, entry.name);
      if (!isInsideWorkspaceRoot(candidatePath, workspaceRoot)) {
        return null;
      }

      const value = formatCandidatePath(
        candidatePath,
        workspaceRoot,
        resolution.style,
      );
      return {
        kind: "path" as const,
        value: entry.isDirectory() ? `${value}${path.sep}` : value,
        isDirectory: entry.isDirectory(),
        name: entry.name,
      };
    })
    .filter(
      (
        suggestion,
      ): suggestion is {
        kind: "path";
        value: string;
        isDirectory: boolean;
        name: string;
      } => suggestion !== null,
    )
    .sort((left, right) => {
      if (left.isDirectory !== right.isDirectory) {
        return left.isDirectory ? -1 : 1;
      }

      return left.name.localeCompare(right.name);
    })
    .slice(0, 20)
    .map((suggestion) => ({
      kind: suggestion.kind,
      value: suggestion.value,
      ...(suggestion.isDirectory ? { isDirectory: true } : {}),
    }));

  return suggestions;
}

function formatMentionSuggestionValue(
  candidatePath: string,
  isDirectory: boolean,
  quoted: boolean,
): string {
  const normalizedPath =
    isDirectory && candidatePath.endsWith(path.sep)
      ? candidatePath.slice(0, -1)
      : candidatePath;
  const needsQuotes = quoted || /\s/.test(normalizedPath);

  if (needsQuotes) {
    return `@"${normalizedPath}"${isDirectory ? path.sep : " "}`;
  }

  return `@${normalizedPath}${isDirectory ? path.sep : " "}`;
}

function listMentionSuggestions(
  target: TypeaheadTarget,
  fileSearchIndex: FileSearchIndex,
): readonly TypeaheadSuggestion[] {
  if (isMentionPathLike(target.query)) {
    return listPathSuggestions(target).map((suggestion) => ({
      kind: "mention" as const,
      value: formatMentionSuggestionValue(
        suggestion.value,
        suggestion.isDirectory === true,
        target.quoted ?? false,
      ),
      ...(suggestion.isDirectory ? { isDirectory: true } : {}),
    }));
  }

  const matches = fileSearchIndex.search(target.query, 20);
  return matches.map((match) => ({
    kind: "mention" as const,
    value: formatMentionSuggestionValue(
      match.path,
      match.kind === "directory",
      target.quoted ?? false,
    ),
    ...(match.kind === "directory" ? { isDirectory: true } : {}),
  }));
}

function listCommandSuggestions(
  target: TypeaheadTarget,
): readonly TypeaheadSuggestion[] {
  const query = target.query.toLowerCase();
  return COMMAND_SUGGESTIONS.filter((command) =>
    command.command.toLowerCase().startsWith(query),
  ).map((command) => ({
    kind: "command" as const,
    value: command.command,
  }));
}

function createTarget(
  buffer: string,
  cursor: number,
  workspaceRoot: string,
): TypeaheadTarget | null {
  const commandTarget = createCommandTarget(buffer, cursor, workspaceRoot);
  if (commandTarget) {
    return commandTarget;
  }

  const mentionTarget = createMentionTarget(buffer, cursor, workspaceRoot);
  if (mentionTarget) {
    return mentionTarget;
  }

  return createPathTarget(buffer, cursor, workspaceRoot);
}

function replaceRange(
  buffer: string,
  start: number,
  end: number,
  value: string,
): TypeaheadSelection {
  const nextBuffer = `${buffer.slice(0, start)}${value}${buffer.slice(end)}`;
  return {
    buffer: nextBuffer,
    cursor: start + value.length,
  };
}

export function createDefaultTypeaheadProviders(
  workspaceRoot: string,
): readonly TypeaheadProvider[] {
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  const fileSearchIndex = FileSearchIndex.forWorkspace(resolvedWorkspaceRoot);
  void fileSearchIndex.refresh();

  return [
    {
      kind: "command",
      getSuggestions: (target) => listCommandSuggestions(target),
    },
    {
      kind: "mention",
      getSuggestions: (target) =>
        listMentionSuggestions(target, fileSearchIndex),
    },
    {
      kind: "path",
      getSuggestions: (target) =>
        listPathSuggestions({
          ...target,
          workspaceRoot: resolvedWorkspaceRoot,
        }),
    },
  ];
}

export function createSkillCommandTypeaheadProvider(
  getSkills: () => ReadonlyArray<Skill>,
): TypeaheadProvider {
  return {
    kind: "command",
    getSuggestions: (target) => {
      const query = target.query.trim().toLowerCase();
      if (!query.startsWith("/skill") || query.startsWith("/skills")) {
        return [];
      }

      return getSkills()
        .filter((skill) => skill.userInvocable !== false)
        .map((skill) => ({
          kind: "command" as const,
          value: `/skill ${skill.name}`,
        }))
        .filter((suggestion) =>
          suggestion.value.toLowerCase().startsWith(query),
        );
    },
  };
}

export function resolveTypeaheadTarget(
  buffer: string,
  cursor: number,
  workspaceRoot: string,
): TypeaheadTarget | null {
  return createTarget(buffer, cursor, path.resolve(workspaceRoot));
}

export function createTypeaheadState(options: {
  buffer: string;
  cursor: number;
  workspaceRoot: string;
  typeaheadProviders?: readonly TypeaheadProvider[];
}): TypeaheadState | null {
  const target = resolveTypeaheadTarget(
    options.buffer,
    options.cursor,
    options.workspaceRoot,
  );

  if (!target) {
    return null;
  }

  const providers =
    options.typeaheadProviders ??
    createDefaultTypeaheadProviders(options.workspaceRoot);

  const suggestions = providers
    .filter((provider) => provider.kind === target.kind)
    .flatMap((provider) => provider.getSuggestions(target));

  const dedupedSuggestions: TypeaheadSuggestion[] = [];
  const seenValues = new Set<string>();
  for (const suggestion of suggestions) {
    if (seenValues.has(suggestion.value)) {
      continue;
    }
    seenValues.add(suggestion.value);
    dedupedSuggestions.push(suggestion);
  }

  return {
    target,
    baselineBuffer: options.buffer,
    baselineCursor: options.cursor,
    suggestions: dedupedSuggestions,
    selectedIndex: dedupedSuggestions.length > 0 ? 0 : -1,
  };
}

export function cycleTypeaheadState(
  state: TypeaheadState,
  direction: "next" | "previous" = "next",
): TypeaheadState {
  if (state.suggestions.length === 0) {
    return state;
  }

  const delta = direction === "previous" ? -1 : 1;
  const selectedIndex =
    (state.selectedIndex + delta + state.suggestions.length) %
    state.suggestions.length;

  return {
    ...state,
    selectedIndex,
  };
}

export function acceptTypeaheadState(
  state: TypeaheadState,
): TypeaheadSelection {
  if (state.suggestions.length === 0 || state.selectedIndex < 0) {
    return {
      buffer: state.baselineBuffer,
      cursor: state.baselineCursor,
    };
  }

  const selectedSuggestion = state.suggestions[state.selectedIndex];
  return replaceRange(
    state.baselineBuffer,
    state.target.replaceStart,
    state.target.replaceEnd,
    selectedSuggestion.value,
  );
}

export function cancelTypeaheadState(
  state: TypeaheadState,
): TypeaheadSelection {
  return {
    buffer: state.baselineBuffer,
    cursor: state.baselineCursor,
  };
}

export function getTypeaheadSummary(state: TypeaheadState): TypeaheadSummary {
  const matches = state.suggestions.map((suggestion) => suggestion.value);
  const match =
    state.selectedIndex >= 0 && state.selectedIndex < matches.length
      ? matches[state.selectedIndex]
      : undefined;

  return {
    active: true,
    kind: state.target.kind,
    query: state.target.query,
    match,
    matchIndex: state.selectedIndex,
    matchCount: matches.length,
    matches,
  };
}
