import { expect } from "@jest/globals";
import { PassThrough } from "stream";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import { createPromptComposer } from "../promptComposer.js";
import { createPromptHistoryStore } from "../promptHistory.js";
import { getIdleFooterText } from "../slashCommands.js";

export { createPromptComposer, getIdleFooterText };
import type { PromptEditorRunner } from "../promptEditor.js";
import type { PromptResult } from "../promptComposer.js";

export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function createTempHistoryStore(prefix: string): {
  tempDir: string;
  historyStore: ReturnType<typeof createPromptHistoryStore>;
  cleanup: () => void;
} {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const filePath = path.join(tempDir, "prompt-history.json");
  return {
    tempDir,
    historyStore: createPromptHistoryStore({ filePath }),
    cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }),
  };
}

export function createVisibilityFooterToggles(): {
  footer: () => string;
  onToggleToolCalls: () => string;
  onToggleThinking: () => string;
} {
  let showToolCalls = true;
  let showThinking = true;

  return {
    footer: () => getIdleFooterText({ showToolCalls, showThinking }),
    onToggleToolCalls: () => {
      showToolCalls = !showToolCalls;
      return getIdleFooterText({ showToolCalls, showThinking });
    },
    onToggleThinking: () => {
      showThinking = !showThinking;
      return getIdleFooterText({ showToolCalls, showThinking });
    },
  };
}

export function createFakeReadlineHarness() {
  let questionHandler: ((answer: string) => void) | null = null;
  let closeHandler: (() => void) | null = null;
  let sigintHandler: (() => void) | null = null;
  let history: string[] = [];

  const fakeRl = {
    get history() {
      return history;
    },
    set history(nextHistory: string[]) {
      history = nextHistory;
    },
    question: jest.fn(
      (_promptText: string, callback: (answer: string) => void) => {
        questionHandler = callback;
      },
    ),
    once: jest.fn((event: string, handler: () => void) => {
      if (event === "close") {
        closeHandler = handler;
      }
      return fakeRl;
    }),
    on: jest.fn((event: string, handler: () => void) => {
      if (event === "SIGINT") {
        sigintHandler = handler;
      }
      return fakeRl;
    }),
    pause: jest.fn(() => fakeRl as unknown as readline.Interface),
    resume: jest.fn(() => fakeRl as unknown as readline.Interface),
    close: jest.fn(() => {
      closeHandler?.();
    }),
  };

  const createInterface = jest.fn(
    (options: { history?: readonly string[] }) => {
      history = [...(options.history ?? [])];
      return fakeRl as unknown as readline.Interface;
    },
  );

  return {
    createInterface,
    fakeRl,
    getHistory: () => [...history],
    submit: (answer: string) => {
      for (let index = history.length - 1; index >= 0; index -= 1) {
        if (history[index] === answer) {
          history.splice(index, 1);
        }
      }
      history.unshift(answer);
      questionHandler?.(answer);
    },
    emitSigint: () => {
      sigintHandler?.();
    },
  };
}

export function createCapturingPassThroughStreams(): {
  inputStream: PassThrough;
  outputStream: PassThrough;
  getOutput: () => string;
  takeOutput: () => string;
} {
  const inputStream = new PassThrough();
  const outputStream = new PassThrough();
  outputStream.setEncoding("utf8");
  let output = "";

  outputStream.on("data", (chunk) => {
    output += chunk;
  });

  return {
    inputStream,
    outputStream,
    getOutput: () => output,
    takeOutput: () => {
      const current = output;
      output = "";
      return current;
    },
  };
}

export function createTtyStreams(columns = 80): {
  inputStream: PassThrough;
  outputStream: PassThrough;
  getOutput: () => string;
  takeOutput: () => string;
} {
  const streams = createCapturingPassThroughStreams();
  const { inputStream, outputStream } = streams;
  inputStream.setEncoding("utf8");

  (
    inputStream as PassThrough & { isTTY: boolean; setRawMode: jest.Mock }
  ).isTTY = true;
  const ttyOutput = outputStream as PassThrough & {
    isTTY: boolean;
    columns: number;
  };
  ttyOutput.isTTY = true;
  ttyOutput.columns = columns;

  return streams;
}

export type TtyHarness = ReturnType<typeof createTtyHarness>;

export function createTtyHarness(options?: {
  historyStore?: {
    load(): readonly string[];
    record(text: string): void;
  };
  renderFooter?: (footer: string) => void;
  renderState?: (state: unknown) => void;
  onToggleToolCalls?: () => string | null | undefined;
  onToggleThinking?: () => string | null | undefined;
  workspaceRoot?: string;
  enableReverseHistorySearch?: boolean;
  enableTypeahead?: boolean;
  columns?: number;
  editorRunner?: PromptEditorRunner;
  editorEnv?: NodeJS.ProcessEnv;
  setRawModeMock?: jest.Mock;
}) {
  const columns = options?.columns ?? 80;
  const streams = createTtyStreams(columns);
  (
    streams.inputStream as PassThrough & {
      setRawMode: jest.Mock;
    }
  ).setRawMode = options?.setRawModeMock ?? jest.fn();

  const readlineHarness = createFakeReadlineHarness();
  const composer = createPromptComposer({
    input: streams.inputStream as unknown as NodeJS.ReadStream,
    output: streams.outputStream as unknown as NodeJS.WriteStream,
    createInterface: readlineHarness.createInterface,
    historyStore: options?.historyStore,
    workspaceRoot: options?.workspaceRoot,
    enableReverseHistorySearch: options?.enableReverseHistorySearch,
    enableTypeahead: options?.enableTypeahead,
    editorRunner: options?.editorRunner,
    editorEnv: options?.editorEnv,
    renderFooter: options?.renderFooter,
    renderState: options?.renderState as ((state: unknown) => void) | undefined,
    onToggleToolCalls: options?.onToggleToolCalls,
    onToggleThinking: options?.onToggleThinking,
  });

  const emitKeypress = (
    key: Partial<readline.Key> & { name: string },
    str?: string,
  ): void => {
    streams.inputStream.emit("keypress", str, {
      sequence: str ?? "",
      ctrl: false,
      meta: false,
      shift: false,
      ...key,
    } as readline.Key);
  };

  const typeText = (text: string): void => {
    for (const character of text) {
      emitKeypress({ name: character }, character);
    }
  };

  return {
    composer,
    inputStream: streams.inputStream,
    outputStream: streams.outputStream,
    getOutput: streams.getOutput,
    takeOutput: streams.takeOutput,
    emitKeypress,
    typeText,
    readlineHarness,
  };
}

export function composeChatPrompt(
  harness: TtyHarness,
  options?: {
    promptText?: string;
    footer?: string;
  },
): Promise<PromptResult> {
  const prompt = harness.composer.compose({
    mode: "chat",
    promptText: options?.promptText ?? "Name? ",
    footer: options?.footer,
  });
  return flush().then(() => prompt);
}

export async function startDisabledSearchChatPrompt(
  harnessOptions?: Parameters<typeof createTtyHarness>[0],
): Promise<{ harness: TtyHarness; prompt: Promise<PromptResult> }> {
  const harness = createTtyHarness({
    enableReverseHistorySearch: false,
    enableTypeahead: false,
    ...harnessOptions,
  });
  await flush();
  const prompt = harness.composer.compose({
    mode: "chat",
    promptText: "Name? ",
  });
  await flush();
  return { harness, prompt };
}

export async function submitPromptText(
  harness: TtyHarness,
  prompt: Promise<PromptResult>,
  text: string,
): Promise<void> {
  harness.emitKeypress({ name: "return" }, "\r");
  await expect(prompt).resolves.toEqual({
    status: "submitted",
    text,
  });
}

export function createNonTtyPromptHarness(options?: {
  renderFooter?: (footer: string) => void;
  renderState?: (state: unknown) => void;
  onToggleToolCalls?: () => string | null | undefined;
  onToggleThinking?: () => string | null | undefined;
}) {
  const inputStream = new PassThrough();
  const outputStream = new PassThrough();
  outputStream.setEncoding("utf8");

  const composer = createPromptComposer({
    input: inputStream as unknown as NodeJS.ReadStream,
    output: outputStream as unknown as NodeJS.WriteStream,
    renderFooter: options?.renderFooter,
    renderState: options?.renderState as ((state: unknown) => void) | undefined,
    onToggleToolCalls: options?.onToggleToolCalls,
    onToggleThinking: options?.onToggleThinking,
  });

  return {
    composer,
    inputStream,
    outputStream,
  };
}

export function createReadlinePromptComposer(prefix: string): {
  historyStore: ReturnType<typeof createPromptHistoryStore>;
  cleanup: () => void;
  readlineHarness: ReturnType<typeof createFakeReadlineHarness>;
  composer: ReturnType<typeof createPromptComposer>;
} {
  const { historyStore, cleanup } = createTempHistoryStore(prefix);
  const readlineHarness = createFakeReadlineHarness();
  const composer = createPromptComposer({
    createInterface: readlineHarness.createInterface,
    historyStore,
  });

  return { historyStore, cleanup, readlineHarness, composer };
}

export async function startChatPrompt(
  harnessOptions?: Parameters<typeof createTtyHarness>[0],
): Promise<{ harness: TtyHarness; prompt: Promise<PromptResult> }> {
  const harness = createTtyHarness(harnessOptions);
  const prompt = harness.composer.compose({
    mode: "chat",
    promptText: "Name? ",
  });
  await flush();
  return { harness, prompt };
}

export async function startHistoryChatPrompt(options: {
  prefix: string;
  entries?: string[];
  columns?: number;
  clearOutput?: boolean;
  enableReverseHistorySearch?: boolean;
  enableTypeahead?: boolean;
}): Promise<{
  harness: TtyHarness;
  prompt: Promise<PromptResult>;
  historyStore: ReturnType<typeof createPromptHistoryStore>;
  cleanup: () => void;
}> {
  const { historyStore, cleanup } = createTempHistoryStore(options.prefix);
  for (const entry of options.entries ?? []) {
    historyStore.record(entry);
  }
  const harness = createTtyHarness({
    historyStore,
    columns: options.columns,
    enableReverseHistorySearch: options.enableReverseHistorySearch,
    enableTypeahead: options.enableTypeahead,
  });
  const prompt = harness.composer.compose({
    mode: "chat",
    promptText: "Name? ",
  });
  await flush();
  if (options.clearOutput) {
    harness.takeOutput();
  }
  return { harness, prompt, historyStore, cleanup };
}

export function triggerReverseHistorySearch(harness: TtyHarness): void {
  harness.emitKeypress({ name: "r", ctrl: true }, "\u0012");
}

export async function expectReadlineConfirm(
  readlineHarness: ReturnType<typeof createFakeReadlineHarness>,
  composer: ReturnType<typeof createPromptComposer>,
  answer = "y",
): Promise<void> {
  const confirm = composer.confirm({
    promptText: "Continue? ",
    defaultValue: false,
  });
  readlineHarness.submit(answer);
  await expect(confirm).resolves.toBe(true);
}

export async function closeHistoryPromptHarness(
  harness: TtyHarness,
  cleanup?: () => void,
): Promise<void> {
  harness.composer.close();
  cleanup?.();
}

export async function submitDraftAfterSearchCancel(
  harness: TtyHarness,
  prompt: Promise<PromptResult>,
  options?: { cleanup?: () => void; draftText?: string },
): Promise<void> {
  const draftText = options?.draftText ?? "draft";
  expect(harness.composer.getState()).toMatchObject({
    buffer: draftText,
    historySearch: undefined,
  });
  await submitPromptText(harness, prompt, draftText);
  await closeHistoryPromptHarness(harness, options?.cleanup);
}
