import { PassThrough } from "stream";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import { createPromptComposer } from "../promptComposer.js";
import { createPromptHistoryStore } from "../promptHistory.js";

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function createHarness(renderFooter?: (footer: string) => void) {
  const inputStream = new PassThrough();
  const outputStream = new PassThrough();
  outputStream.setEncoding("utf8");

  const composer = createPromptComposer({
    input: inputStream as unknown as NodeJS.ReadStream,
    output: outputStream as unknown as NodeJS.WriteStream,
    renderFooter,
  });

  return {
    composer,
    inputStream,
    outputStream,
  };
}

function createFakeReadlineHarness() {
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

function createTtyHarness(options?: {
  historyStore?: {
    load(): readonly string[];
    record(text: string): void;
  };
  workspaceRoot?: string;
  enableReverseHistorySearch?: boolean;
  enableTypeahead?: boolean;
}) {
  const inputStream = new PassThrough();
  const outputStream = new PassThrough();
  outputStream.setEncoding("utf8");
  let output = "";
  outputStream.on("data", (chunk) => {
    output += chunk;
  });
  inputStream.setEncoding("utf8");

  (
    inputStream as PassThrough & { isTTY: boolean; setRawMode: jest.Mock }
  ).isTTY = true;
  (outputStream as PassThrough & { isTTY: boolean }).isTTY = true;
  (
    inputStream as PassThrough & {
      setRawMode: jest.Mock;
    }
  ).setRawMode = jest.fn();

  const readlineHarness = createFakeReadlineHarness();
  const composer = createPromptComposer({
    input: inputStream as unknown as NodeJS.ReadStream,
    output: outputStream as unknown as NodeJS.WriteStream,
    createInterface: readlineHarness.createInterface,
    historyStore: options?.historyStore,
    workspaceRoot: options?.workspaceRoot,
    enableReverseHistorySearch: options?.enableReverseHistorySearch,
    enableTypeahead: options?.enableTypeahead,
  });

  const emitKeypress = (
    key: Partial<readline.Key> & { name: string },
    str?: string,
  ): void => {
    inputStream.emit("keypress", str, {
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
    inputStream,
    outputStream,
    getOutput: () => output,
    emitKeypress,
    typeText,
    readlineHarness,
  };
}

describe("createPromptComposer", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("exposes the current prompt state while composing", async () => {
    const harness = createHarness();

    const prompt = harness.composer.compose({
      mode: "chat",
      promptText: "Name? ",
      placeholder: "type here",
      footer: "footer text",
    });

    const activeState = harness.composer.getState();
    expect(activeState).toEqual({
      buffer: "",
      cursor: 0,
      mode: "chat",
      placeholder: "type here",
      footer: "footer text",
      history: undefined,
    });

    await flush();
    harness.inputStream.write("alice\n");

    await expect(prompt).resolves.toEqual({
      status: "submitted",
      text: "alice",
    });

    expect(harness.composer.getState()).toMatchObject({
      buffer: "alice",
      cursor: 5,
      mode: "chat",
      placeholder: "type here",
      footer: "footer text",
    });

    harness.composer.close();
  });

  it("positions the cursor using visible prompt width when the prompt is styled", async () => {
    const harness = createTtyHarness();
    const styledPrompt = "\u001b[36m>\u001b[39m ";
    const visiblePromptWidth = 2;

    const prompt = harness.composer.compose({
      mode: "chat",
      promptText: styledPrompt,
    });
    await flush();

    expect(harness.getOutput()).toContain(`\u001b[${visiblePromptWidth + 1}G`);
    expect(harness.getOutput()).not.toContain(
      `\u001b[${styledPrompt.length + 1}G`,
    );

    harness.inputStream.write("a\n");
    await expect(prompt).resolves.toEqual({
      status: "submitted",
      text: "a",
    });

    harness.composer.close();
  });

  it("renders the supplied footer through the injected renderer", async () => {
    const renderFooter = jest.fn();
    const harness = createHarness(renderFooter);

    const prompt = harness.composer.compose({
      mode: "chat",
      promptText: "Name? ",
      footer: "Idle footer",
    });

    await flush();
    expect(renderFooter).toHaveBeenCalledWith("Idle footer");

    harness.inputStream.write("alice\n");
    await expect(prompt).resolves.toEqual({
      status: "submitted",
      text: "alice",
    });

    harness.composer.close();
  });

  it("loads history into readline with duplicate removal enabled", () => {
    const historyStore = {
      load: jest.fn(() => ["recent", "older"]),
      record: jest.fn(),
    };
    const readlineHarness = createFakeReadlineHarness();

    createPromptComposer({
      createInterface: readlineHarness.createInterface,
      historyStore,
    });

    expect(historyStore.load).toHaveBeenCalledTimes(1);
    expect(readlineHarness.createInterface).toHaveBeenCalledWith(
      expect.objectContaining({
        history: ["recent", "older"],
        historySize: 200,
        removeHistoryDuplicates: true,
      }),
    );
  });

  it("disables readline terminal mode for typeahead-only custom prompts", () => {
    const harness = createTtyHarness({
      enableReverseHistorySearch: false,
      enableTypeahead: true,
    });

    expect(harness.readlineHarness.createInterface).toHaveBeenCalledWith(
      expect.objectContaining({
        terminal: false,
      }),
    );

    harness.composer.close();
  });

  it("records submitted chat input", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "propio-chat-"));
    const filePath = path.join(tempDir, "prompt-history.json");
    const historyStore = createPromptHistoryStore({ filePath });
    const readlineHarness = createFakeReadlineHarness();

    const composer = createPromptComposer({
      createInterface: readlineHarness.createInterface,
      historyStore,
    });

    const prompt = composer.compose({
      mode: "chat",
      promptText: "Name? ",
    });

    readlineHarness.submit("hello");

    await expect(prompt).resolves.toEqual({
      status: "submitted",
      text: "hello",
    });
    expect(historyStore.load()).toEqual(["hello"]);

    composer.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("does not record blank input, confirm input, or control commands", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "propio-history-"));
    const filePath = path.join(tempDir, "prompt-history.json");
    const historyStore = createPromptHistoryStore({ filePath });
    const readlineHarness = createFakeReadlineHarness();

    const composer = createPromptComposer({
      createInterface: readlineHarness.createInterface,
      historyStore,
    });

    const blank = composer.compose({
      mode: "chat",
      promptText: "Name? ",
    });
    readlineHarness.submit("   ");
    await expect(blank).resolves.toEqual({
      status: "submitted",
      text: "   ",
    });

    const clear = composer.compose({
      mode: "chat",
      promptText: "Name? ",
    });
    readlineHarness.submit("/clear");
    await expect(clear).resolves.toEqual({
      status: "submitted",
      text: "/clear",
    });

    const confirm = composer.confirm({
      promptText: "Continue? ",
      defaultValue: false,
    });
    readlineHarness.submit("y");
    await expect(confirm).resolves.toBe(true);

    const exit = composer.compose({
      mode: "chat",
      promptText: "Name? ",
    });
    readlineHarness.submit("/exit");
    await expect(exit).resolves.toEqual({
      status: "submitted",
      text: "/exit",
    });

    const quit = composer.compose({
      mode: "chat",
      promptText: "Name? ",
    });
    readlineHarness.submit("/quit");
    await expect(quit).resolves.toEqual({
      status: "submitted",
      text: "/quit",
    });

    expect(historyStore.load()).toEqual([]);

    composer.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("records useful slash commands", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "propio-slash-"));
    const filePath = path.join(tempDir, "prompt-history.json");
    const historyStore = createPromptHistoryStore({ filePath });
    const readlineHarness = createFakeReadlineHarness();

    const composer = createPromptComposer({
      createInterface: readlineHarness.createInterface,
      historyStore,
    });

    const prompt = composer.compose({
      mode: "chat",
      promptText: "Name? ",
    });
    readlineHarness.submit("/context");

    await expect(prompt).resolves.toEqual({
      status: "submitted",
      text: "/context",
    });
    expect(historyStore.load()).toEqual(["/context"]);
    expect(readlineHarness.getHistory()).toEqual(["/context"]);

    composer.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("removes skipped submissions from live readline history", async () => {
    const readlineHarness = createFakeReadlineHarness();
    const composer = createPromptComposer({
      createInterface: readlineHarness.createInterface,
    });

    const menu = composer.compose({
      mode: "menu",
      promptText: "Choice? ",
    });
    readlineHarness.submit("1");
    await expect(menu).resolves.toEqual({
      status: "submitted",
      text: "1",
    });
    expect(readlineHarness.getHistory()).toEqual([]);

    const blank = composer.compose({
      mode: "chat",
      promptText: "Name? ",
    });
    readlineHarness.submit("   ");
    await expect(blank).resolves.toEqual({
      status: "submitted",
      text: "   ",
    });
    expect(readlineHarness.getHistory()).toEqual([]);

    const clear = composer.compose({
      mode: "chat",
      promptText: "Name? ",
    });
    readlineHarness.submit("/clear");
    await expect(clear).resolves.toEqual({
      status: "submitted",
      text: "/clear",
    });
    expect(readlineHarness.getHistory()).toEqual([]);

    const confirm = composer.confirm({
      promptText: "Continue? ",
      defaultValue: false,
    });
    readlineHarness.submit("y");
    await expect(confirm).resolves.toBe(true);
    expect(readlineHarness.getHistory()).toEqual([]);

    const exit = composer.compose({
      mode: "chat",
      promptText: "Name? ",
    });
    readlineHarness.submit("/exit");
    await expect(exit).resolves.toEqual({
      status: "submitted",
      text: "/exit",
    });
    expect(readlineHarness.getHistory()).toEqual([]);

    composer.close();
  });

  it("restores the prior live history snapshot for skipped duplicate inputs", async () => {
    const historyStore = {
      load: jest.fn(() => ["y"]),
      record: jest.fn(),
    };
    const readlineHarness = createFakeReadlineHarness();
    const composer = createPromptComposer({
      createInterface: readlineHarness.createInterface,
      historyStore,
    });

    const confirm = composer.confirm({
      promptText: "Continue? ",
      defaultValue: false,
    });
    readlineHarness.submit("y");

    await expect(confirm).resolves.toBe(true);
    expect(readlineHarness.getHistory()).toEqual(["y"]);

    composer.close();
  });
});

describe("createPromptComposer reverse history search", () => {
  it("starts reverse search only for chat prompts and records recalled submissions", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "propio-search-"));
    const filePath = path.join(tempDir, "prompt-history.json");
    const historyStore = createPromptHistoryStore({ filePath });
    historyStore.record("older");
    historyStore.record("newer");
    const harness = createTtyHarness({ historyStore });

    const prompt = harness.composer.compose({
      mode: "chat",
      promptText: "Name? ",
    });
    await flush();

    harness.emitKeypress({ name: "r", ctrl: true }, "\u0012");
    expect(harness.composer.getState()).toMatchObject({
      buffer: "newer",
      cursor: 5,
      mode: "chat",
      historySearch: {
        active: true,
        query: "",
        match: "newer",
        matchIndex: 0,
        matchCount: 2,
      },
    });
    expect(harness.getOutput()).toContain("history search:   match: newer");
    expect(harness.getOutput()).not.toContain("reverse search:");

    harness.emitKeypress({ name: "r", ctrl: true }, "\u0012");
    expect(harness.composer.getState()).toMatchObject({
      buffer: "older",
      cursor: 5,
      historySearch: {
        active: true,
        query: "",
        match: "older",
        matchIndex: 1,
        matchCount: 2,
      },
    });
    expect(harness.getOutput()).toContain("history search:   match: older");

    harness.emitKeypress({ name: "return" }, "\r");
    expect(harness.composer.getState()).toMatchObject({
      buffer: "older",
      cursor: 5,
      historySearch: undefined,
    });

    harness.emitKeypress({ name: "return" }, "\r");
    await expect(prompt).resolves.toEqual({
      status: "submitted",
      text: "older",
    });
    expect(historyStore.load()).toEqual(["older", "newer"]);
    expect(harness.getOutput()).toContain("\n");

    harness.composer.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("handles raw bytes without readline echo during reverse search", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "propio-bytes-"));
    const filePath = path.join(tempDir, "prompt-history.json");
    const historyStore = createPromptHistoryStore({ filePath });
    historyStore.record("hello world");
    const harness = createTtyHarness({ historyStore });

    const prompt = harness.composer.compose({
      mode: "chat",
      promptText: "Name? ",
    });
    await flush();

    harness.inputStream.write("h");
    harness.inputStream.write("e");
    harness.inputStream.write("l");

    expect(harness.composer.getState()).toMatchObject({
      buffer: "hel",
      historySearch: undefined,
    });
    expect(harness.getOutput().match(/hel/g)?.length).toBe(1);

    harness.inputStream.write(String.fromCharCode(18));
    harness.inputStream.write("l");
    expect(harness.composer.getState()).toMatchObject({
      buffer: "hello world",
      historySearch: {
        active: true,
        query: "l",
        match: "hello world",
        matchIndex: 0,
        matchCount: 1,
      },
    });
    expect(harness.getOutput()).toContain(
      "history search: l  match: hello world",
    );
    expect(harness.getOutput()).not.toContain(
      "hello world  reverse search: l -> hello world",
    );

    harness.inputStream.write("\r");
    harness.inputStream.write("!");
    expect(harness.composer.getState()).toMatchObject({
      buffer: "hello world!",
      historySearch: undefined,
    });

    harness.inputStream.write("\r");
    await expect(prompt).resolves.toEqual({
      status: "submitted",
      text: "hello world!",
    });

    harness.composer.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("ignores reverse search for confirm prompts", async () => {
    const harness = createTtyHarness();

    const prompt = harness.composer.confirm({
      promptText: "Continue? ",
      defaultValue: false,
    });
    await flush();

    harness.emitKeypress({ name: "r", ctrl: true }, "\u0012");
    expect(harness.composer.getState()).toMatchObject({
      mode: "confirm",
      historySearch: undefined,
    });

    harness.readlineHarness.submit("y");
    await expect(prompt).resolves.toBe(true);

    harness.composer.close();
  });

  it("cancels reverse search and restores the draft", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "propio-cancel-"));
    const filePath = path.join(tempDir, "prompt-history.json");
    const historyStore = createPromptHistoryStore({ filePath });
    historyStore.record("first");
    const harness = createTtyHarness({ historyStore });

    const prompt = harness.composer.compose({
      mode: "chat",
      promptText: "Name? ",
    });
    await flush();

    harness.typeText("draft");
    harness.emitKeypress({ name: "r", ctrl: true }, "\u0012");
    harness.typeText("fi");
    expect(harness.composer.getState()).toMatchObject({
      buffer: "first",
      historySearch: {
        active: true,
        query: "fi",
        match: "first",
        matchIndex: 0,
        matchCount: 1,
      },
    });

    harness.emitKeypress({ name: "escape" }, "\u001b");
    expect(harness.composer.getState()).toMatchObject({
      buffer: "draft",
      historySearch: undefined,
    });

    harness.emitKeypress({ name: "return" }, "\r");
    await expect(prompt).resolves.toEqual({
      status: "submitted",
      text: "draft",
    });

    harness.composer.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("shows a no-match status without discarding the draft", async () => {
    const harness = createTtyHarness();

    const prompt = harness.composer.compose({
      mode: "chat",
      promptText: "Name? ",
    });
    await flush();

    harness.typeText("draft");
    harness.emitKeypress({ name: "r", ctrl: true }, "\u0012");
    harness.typeText("zzz");

    expect(harness.composer.getState()).toMatchObject({
      buffer: "draft",
      historySearch: {
        active: true,
        query: "zzz",
        match: undefined,
        matchIndex: -1,
        matchCount: 0,
      },
    });
    expect(harness.getOutput()).toContain("history search: zzz  no matches");

    harness.emitKeypress({ name: "escape" }, "\u001b");
    harness.emitKeypress({ name: "return" }, "\r");
    await expect(prompt).resolves.toEqual({
      status: "submitted",
      text: "draft",
    });

    harness.composer.close();
  });

  it("cancels reverse search with Ctrl+G", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "propio-ctrlg-"));
    const filePath = path.join(tempDir, "prompt-history.json");
    const historyStore = createPromptHistoryStore({ filePath });
    historyStore.record("first");
    const harness = createTtyHarness({ historyStore });

    const prompt = harness.composer.compose({
      mode: "chat",
      promptText: "Name? ",
    });
    await flush();

    harness.typeText("draft");
    harness.emitKeypress({ name: "r", ctrl: true }, "\u0012");
    harness.typeText("fi");
    harness.emitKeypress({ name: "g", ctrl: true }, "\u0007");

    expect(harness.composer.getState()).toMatchObject({
      buffer: "draft",
      historySearch: undefined,
    });

    harness.emitKeypress({ name: "return" }, "\r");
    await expect(prompt).resolves.toEqual({
      status: "submitted",
      text: "draft",
    });

    harness.composer.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("lets recalled search text be edited before submission", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "propio-edit-"));
    const filePath = path.join(tempDir, "prompt-history.json");
    const historyStore = createPromptHistoryStore({ filePath });
    historyStore.record("hello world");
    const harness = createTtyHarness({ historyStore });

    const prompt = harness.composer.compose({
      mode: "chat",
      promptText: "Name? ",
    });
    await flush();

    harness.emitKeypress({ name: "r", ctrl: true }, "\u0012");
    harness.typeText("hello");
    harness.emitKeypress({ name: "return" }, "\r");
    harness.typeText("!");

    expect(harness.composer.getState()).toMatchObject({
      buffer: "hello world!",
      historySearch: undefined,
    });

    harness.emitKeypress({ name: "return" }, "\r");
    await expect(prompt).resolves.toEqual({
      status: "submitted",
      text: "hello world!",
    });

    harness.composer.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("closes the custom prompt on Ctrl+D", async () => {
    const harness = createTtyHarness();

    const prompt = harness.composer.compose({
      mode: "chat",
      promptText: "Name? ",
    });
    await flush();

    harness.emitKeypress({ name: "d", ctrl: true }, "\u0004");

    await expect(prompt).resolves.toEqual({ status: "closed" });
    expect(harness.composer.getCloseReason()).toBe("closed");

    harness.composer.close();
  });

  it("preserves unsent drafts while navigating history", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "propio-nav-"));
    const filePath = path.join(tempDir, "prompt-history.json");
    const historyStore = createPromptHistoryStore({ filePath });
    historyStore.record("newest");
    historyStore.record("older");
    const harness = createTtyHarness({ historyStore });

    const prompt = harness.composer.compose({
      mode: "chat",
      promptText: "Name? ",
    });
    await flush();

    harness.typeText("draft");
    harness.emitKeypress({ name: "up" });
    expect(harness.composer.getState()).toMatchObject({
      buffer: "older",
    });

    harness.emitKeypress({ name: "down" });
    expect(harness.composer.getState()).toMatchObject({
      buffer: "draft",
    });

    harness.emitKeypress({ name: "return" }, "\r");
    await expect(prompt).resolves.toEqual({
      status: "submitted",
      text: "draft",
    });

    harness.composer.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("exposes active search summary without leaking mutable arrays", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "propio-state-"));
    const filePath = path.join(tempDir, "prompt-history.json");
    const historyStore = createPromptHistoryStore({ filePath });
    historyStore.record("match");
    const harness = createTtyHarness({ historyStore });

    const prompt = harness.composer.compose({
      mode: "chat",
      promptText: "Name? ",
    });
    await flush();

    harness.emitKeypress({ name: "r", ctrl: true }, "\u0012");
    const state = harness.composer.getState();

    expect(state).toMatchObject({
      buffer: "match",
      historySearch: {
        active: true,
        query: "",
        match: "match",
        matchIndex: 0,
        matchCount: 1,
      },
    });
    expect(state?.history).toBeUndefined();

    harness.emitKeypress({ name: "return" }, "\r");
    harness.emitKeypress({ name: "return" }, "\r");
    await expect(prompt).resolves.toEqual({
      status: "submitted",
      text: "match",
    });

    harness.composer.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});

describe("createPromptComposer typeahead", () => {
  function makeWorkspaceRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "propio-typeahead-"));
  }

  it("accepts a unique slash completion without submitting", async () => {
    const harness = createTtyHarness();

    const prompt = harness.composer.compose({
      mode: "chat",
      promptText: "Name? ",
    });
    await flush();

    harness.typeText("/cle");
    harness.emitKeypress({ name: "tab" }, "\t");

    expect(harness.composer.getState()).toMatchObject({
      buffer: "/clear",
      cursor: 6,
      typeahead: undefined,
    });

    harness.emitKeypress({ name: "return" }, "\r");
    await expect(prompt).resolves.toEqual({
      status: "submitted",
      text: "/clear",
    });

    harness.composer.close();
  });

  it("cycles multiple slash-command matches and clones the summary state", async () => {
    const harness = createTtyHarness();

    const prompt = harness.composer.compose({
      mode: "chat",
      promptText: "Name? ",
    });
    await flush();

    harness.typeText("/con");
    harness.emitKeypress({ name: "tab" }, "\t");

    const firstState = harness.composer.getState();
    expect(firstState).toMatchObject({
      buffer: "/context",
      cursor: 8,
      typeahead: {
        active: true,
        kind: "command",
        query: "/con",
        match: "/context",
        matchIndex: 0,
        matchCount: 3,
        matches: ["/context", "/context prompt", "/context memory"],
      },
    });

    expect(harness.getOutput()).toContain("tab: /context");

    if (firstState?.typeahead) {
      const clonedMatches = firstState.typeahead.matches as string[];
      clonedMatches[0] = "mutated";
    }

    expect(harness.composer.getState()).toMatchObject({
      typeahead: {
        matches: ["/context", "/context prompt", "/context memory"],
      },
    });

    harness.emitKeypress({ name: "tab" }, "\t");
    expect(harness.composer.getState()).toMatchObject({
      buffer: "/context prompt",
      typeahead: {
        match: "/context prompt",
        matchIndex: 1,
        matchCount: 3,
      },
    });

    harness.emitKeypress({ name: "return" }, "\r");
    await expect(prompt).resolves.toEqual({
      status: "submitted",
      text: "/context prompt",
    });

    harness.composer.close();
  });

  it("completes workspace paths inside natural language prompts", async () => {
    const workspaceRoot = makeWorkspaceRoot();
    fs.mkdirSync(path.join(workspaceRoot, "docs"), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceRoot, "docs", "prompt-composer.md"),
      "test",
    );

    const harness = createTtyHarness({ workspaceRoot });

    const prompt = harness.composer.compose({
      mode: "chat",
      promptText: "Name? ",
    });
    await flush();

    harness.typeText("read docs/pro");
    harness.emitKeypress({ name: "tab" }, "\t");

    expect(harness.composer.getState()).toMatchObject({
      buffer: "read docs/prompt-composer.md",
      cursor: "read docs/prompt-composer.md".length,
      typeahead: undefined,
    });

    harness.emitKeypress({ name: "return" }, "\r");
    await expect(prompt).resolves.toEqual({
      status: "submitted",
      text: "read docs/prompt-composer.md",
    });

    harness.composer.close();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("cancels active typeahead on Escape and Ctrl+G", async () => {
    const harness = createTtyHarness();

    const firstPrompt = harness.composer.compose({
      mode: "chat",
      promptText: "Name? ",
    });
    await flush();

    harness.typeText("/con");
    harness.emitKeypress({ name: "tab" }, "\t");
    harness.emitKeypress({ name: "escape" }, "\u001b");

    expect(harness.composer.getState()).toMatchObject({
      buffer: "/con",
      typeahead: undefined,
    });

    harness.emitKeypress({ name: "return" }, "\r");
    await expect(firstPrompt).resolves.toEqual({
      status: "submitted",
      text: "/con",
    });

    const secondPrompt = harness.composer.compose({
      mode: "chat",
      promptText: "Name? ",
    });
    await flush();

    harness.typeText("/con");
    harness.emitKeypress({ name: "tab" }, "\t");
    harness.emitKeypress({ name: "g", ctrl: true }, "\u0007");

    expect(harness.composer.getState()).toMatchObject({
      buffer: "/con",
      typeahead: undefined,
    });

    harness.emitKeypress({ name: "return" }, "\r");
    await expect(secondPrompt).resolves.toEqual({
      status: "submitted",
      text: "/con",
    });

    harness.composer.close();
  });

  it("clears typeahead before reverse search and restores the draft on cancel", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "propio-search-"));
    const filePath = path.join(tempDir, "prompt-history.json");
    const historyStore = createPromptHistoryStore({ filePath });
    historyStore.record("older");
    const harness = createTtyHarness({ historyStore });

    const prompt = harness.composer.compose({
      mode: "chat",
      promptText: "Name? ",
    });
    await flush();

    harness.typeText("/con");
    harness.emitKeypress({ name: "tab" }, "\t");
    harness.emitKeypress({ name: "r", ctrl: true }, "\u0012");

    expect(harness.composer.getState()).toMatchObject({
      historySearch: {
        active: true,
        query: "",
      },
      typeahead: undefined,
      buffer: "older",
    });

    harness.typeText("old");
    harness.emitKeypress({ name: "escape" }, "\u001b");

    expect(harness.composer.getState()).toMatchObject({
      buffer: "/con",
      historySearch: undefined,
    });

    harness.emitKeypress({ name: "return" }, "\r");
    await expect(prompt).resolves.toEqual({
      status: "submitted",
      text: "/con",
    });

    harness.composer.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("cancels a typeahead when the draft is edited", async () => {
    const harness = createTtyHarness();

    const prompt = harness.composer.compose({
      mode: "chat",
      promptText: "Name? ",
    });
    await flush();

    harness.typeText("/con");
    harness.emitKeypress({ name: "tab" }, "\t");
    harness.typeText("!");

    expect(harness.composer.getState()).toMatchObject({
      buffer: "/con!",
      typeahead: undefined,
    });

    harness.emitKeypress({ name: "return" }, "\r");
    await expect(prompt).resolves.toEqual({
      status: "submitted",
      text: "/con!",
    });

    harness.composer.close();
  });

  it("keeps confirm prompts on the readline path and ignores Tab", async () => {
    const harness = createTtyHarness();

    const prompt = harness.composer.confirm({
      promptText: "Continue? ",
      defaultValue: false,
    });
    await flush();

    harness.emitKeypress({ name: "tab" }, "\t");
    expect(harness.composer.getState()).toMatchObject({
      mode: "confirm",
      typeahead: undefined,
      historySearch: undefined,
    });

    harness.readlineHarness.submit("y");
    await expect(prompt).resolves.toBe(true);

    harness.composer.close();
  });
});
