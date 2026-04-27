import * as readline from "readline";
import * as path from "path";
import {
  createChatPromptSession,
  type ChatPromptSession,
  type ChatPromptSessionState,
} from "./chatPromptSession.js";
import {
  applySubmittedText,
  createPromptState,
  type PromptRequest,
  type PromptState,
} from "./promptState.js";
import {
  createDefaultTypeaheadProviders,
  type TypeaheadProvider,
} from "./typeahead.js";
import {
  shouldRecordPromptHistoryEntry,
  type PromptHistoryStore,
} from "./promptHistory.js";
import type { PromptEditorRunner } from "./promptEditor.js";

export type { PromptMode, PromptState, PromptRequest } from "./promptState.js";

export type PromptCloseReason = "closed" | "interrupted";

export interface PromptResultSubmitted {
  status: "submitted";
  text: string;
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
  createInterface?: typeof readline.createInterface;
  renderFooter?: (footer: string) => void;
  renderState?: (state: PromptState | null) => void;
  historyStore?: PromptHistoryStore;
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

function shouldKeepLiveHistoryEntry(
  request: PromptRequest,
  submittedText: string,
): boolean {
  return (
    request.mode === "chat" && shouldRecordPromptHistoryEntry(submittedText)
  );
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

function clonePromptState(state: PromptState): PromptState {
  return {
    ...state,
    history: state.history ? [...state.history] : undefined,
    historySearch: state.historySearch ? { ...state.historySearch } : undefined,
    typeahead: state.typeahead
      ? {
          ...state.typeahead,
          matches: [...state.typeahead.matches],
        }
      : undefined,
  };
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

  rl.once("close", () => {
    closed = true;
    setCloseReason("closed");
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

    if (result.status === "submitted" && currentState && activePrompt) {
      currentState = applySubmittedText(currentState, result.text);
      const shouldKeepHistory = shouldKeepLiveHistoryEntry(
        activePrompt.request,
        result.text,
      );

      if (shouldKeepHistory) {
        try {
          options.historyStore?.record(result.text);
        } catch {
          // Prompt history is best-effort and must not block submission.
        }

        const updatedHistory = updateLiveHistorySnapshot(
          liveHistory,
          result.text,
        );
        liveHistory.splice(0, liveHistory.length, ...updatedHistory);
      } else if (!activePrompt.isCustomChat) {
        restoreLiveHistory(rl, activePrompt.historySnapshot);
      }
    }

    activePrompt = null;
    options.renderState?.(null);
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

    if (request.footer && options.renderFooter) {
      options.renderFooter(request.footer);
    }

    return await new Promise<PromptResult>((resolve) => {
      pendingResolve = resolve;

      if (activePrompt?.isCustomChat) {
        readline.emitKeypressEvents(inputStream);
        activeChatSession = createChatPromptSession({
          inputStream,
          outputStream,
          request,
          historySnapshot: [...liveHistory],
          enableTypeahead:
            request.mode === "chat" && typeaheadEnabled && !closed,
          enableReverseHistorySearch: reverseHistorySearchEnabled,
          workspaceRoot,
          typeaheadProviders,
          editorRunner: options.editorRunner,
          editorEnv: options.editorEnv,
          callbacks: {
            render: syncChatState,
            submit: (text) => settlePending({ status: "submitted", text }),
            interrupt: () => {
              setCloseReason("interrupted");
              process.kill(process.pid, "SIGINT");
            },
            close,
          },
        });
        return;
      }

      inputStream.resume();
      rl.question(request.promptText, (answer) => {
        settlePending({ status: "submitted", text: answer });
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

      const normalized = result.text.trim().toLowerCase();

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
