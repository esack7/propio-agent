import * as readline from "readline";
import * as path from "path";
import {
  createChatPromptSession,
  type ChatPromptSession,
  type ChatPromptSessionState,
} from "./chatPromptSession.js";
import {
  applySubmittedText,
  clonePromptState,
  createPromptState,
  type PromptRequest,
  type PromptState,
} from "./promptState.js";
import {
  createDefaultTypeaheadProviders,
  type TypeaheadProvider,
} from "./typeahead.js";
import type { PromptHistoryStore } from "./promptHistory.js";
import {
  buildPromptHistoryEntry,
  createPasteCache,
  type PasteCache,
} from "./pasteCache.js";
import type { InputMode } from "./inputModes.js";
import {
  createPlainSubmission,
  shouldPersistPromptHistory,
  type PromptSubmission,
} from "./input/promptSubmission.js";
import type { PromptEditorRunner } from "./promptEditor.js";

export type { PromptState, PromptRequest } from "./promptState.js";

export type PromptCloseReason = "closed" | "interrupted";

export interface PromptResultSubmitted {
  status: "submitted";
  submission: PromptSubmission;
}

export interface PromptResultClosed {
  status: "closed";
}

export type PromptResult = PromptResultSubmitted | PromptResultClosed;

export interface PromptConfirmRequest {
  promptText: string;
  defaultValue?: boolean;
  footer?: string;
}

export interface PromptComposer {
  compose(request: PromptRequest): Promise<PromptResult>;
  confirm(request: PromptConfirmRequest): Promise<boolean>;
  getState(): PromptState | null;
  getCloseReason(): PromptCloseReason | null;
  close(): void;
}

export interface PromptComposerOptions {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  terminalControlStream?: NodeJS.WriteStream;
  createInterface?: typeof readline.createInterface;
  renderFooter?: (footer: string) => void;
  renderState?: (state: PromptState | null) => void;
  onToggleToolCalls?: () => string | null | undefined;
  onToggleThinking?: () => string | null | undefined;
  refreshPromptFooters?: () => import("./chatPromptSession.js").PromptFooters;
  historyStore?: PromptHistoryStore;
  pasteCache?: PasteCache;
  enableReverseHistorySearch?: boolean;
  enableTypeahead?: boolean;
  workspaceRoot?: string;
  typeaheadProviders?: readonly TypeaheadProvider[];
  editorRunner?: PromptEditorRunner;
  editorEnv?: NodeJS.ProcessEnv;
}

const PROMPT_HISTORY_LIMIT = 200;

interface ActivePromptContext {
  request: PromptRequest;
  historySnapshot: string[] | null;
  isCustomChat: boolean;
}

function snapshotLiveHistory(rl: readline.Interface): string[] | null {
  const history = (rl as readline.Interface & { history?: string[] }).history;
  return Array.isArray(history) ? [...history] : null;
}

function restoreLiveHistory(
  rl: readline.Interface,
  historySnapshot: string[] | null,
): void {
  if (!historySnapshot) {
    return;
  }

  const history = rl as readline.Interface & { history?: string[] };
  history.history = [...historySnapshot];
}

function updateLiveHistorySnapshot(
  history: readonly string[],
  text: string,
): string[] {
  const nextHistory = [text, ...history.filter((entry) => entry !== text)];
  return nextHistory.slice(0, PROMPT_HISTORY_LIMIT);
}

function isTerminalPrompt(options: PromptComposerOptions): boolean {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stderr;
  return Boolean(input.isTTY && output.isTTY);
}

export function createPromptComposer(
  options: PromptComposerOptions = {},
): PromptComposer {
  const inputStream = options.input ?? process.stdin;
  const outputStream = options.output ?? process.stderr;
  const createInterface = options.createInterface ?? readline.createInterface;
  const workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
  const typeaheadEnabled = options.enableTypeahead ?? isTerminalPrompt(options);
  const typeaheadProviders =
    options.typeaheadProviders ??
    createDefaultTypeaheadProviders(workspaceRoot);
  const reverseHistorySearchEnabled =
    options.enableReverseHistorySearch ?? isTerminalPrompt(options);
  const pasteCache = options.pasteCache ?? createPasteCache();
  const useCustomChatPrompt = isTerminalPrompt(options);
  const liveHistory = [...(options.historyStore?.load() ?? [])];
  const rl = createInterface({
    input: inputStream,
    output: outputStream,
    terminal: Boolean(outputStream.isTTY) && !useCustomChatPrompt,
    history: [...liveHistory],
    historySize: PROMPT_HISTORY_LIMIT,
    removeHistoryDuplicates: true,
  });

  let closed = false;
  let closeReason: PromptCloseReason | null = null;
  let pendingResolve: ((result: PromptResult) => void) | null = null;
  let currentState: PromptState | null = null;
  let activeChatSession: ChatPromptSession | null = null;
  let activePrompt: ActivePromptContext | null = null;

  const pauseInputStream = (): void => {
    if (typeof inputStream.pause === "function") {
      inputStream.pause();
    }
  };

  rl.once("close", () => {
    closed = true;
    setCloseReason("closed");
    pauseInputStream();
    settlePending({ status: "closed" });
  });

  rl.on("SIGINT", () => {
    setCloseReason("interrupted");
    process.kill(process.pid, "SIGINT");
  });

  const setCloseReason = (reason: PromptCloseReason): void => {
    if (reason === "interrupted" || closeReason === null) {
      closeReason = reason;
    }
  };

  const syncChatState = (state: ChatPromptSessionState): void => {
    if (!currentState) {
      return;
    }

    currentState = {
      ...currentState,
      buffer: state.buffer,
      cursor: state.cursor,
      inputMode: state.inputMode,
      footer: state.footer ?? undefined,
      historySearch: state.historySearch
        ? { ...state.historySearch }
        : undefined,
      typeahead: state.typeahead
        ? {
            ...state.typeahead,
            matches: [...state.typeahead.matches],
          }
        : undefined,
      multiline: state.multiline,
      editorStatus: state.editorStatus,
    };

    options.renderState?.(clonePromptState(currentState));
  };

  const persistSubmittedPrompt = (submission: PromptSubmission): void => {
    if (!currentState || !activePrompt) {
      return;
    }

    currentState = applySubmittedText(currentState, submission.displayText);
    const shouldKeepHistory = shouldPersistPromptHistory(
      submission,
      activePrompt.request.mode,
    );

    if (shouldKeepHistory) {
      try {
        const historyEntry = buildPromptHistoryEntry(submission, pasteCache);
        options.historyStore?.record(historyEntry);

        const updatedHistory = updateLiveHistorySnapshot(
          liveHistory,
          historyEntry,
        );
        liveHistory.splice(0, liveHistory.length, ...updatedHistory);
      } catch {
        // Prompt history is best-effort and must not block submission.
      }
      return;
    }

    if (!activePrompt.isCustomChat) {
      restoreLiveHistory(rl, activePrompt.historySnapshot);
    }
  };

  const settlePending = (result: PromptResult): void => {
    if (!pendingResolve) {
      return;
    }

    const resolve = pendingResolve;
    pendingResolve = null;

    if (activeChatSession) {
      activeChatSession.cleanup();
      activeChatSession = null;
    }

    if (result.status === "submitted") {
      persistSubmittedPrompt(result.submission);
    }

    activePrompt = null;
    options.renderState?.(null);
    pauseInputStream();
    resolve(result);
  };

  const close = (): void => {
    if (closed) {
      return;
    }

    closed = true;
    setCloseReason("closed");
    options.renderState?.(null);
    rl.close();
    pauseInputStream();
  };

  const compose = async (request: PromptRequest): Promise<PromptResult> => {
    if (closed) {
      return { status: "closed" };
    }

    if (pendingResolve) {
      throw new Error("An interactive prompt is already active.");
    }

    currentState = createPromptState(request);
    options.renderState?.(clonePromptState(currentState));
    activePrompt = {
      request,
      historySnapshot: snapshotLiveHistory(rl),
      isCustomChat: request.mode === "chat" && useCustomChatPrompt,
    };

    if (request.footer && options.renderFooter && !activePrompt.isCustomChat) {
      options.renderFooter(request.footer);
    }

    return await new Promise<PromptResult>((resolve) => {
      pendingResolve = resolve;

      if (activePrompt?.isCustomChat) {
        readline.emitKeypressEvents(inputStream);
        activeChatSession = createChatPromptSession({
          inputStream,
          outputStream,
          terminalControlStream:
            options.terminalControlStream ?? process.stdout,
          request,
          historySnapshot: [...liveHistory],
          enableTypeahead:
            request.mode === "chat" && typeaheadEnabled && !closed,
          enableReverseHistorySearch: reverseHistorySearchEnabled,
          workspaceRoot,
          typeaheadProviders,
          editorRunner: options.editorRunner,
          editorEnv: options.editorEnv,
          pasteCache,
          callbacks: {
            render: syncChatState,
            submit: (submission) =>
              settlePending({ status: "submitted", submission }),
            interrupt: () => {
              setCloseReason("interrupted");
              process.kill(process.pid, "SIGINT");
            },
            toggleToolCalls: () => {
              return options.onToggleToolCalls?.();
            },
            toggleThinking: () => {
              return options.onToggleThinking?.();
            },
            refreshPromptFooters: options.refreshPromptFooters,
            close,
          },
        });
        return;
      }

      inputStream.resume();
      rl.question(request.promptText, (answer) => {
        settlePending({
          status: "submitted",
          submission: createPlainSubmission(
            answer,
            request.inputMode ?? "prompt",
          ),
        });
      });
    });
  };

  const confirm = async (request: PromptConfirmRequest): Promise<boolean> => {
    const defaultValue = request.defaultValue ?? false;

    while (true) {
      const result = await compose({
        mode: "confirm",
        promptText: request.promptText,
        footer: request.footer,
      });

      if (result.status === "closed") {
        return defaultValue;
      }

      const normalized = result.submission.displayText.trim().toLowerCase();

      if (normalized === "") {
        return defaultValue;
      }

      if (normalized === "y" || normalized === "yes") {
        return true;
      }

      if (normalized === "n" || normalized === "no") {
        return false;
      }

      outputStream.write("Invalid response. Please enter y or n.\n");
    }
  };

  return {
    compose,
    confirm,
    getState: () => (currentState ? clonePromptState(currentState) : null),
    getCloseReason: () => closeReason,
    close,
  };
}
