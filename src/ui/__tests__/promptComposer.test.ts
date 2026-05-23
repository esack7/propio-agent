import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { PromptEditorRunner } from "../promptEditor.js";
import {
  closeHistoryPromptHarness,
  composeChatPrompt,
  createFakeReadlineHarness,
  createNonTtyPromptHarness,
  createPromptComposer,
  createReadlinePromptComposer,
  createTtyHarness,
  createVisibilityFooterToggles,
  expectReadlineConfirm,
  flush,
  getIdleFooterText,
  startChatPrompt,
  startDisabledSearchChatPrompt,
  startHistoryChatPrompt,
  submitDraftAfterSearchCancel,
  submitPromptText,
  triggerReverseHistorySearch,
  type TtyHarness,
} from "./promptComposerTestHelpers.js";
import { getBashFooterText } from "../slashCommands.js";

jest.setTimeout(10000);

function stripAnsiControls(text: string): string {
  return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

async function submitTwoLineMultilineDraft(
  harness: TtyHarness,
  prompt: Promise<unknown>,
  options: {
    firstLine: string;
    secondLine: string;
    newline: "ctrl-j" | "lf";
  },
): Promise<void> {
  harness.typeText(options.firstLine);
  if (options.newline === "ctrl-j") {
    harness.emitKeypress({ name: "j", ctrl: true }, "\n");
  } else {
    harness.emitKeypress({ name: "return" }, "\n");
  }

  expect(harness.composer.getState()).toMatchObject({
    buffer: `${options.firstLine}\n`,
    cursor: options.firstLine.length + 1,
    multiline: true,
  });

  harness.typeText(options.secondLine);
  harness.emitKeypress({ name: "return" }, "\r");
  await expect(prompt).resolves.toEqual({
    status: "submitted",
    inputMode: "prompt",
    text: `${options.firstLine}\n${options.secondLine}`,
  });
}

async function startMultilineChatPrompt() {
  const { harness, prompt } = await startDisabledSearchChatPrompt();
  harness.takeOutput();
  return { harness, prompt };
}

describe("createPromptComposer", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("exposes the current prompt state while composing", async () => {
    const harness = createNonTtyPromptHarness();

    const prompt = harness.composer.compose({
      mode: "chat",
      promptText: "Name? ",
      placeholder: "type here",
      footer: "footer text",
    });

    const activeState = harness.composer.getState();
    expect(activeState).toMatchObject({
      buffer: "",
      cursor: 0,
      mode: "chat",
      placeholder: "type here",
      footer: "footer text",
      history: undefined,
      multiline: false,
    });

    await flush();
    harness.inputStream.write("alice\n");

    await expect(prompt).resolves.toEqual({
    status: "submitted",
    inputMode: "prompt",
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

    expect(harness.getOutput()).toContain(`\u001b[${visiblePromptWidth + 1}G`);
    expect(harness.getOutput()).not.toContain(
      `\u001b[${styledPrompt.length + 1}G`,
    );

    harness.composer.close();
  });

  it("wraps chat input at word boundaries", async () => {
    const harness = createTtyHarness({
      enableReverseHistorySearch: false,
      enableTypeahead: false,
      columns: 15,
    });

    const prompt = harness.composer.compose({
      mode: "chat",
      promptText: "> ",
    });
    await flush();
    harness.takeOutput();

    harness.typeText("alpha beta gamma");

    expect(harness.getOutput()).toContain("> alpha beta \n  gamma");

    harness.composer.close();
    await expect(prompt).resolves.toEqual({
      status: "closed",
    });
  });

  it("renders the supplied footer through the injected renderer", async () => {
    const renderFooter = jest.fn();
    const harness = createNonTtyPromptHarness({ renderFooter });

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
    inputMode: "prompt",
    text: "alice",
    });

    harness.composer.close();
  });

  it("updates the active footer when tool calls are toggled", async () => {
    const renderFooter = jest.fn();
    const renderState = jest.fn();
    const visibility = createVisibilityFooterToggles();
    const harness = createTtyHarness({
      renderFooter,
      renderState,
      enableReverseHistorySearch: false,
      enableTypeahead: false,
      onToggleToolCalls: visibility.onToggleToolCalls,
      onToggleThinking: visibility.onToggleThinking,
    });

    const prompt = composeChatPrompt(harness, {
      footer: visibility.footer(),
    });
    await flush();
    expect(renderFooter).not.toHaveBeenCalled();
    expect(stripAnsiControls(harness.takeOutput())).toContain(
      "Enter to send | ? help | tools: shown | thinking: shown\nName? ",
    );

    harness.inputStream.emit("keypress", "\u000f", {
      name: "o",
      ctrl: true,
      meta: false,
      shift: false,
    });

    const toggleOutput = stripAnsiControls(harness.takeOutput());
    expect(toggleOutput).toContain(
      "Enter to send | ? help | tools: hidden | thinking: shown\nName? ",
    );
    expect(toggleOutput).not.toContain("tools: shown | thinking: shown");
    expect(renderState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        buffer: "",
        footer: "Enter to send | ? help | tools: hidden | thinking: shown",
      }),
    );

    harness.composer.close();
  });

  it("updates the active footer when thinking is toggled", async () => {
    const renderFooter = jest.fn();
    const visibility = createVisibilityFooterToggles();
    const harness = createTtyHarness({
      renderFooter,
      enableReverseHistorySearch: false,
      enableTypeahead: false,
      onToggleThinking: visibility.onToggleThinking,
    });

    const prompt = composeChatPrompt(harness, {
      footer: visibility.footer(),
    });
    await flush();
    expect(stripAnsiControls(harness.takeOutput())).toContain(
      "Enter to send | ? help | tools: shown | thinking: shown\nName? ",
    );

    harness.inputStream.emit("keypress", "\u0014", {
      name: "t",
      ctrl: true,
      meta: false,
      shift: false,
    });

    const toggleOutput = stripAnsiControls(harness.takeOutput());
    expect(toggleOutput).toContain(
      "Enter to send | ? help | tools: shown | thinking: hidden\nName? ",
    );

    harness.composer.close();
    await expect(prompt).resolves.toEqual({
      status: "closed",
    });
  });

  it("wraps the active footer before repainting narrow chat prompts", async () => {
    const visibility = createVisibilityFooterToggles();
    const harness = createTtyHarness({
      columns: 40,
      enableReverseHistorySearch: false,
      enableTypeahead: false,
      onToggleToolCalls: visibility.onToggleToolCalls,
      onToggleThinking: visibility.onToggleThinking,
    });

    const prompt = composeChatPrompt(harness, {
      footer: visibility.footer(),
    });
    await flush();
    expect(stripAnsiControls(harness.takeOutput())).toContain(
      "Enter to send | ? help | tools: shown |\n thinking: shown\nName? ",
    );

    harness.inputStream.emit("keypress", "\u000f", {
      name: "o",
      ctrl: true,
      meta: false,
      shift: false,
    });

    const toggleOutput = stripAnsiControls(harness.takeOutput());
    expect(toggleOutput).toContain(
      "Enter to send | ? help | tools: hidden\n| thinking: shown\nName? ",
    );
    expect(toggleOutput).not.toContain("shown | thinking: shown\nName? ");

    harness.composer.close();
    await expect(prompt).resolves.toEqual({
      status: "closed",
    });
  });

  it("repaints the active chat prompt when terminal columns change", async () => {
    const harness = createTtyHarness({
      enableReverseHistorySearch: false,
      enableTypeahead: false,
      columns: 50,
    });

    const prompt = harness.composer.compose({
      mode: "chat",
      promptText: "> ",
    });
    await flush();

    harness.typeText("alpha beta gamma delta");
    harness.takeOutput();

    (harness.outputStream as NodeJS.WriteStream).columns = 14;
    harness.outputStream.emit("resize");

    const output = harness.takeOutput();
    expect(output).toMatch(/\u001b\[(?:0)?J/);
    expect(output).toContain("> alpha beta");
    expect(output).toContain("  gamma delta");

    harness.composer.close();
    await expect(prompt).resolves.toEqual({
      status: "closed",
    });
  });

  it("clears reflowed footer rows when terminal columns change", async () => {
    const harness = createTtyHarness({
      columns: 80,
      enableReverseHistorySearch: false,
      enableTypeahead: false,
    });

    const prompt = harness.composer.compose({
      mode: "chat",
      promptText: "Name? ",
      footer: getIdleFooterText({
        showToolCalls: true,
        showThinking: false,
      }),
    });
    await flush();
    harness.takeOutput();

    (harness.outputStream as NodeJS.WriteStream).columns = 20;
    harness.outputStream.emit("resize");

    const narrowOutput = harness.takeOutput();
    expect(narrowOutput).toContain("\u001b[3A");
    const narrowText = stripAnsiControls(narrowOutput);
    expect(narrowText).toContain("Enter to send | ?");
    expect(narrowText).toContain("help | tools: shown");
    expect(narrowText).toContain("thinking:");
    expect(narrowText).toContain("hidden");
    expect(narrowText).toContain("Name? ");

    (harness.outputStream as NodeJS.WriteStream).columns = 80;
    harness.outputStream.emit("resize");

    const wideOutput = harness.takeOutput();
    expect(wideOutput).toContain("\u001b[3A");
    expect(stripAnsiControls(wideOutput)).toContain(
      "Enter to send | ? help | tools: shown | thinking: hidden\nName? ",
    );

    harness.composer.close();
    await expect(prompt).resolves.toEqual({
      status: "closed",
    });
  });

  it("surfaces prompt state snapshots through the render callback", async () => {
    const renderState = jest.fn();
    const harness = createNonTtyPromptHarness({ renderState });

    const prompt = harness.composer.compose({
      mode: "chat",
      promptText: "Name? ",
      footer: "Idle footer",
    });

    await flush();
    expect(renderState).toHaveBeenCalledWith(
      expect.objectContaining({
        buffer: "",
        cursor: 0,
        mode: "chat",
        footer: "Idle footer",
      }),
    );

    harness.inputStream.write("alice\n");
    await expect(prompt).resolves.toEqual({
    status: "submitted",
    inputMode: "prompt",
    text: "alice",
    });

    expect(renderState).toHaveBeenCalledWith(null);

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
    const { historyStore, cleanup, readlineHarness, composer } =
      createReadlinePromptComposer("propio-chat-");

    const prompt = composer.compose({
      mode: "chat",
      promptText: "Name? ",
    });

    readlineHarness.submit("hello");

    await expect(prompt).resolves.toEqual({
    status: "submitted",
    inputMode: "prompt",
    text: "hello",
    });
    await flush();
    expect(historyStore.load()).toEqual(["hello"]);

    composer.close();
    cleanup();
  });

  it("does not record blank input, confirm input, or control commands", async () => {
    const { historyStore, cleanup, readlineHarness, composer } =
      createReadlinePromptComposer("propio-history-");

    const blank = composer.compose({
      mode: "chat",
      promptText: "Name? ",
    });
    readlineHarness.submit("   ");
    await expect(blank).resolves.toEqual({
    status: "submitted",
    inputMode: "prompt",
    text: "   ",
    });

    const clear = composer.compose({
      mode: "chat",
      promptText: "Name? ",
    });
    readlineHarness.submit("/clear");
    await expect(clear).resolves.toEqual({
    status: "submitted",
    inputMode: "prompt",
    text: "/clear",
    });

    await expectReadlineConfirm(readlineHarness, composer);

    const exit = composer.compose({
      mode: "chat",
      promptText: "Name? ",
    });
    readlineHarness.submit("/exit");
    await expect(exit).resolves.toEqual({
    status: "submitted",
    inputMode: "prompt",
    text: "/exit",
    });

    const quit = composer.compose({
      mode: "chat",
      promptText: "Name? ",
    });
    readlineHarness.submit("/quit");
    await expect(quit).resolves.toEqual({
    status: "submitted",
    inputMode: "prompt",
    text: "/quit",
    });

    expect(historyStore.load()).toEqual([]);

    composer.close();
    cleanup();
  });

  it("records useful slash commands", async () => {
    const { historyStore, cleanup, readlineHarness, composer } =
      createReadlinePromptComposer("propio-slash-");

    const prompt = composer.compose({
      mode: "chat",
      promptText: "Name? ",
    });
    readlineHarness.submit("/context");

    await expect(prompt).resolves.toEqual({
    status: "submitted",
    inputMode: "prompt",
    text: "/context",
    });
    await flush();
    expect(historyStore.load()).toEqual(["/context"]);
    expect(readlineHarness.getHistory()).toEqual(["/context"]);

    composer.close();
    cleanup();
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
    inputMode: "prompt",
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
    inputMode: "prompt",
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
    inputMode: "prompt",
    text: "/clear",
    });
    expect(readlineHarness.getHistory()).toEqual([]);

    await expectReadlineConfirm(readlineHarness, composer);
    expect(readlineHarness.getHistory()).toEqual([]);

    const exit = composer.compose({
      mode: "chat",
      promptText: "Name? ",
    });
    readlineHarness.submit("/exit");
    await expect(exit).resolves.toEqual({
    status: "submitted",
    inputMode: "prompt",
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

    await expectReadlineConfirm(readlineHarness, composer);
    expect(readlineHarness.getHistory()).toEqual(["y"]);

    composer.close();
  });
});

describe("createPromptComposer reverse history search", () => {
  it("starts reverse search only for chat prompts and records recalled submissions", async () => {
    const { harness, prompt, historyStore, cleanup } =
      await startHistoryChatPrompt({
        prefix: "propio-search-",
        entries: ["older", "newer"],
      });

    triggerReverseHistorySearch(harness);
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

    triggerReverseHistorySearch(harness);
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
    inputMode: "prompt",
    text: "older",
    });
    await flush();
    expect(historyStore.load()).toEqual(["older", "newer"]);
    expect(harness.getOutput()).toContain("\n");

    harness.composer.close();
    cleanup();
  });

  it("handles raw bytes without readline echo during reverse search", async () => {
    const { harness, prompt, cleanup } = await startHistoryChatPrompt({
      prefix: "propio-bytes-",
      entries: ["hello world"],
    });

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
    inputMode: "prompt",
    text: "hello world!",
    });

    harness.composer.close();
    cleanup();
  });

  it("ignores reverse search for confirm prompts", async () => {
    const harness = createTtyHarness();

    const prompt = harness.composer.confirm({
      promptText: "Continue? ",
      defaultValue: false,
    });
    await flush();

    triggerReverseHistorySearch(harness);
    expect(harness.composer.getState()).toMatchObject({
      mode: "confirm",
      historySearch: undefined,
    });

    harness.readlineHarness.submit("y");
    await expect(prompt).resolves.toBe(true);

    harness.composer.close();
  });

  it("cancels reverse search and restores the draft", async () => {
    const { harness, prompt, cleanup } = await startHistoryChatPrompt({
      prefix: "propio-cancel-",
      entries: ["first"],
    });

    harness.typeText("draft");
    triggerReverseHistorySearch(harness);
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
    await submitDraftAfterSearchCancel(harness, prompt, { cleanup });
  });

  it("shows a no-match status without discarding the draft", async () => {
    const { harness, prompt } = await startChatPrompt();

    harness.typeText("draft");
    triggerReverseHistorySearch(harness);
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
    await submitPromptText(harness, prompt, "draft");

    harness.composer.close();
  });

  it("renders only the first line of multiline history matches", async () => {
    const { harness, prompt, cleanup } = await startHistoryChatPrompt({
      prefix: "propio-multiline-",
      entries: ["first line\nsecond line"],
      clearOutput: true,
    });

    triggerReverseHistorySearch(harness);

    expect(harness.composer.getState()).toMatchObject({
      buffer: "first line\nsecond line",
      historySearch: {
        active: true,
        match: "first line\nsecond line",
      },
    });
    expect(stripAnsiControls(harness.getOutput())).toContain(
      "history search:   match: first line",
    );
    expect(stripAnsiControls(harness.getOutput())).not.toContain("second line");

    harness.emitKeypress({ name: "return" }, "\r");
    harness.emitKeypress({ name: "return" }, "\r");
    await expect(prompt).resolves.toEqual({
    status: "submitted",
    inputMode: "prompt",
    text: "first line\nsecond line",
    });

    await closeHistoryPromptHarness(harness, cleanup);
  });

  it("clips long history search previews to one terminal row", async () => {
    const { harness, prompt, cleanup } = await startHistoryChatPrompt({
      prefix: "propio-long-",
      entries: ["abcdefghijklmnopqrstuvwxyz0123456789"],
      columns: 32,
      clearOutput: true,
    });

    triggerReverseHistorySearch(harness);

    const rendered = stripAnsiControls(harness.takeOutput()).replace(/\r/g, "");
    expect(rendered).toContain("...");
    expect(rendered).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(rendered.length).toBeLessThanOrEqual(31);

    await closeHistoryPromptHarness(harness, cleanup);
    await expect(prompt).resolves.toEqual({
      status: "closed",
    });
  });

  it("cancels reverse search with Ctrl+G", async () => {
    const { harness, prompt, cleanup } = await startHistoryChatPrompt({
      prefix: "propio-ctrlg-",
      entries: ["first"],
    });

    harness.typeText("draft");
    triggerReverseHistorySearch(harness);
    harness.typeText("fi");
    harness.emitKeypress({ name: "g", ctrl: true }, "\u0007");

    await submitDraftAfterSearchCancel(harness, prompt, { cleanup });
  });

  it("lets recalled search text be edited before submission", async () => {
    const { harness, prompt, cleanup } = await startHistoryChatPrompt({
      prefix: "propio-edit-",
      entries: ["hello world"],
    });

    triggerReverseHistorySearch(harness);
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
    inputMode: "prompt",
    text: "hello world!",
    });

    await closeHistoryPromptHarness(harness, cleanup);
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
    const { harness, prompt, cleanup } = await startHistoryChatPrompt({
      prefix: "propio-nav-",
      entries: ["newest", "older"],
    });

    harness.typeText("draft");
    harness.emitKeypress({ name: "up" });
    expect(harness.composer.getState()).toMatchObject({
      buffer: "older",
    });

    harness.emitKeypress({ name: "down" });
    expect(harness.composer.getState()).toMatchObject({
      buffer: "draft",
    });

    await submitPromptText(harness, prompt, "draft");
    await closeHistoryPromptHarness(harness, cleanup);
  });

  it("exposes active search summary without leaking mutable arrays", async () => {
    const { harness, prompt, cleanup } = await startHistoryChatPrompt({
      prefix: "propio-state-",
      entries: ["match"],
    });

    triggerReverseHistorySearch(harness);
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
    inputMode: "prompt",
    text: "match",
    });

    harness.composer.close();
    cleanup();
  });
});

describe("createPromptComposer multiline chat editing", () => {
  it("inserts newlines with Ctrl+J, then submits the full buffer", async () => {
    const { harness, prompt } = await startMultilineChatPrompt();

    harness.typeText("hello");
    harness.emitKeypress({ name: "j", ctrl: true }, "\n");
    expect(harness.composer.getState()).toMatchObject({
      buffer: "hello\n",
      cursor: 6,
      multiline: true,
    });

    harness.typeText("world");
    harness.emitKeypress({ name: "j", ctrl: true }, "\n");
    expect(harness.composer.getState()).toMatchObject({
      buffer: "hello\nworld\n",
      cursor: 12,
      multiline: true,
    });

    harness.typeText("done");
    harness.emitKeypress({ name: "return" }, "\r");

    await expect(prompt).resolves.toEqual({
    status: "submitted",
    inputMode: "prompt",
    text: "hello\nworld\ndone",
    });

    harness.composer.close();
  });

  it("inserts a newline when Ctrl+J arrives as a control keypress", async () => {
    const { harness, prompt } = await startMultilineChatPrompt();

    await submitTwoLineMultilineDraft(harness, prompt, {
      firstLine: "hello",
      secondLine: "world",
      newline: "ctrl-j",
    });

    harness.composer.close();
  });

  it("inserts a newline when Ctrl+J arrives as a line-feed return keypress", async () => {
    const { harness, prompt } = await startMultilineChatPrompt();

    await submitTwoLineMultilineDraft(harness, prompt, {
      firstLine: "hello",
      secondLine: "world",
      newline: "lf",
    });

    harness.composer.close();
  });

  it("moves vertically within multiline text and falls back to history navigation at line edges", async () => {
    const harness = createTtyHarness({
      enableReverseHistorySearch: false,
      enableTypeahead: false,
      historyStore: {
        load: () => ["previous entry"],
        record: jest.fn(),
      },
    });

    const prompt = harness.composer.compose({
      mode: "chat",
      promptText: "Name? ",
    });
    await flush();
    harness.takeOutput();

    harness.typeText("first");
    harness.emitKeypress({ name: "j", ctrl: true }, "\n");
    harness.typeText("second");

    harness.emitKeypress({ name: "home" });
    expect(harness.composer.getState()).toMatchObject({
      buffer: "first\nsecond",
      cursor: 6,
      multiline: true,
    });

    harness.emitKeypress({ name: "up" });
    expect(harness.composer.getState()).toMatchObject({
      buffer: "first\nsecond",
      cursor: 0,
      multiline: true,
    });

    harness.emitKeypress({ name: "end" });
    expect(harness.composer.getState()).toMatchObject({
      buffer: "first\nsecond",
      cursor: 5,
      multiline: true,
    });

    harness.emitKeypress({ name: "up" });
    expect(harness.composer.getState()).toMatchObject({
      buffer: "previous entry",
      cursor: 14,
      multiline: false,
    });

    harness.emitKeypress({ name: "down" });
    expect(harness.composer.getState()).toMatchObject({
      buffer: "first\nsecond",
      cursor: 5,
      multiline: true,
    });

    harness.emitKeypress({ name: "return" }, "\r");

    await expect(prompt).resolves.toEqual({
    status: "submitted",
    inputMode: "prompt",
    text: "first\nsecond",
    });

    harness.composer.close();
  });

  it("clears stale lines when a newline is deleted from a multiline draft", async () => {
    const harness = createTtyHarness({
      enableReverseHistorySearch: false,
      enableTypeahead: false,
      columns: 24,
    });

    const prompt = harness.composer.compose({
      mode: "chat",
      promptText: "Name? ",
    });
    await flush();
    harness.takeOutput();

    harness.typeText("alpha");
    harness.emitKeypress({ name: "j", ctrl: true }, "\n");
    harness.typeText("beta");
    harness.takeOutput();

    harness.emitKeypress({ name: "home" });
    harness.emitKeypress({ name: "backspace" });

    const output = harness.takeOutput();
    expect(output).toMatch(/\u001b\[(?:0)?J/);
    expect(output).toContain("alphabeta");
    expect(output).not.toContain("alpha\nbeta");
    expect(harness.composer.getState()).toMatchObject({
      buffer: "alphabeta",
      cursor: 5,
      multiline: false,
    });

    harness.composer.close();
    await expect(prompt).resolves.toEqual({
      status: "closed",
    });
  });

  it("restores raw mode after editor handoff and waits for Enter before submitting", async () => {
    const rawMode = jest.fn();
    const harness = createTtyHarness({
      enableReverseHistorySearch: false,
      enableTypeahead: false,
      editorEnv: {
        VISUAL: "mock-editor",
      },
      setRawModeMock: rawMode,
      editorRunner: ({ filePath }) => {
        fs.writeFileSync(filePath, "edited text", "utf8");
        return { status: 0, signal: null };
      },
    });

    const prompt = harness.composer.compose({
      mode: "chat",
      promptText: "Name? ",
    });
    await flush();
    harness.takeOutput();

    harness.typeText("first line");
    harness.emitKeypress({ name: "j", ctrl: true }, "\n");
    harness.typeText("second");
    harness.takeOutput();

    harness.emitKeypress({ name: "x", ctrl: true }, "\u0018");
    harness.emitKeypress({ name: "e", ctrl: true }, "\u0005");

    expect(rawMode.mock.calls).toEqual([[true], [false], [true]]);
    expect(harness.composer.getState()).toMatchObject({
      buffer: "edited text",
      cursor: 11,
      multiline: false,
      editorStatus: undefined,
    });

    const editorOutput = harness.takeOutput();
    expect(editorOutput).toMatch(/\u001b\[(?:0)?J/);
    expect(editorOutput).toContain("edited text");

    harness.emitKeypress({ name: "return" }, "\r");

    await expect(prompt).resolves.toEqual({
    status: "submitted",
    inputMode: "prompt",
    text: "edited text",
    });

    harness.composer.close();
  });

  it("preserves the draft and shows an editor status when no editor is configured", async () => {
    const harness = createTtyHarness({
      enableReverseHistorySearch: false,
      enableTypeahead: false,
      editorEnv: {},
    });

    const prompt = harness.composer.compose({
      mode: "chat",
      promptText: "Name? ",
    });
    await flush();
    harness.takeOutput();

    harness.typeText("draft");
    harness.emitKeypress({ name: "x", ctrl: true }, "\u0018");
    harness.emitKeypress({ name: "e", ctrl: true }, "\u0005");

    expect(harness.composer.getState()).toMatchObject({
      buffer: "draft",
      cursor: 5,
      multiline: false,
      editorStatus: "Editor unavailable. Set VISUAL or EDITOR.",
    });

    const statusOutput = harness.takeOutput();
    expect(statusOutput).toContain("Editor unavailable. Set VISUAL or EDITOR.");

    harness.emitKeypress({ name: "return" }, "\r");

    await expect(prompt).resolves.toEqual({
    status: "submitted",
    inputMode: "prompt",
    text: "draft",
    });

    harness.composer.close();
  });
});

describe("createPromptComposer word-wise editing", () => {
  it("moves across words with Ctrl/Alt navigation keys", async () => {
    const { harness, prompt } = await startDisabledSearchChatPrompt();

    harness.typeText("alpha beta gamma");

    harness.emitKeypress({ name: "left", ctrl: true });
    expect(harness.composer.getState()).toMatchObject({
      buffer: "alpha beta gamma",
      cursor: 11,
    });

    harness.emitKeypress({ name: "left", meta: true });
    expect(harness.composer.getState()).toMatchObject({
      buffer: "alpha beta gamma",
      cursor: 6,
    });

    harness.emitKeypress({ name: "right", ctrl: true });
    expect(harness.composer.getState()).toMatchObject({
      buffer: "alpha beta gamma",
      cursor: 10,
    });

    harness.emitKeypress({ name: "f", meta: true }, "\u001bf");
    expect(harness.composer.getState()).toMatchObject({
      buffer: "alpha beta gamma",
      cursor: 16,
    });

    harness.composer.close();
    await expect(prompt).resolves.toEqual({ status: "closed" });
  });

  it("deletes the previous word with Alt+Backspace", async () => {
    const { harness, prompt } = await startDisabledSearchChatPrompt();

    harness.typeText("alpha beta gamma");
    harness.emitKeypress({ name: "backspace", meta: true });
    expect(harness.composer.getState()).toMatchObject({
      buffer: "alpha beta ",
      cursor: 11,
    });

    harness.emitKeypress({ name: "backspace", meta: true });
    expect(harness.composer.getState()).toMatchObject({
      buffer: "alpha ",
      cursor: 6,
    });

    harness.emitKeypress({ name: "return" }, "\r");
    await expect(prompt).resolves.toEqual({
    status: "submitted",
    inputMode: "prompt",
    text: "alpha ",
    });

    harness.composer.close();
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
    inputMode: "prompt",
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
    inputMode: "prompt",
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
    inputMode: "prompt",
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
    inputMode: "prompt",
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
    inputMode: "prompt",
    text: "/con",
    });

    harness.composer.close();
  });

  it("clears typeahead before reverse search and restores the draft on cancel", async () => {
    const { harness, prompt, cleanup } = await startHistoryChatPrompt({
      prefix: "propio-search-",
      entries: ["older"],
    });

    harness.typeText("/con");
    harness.emitKeypress({ name: "tab" }, "\t");
    triggerReverseHistorySearch(harness);

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

    await submitPromptText(harness, prompt, "/con");

    harness.composer.close();
    cleanup();
  });

  it("cancels a typeahead when the draft is edited", async () => {
    const { harness, prompt } = await startDisabledSearchChatPrompt();

    harness.typeText("/con");
    harness.emitKeypress({ name: "tab" }, "\t");
    harness.typeText("!");

    expect(harness.composer.getState()).toMatchObject({
      buffer: "/con!",
      typeahead: undefined,
    });

    await submitPromptText(harness, prompt, "/con!");

    harness.composer.close();
  });

  it("returns bash input mode and honors explicit bash mode on later compose calls", async () => {
    const harness = createTtyHarness({
      enableReverseHistorySearch: false,
      enableTypeahead: false,
    });

    const first = harness.composer.compose({
      mode: "chat",
      promptText: "> ",
      bashPromptText: "! ",
      footer: getIdleFooterText(),
    });
    await flush();

    harness.typeText("!");
    harness.typeText("pwd");
    harness.emitKeypress({ name: "return" }, "\r");
    await expect(first).resolves.toEqual({
      status: "submitted",
      text: "pwd",
      inputMode: "bash",
    });

    const second = harness.composer.compose({
      mode: "chat",
      inputMode: "bash",
      promptText: "> ",
      bashPromptText: "! ",
      footer: getBashFooterText(),
    });
    await flush();
    expect(harness.composer.getState()).toMatchObject({
      inputMode: "bash",
    });

    harness.typeText("ls");
    harness.emitKeypress({ name: "return" }, "\r");
    await expect(second).resolves.toEqual({
      status: "submitted",
      text: "ls",
      inputMode: "bash",
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
