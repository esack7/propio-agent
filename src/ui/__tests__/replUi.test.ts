import { createPromptState } from "../promptState.js";
import { FooterRenderer } from "../footerRenderer.js";
import { ReplRenderer } from "../replRenderer.js";
import { ReplUiStore } from "../replUi.js";
import { StatusRenderer } from "../statusRenderer.js";
import { TerminalWriter } from "../terminalWriter.js";
import { TranscriptRenderer } from "../transcriptRenderer.js";
import { createTtyTestStream } from "./ttyTestStream.js";

function createHarness() {
  const stdout = createTtyTestStream();
  const stderr = createTtyTestStream();
  const writer = new TerminalWriter({ stdout, stderr });
  const clearStderrLinesSpy = jest.spyOn(writer, "clearStderrLines");
  const spinner = {
    start: jest.fn(),
    setPhase: jest.fn(),
    setText: jest.fn(),
    succeed: jest.fn(),
    fail: jest.fn(),
    stop: jest.fn(),
  };
  const createSpinner = jest.fn(() => spinner);
  let statusRenderer: StatusRenderer;
  statusRenderer = new StatusRenderer({
    stream: stderr,
    style: (text) => text,
    interactive: true,
    plain: false,
    json: false,
    fallbackInfo: jest.fn(),
    createSpinner,
  });
  const transcriptRenderer = new TranscriptRenderer({
    writer,
    style: (text) => text,
    clearStatus: () => statusRenderer.clear(),
    interactive: true,
    json: false,
  });
  const footerRenderer = new FooterRenderer({
    writer,
    style: (text) => text,
    clearStatus: () => statusRenderer.clear(),
    interactive: true,
    json: false,
  });
  const renderer = new ReplRenderer({
    writer,
    transcriptRenderer,
    statusRenderer,
    footerRenderer,
  });

  return {
    renderer,
    spinner,
    stderr,
    clearStderrLinesSpy,
    createSpinner,
    store: new ReplUiStore(),
  };
}

describe("ReplUiStore", () => {
  it("tracks transcript, prompt, status, footer, mode, and overlay state", () => {
    const store = new ReplUiStore();
    const prompt = createPromptState({
      mode: "chat",
      promptText: "Name? ",
      footer: "Idle footer",
    });

    store.setMode("running");
    store.setPrompt(prompt);
    store.setStatus({ kind: "status", text: "Working", phase: "tool call" });
    expect(store.getState().status).toMatchObject({
      kind: "status",
      text: "Working",
      phase: "tool call",
    });
    store.setActivity({ text: "Reading files", level: "info" });
    store.setFooter("Idle footer");
    store.appendTranscriptEntry({ kind: "info", text: "hello" });
    store.openOverlay({
      kind: "help",
      entries: [{ kind: "command", text: "/help" }],
    });

    expect(store.getState()).toMatchObject({
      mode: "running",
      prompt: expect.objectContaining({
        buffer: "",
        cursor: 0,
        mode: "chat",
        footer: "Idle footer",
      }),
      status: null,
      activity: null,
      footer: "Idle footer",
      transcript: [{ kind: "info", text: "hello" }],
      overlay: {
        kind: "help",
        entries: [{ kind: "command", text: "/help" }],
      },
    });

    store.clearEphemeralSurfaces();
    store.closeOverlay();

    expect(store.getState()).toMatchObject({
      status: null,
      overlay: null,
    });
  });
});

describe("ReplRenderer", () => {
  it("renders appended transcript entries, overlays, and status updates", () => {
    const { renderer, spinner, stderr, store, createSpinner } = createHarness();

    store.appendTranscriptEntry({ kind: "user_message", text: "hello" });
    renderer.flush(store.getState());
    expect(stderr.chunks.join("")).toContain("hello");

    store.appendTranscriptEntry({ kind: "info", text: "hello" });
    renderer.flush(store.getState());
    expect(stderr.chunks.join("")).toContain("hello");

    store.setStatus({ kind: "status", text: "Working", phase: "tool call" });
    renderer.flush(store.getState());
    expect(spinner.start).toHaveBeenCalledTimes(1);
    expect(createSpinner).toHaveBeenCalledWith("Working", {
      enabled: true,
      stream: stderr,
      phase: "tool call",
    });

    store.setActivity({ text: "Reading files", level: "info" });
    renderer.flush(store.getState());
    expect(stderr.chunks.join("")).toContain("Activity: Reading files");

    store.appendTranscriptEntry({
      kind: "reasoning_summary",
      summary: "thinking aloud",
      source: "agent",
    });
    renderer.flush(store.getState());
    expect(spinner.stop).toHaveBeenCalledTimes(1);
    expect(stderr.chunks.join("")).toContain("thinking aloud");

    store.openOverlay({
      kind: "tools",
      entries: [
        { kind: "section", text: "Tools" },
        { kind: "command", text: "  1. read" },
      ],
    });
    renderer.flush(store.getState());
    const output = stderr.chunks.join("");
    expect(output).toContain("Tools");
    expect(output).toContain("  1. read");

    store.setPrompt(
      createPromptState({
        mode: "chat",
        promptText: "Name? ",
        footer: "Idle footer",
      }),
    );
    store.setFooter("Idle footer");
    renderer.flush(store.getState());
    expect(stderr.chunks.join("")).toContain("Idle footer");
  });

  it("does not rerender equivalent ephemeral state objects", () => {
    const { renderer, spinner, store, clearStderrLinesSpy } = createHarness();

    store.setStatus({ kind: "status", text: "Working", phase: "tool call" });
    renderer.flush(store.getState());

    store.setStatus({ kind: "status", text: "Working", phase: "tool call" });
    renderer.flush(store.getState());

    store.setActivity({ text: "Reading files", level: "info" });
    renderer.flush(store.getState());

    store.setActivity({ text: "Reading files", level: "info" });
    renderer.flush(store.getState());

    expect(spinner.start).toHaveBeenCalledTimes(1);
    expect(clearStderrLinesSpy).not.toHaveBeenCalled();
  });

  it("does not redraw multiline chat prompt state in the retained renderer", () => {
    const { renderer, stderr, store } = createHarness();

    store.setPrompt(
      createPromptState({
        mode: "chat",
        promptText: "❯ ",
        defaultValue: "Hello\nMy name is",
      }),
    );
    renderer.flush(store.getState());

    expect(stderr.chunks.join("")).not.toContain("My name is");
  });

  it("clears the retained bottom zone before appending transcript output", () => {
    const { renderer, clearStderrLinesSpy, store } = createHarness();

    store.setPrompt(
      createPromptState({
        mode: "chat",
        promptText: "Name? ",
        footer: "Idle footer",
      }),
    );
    store.setFooter("Idle footer");
    renderer.flush(store.getState());

    store.appendTranscriptEntry({ kind: "info", text: "hello" });
    renderer.flush(store.getState());

    expect(clearStderrLinesSpy).toHaveBeenCalledWith(1);
  });

  it("clears overlays using the exact number of rendered lines", () => {
    const { renderer, clearStderrLinesSpy, store } = createHarness();

    store.openOverlay({
      kind: "tools",
      entries: [{ kind: "info", text: "\nTools:" }],
    });
    renderer.flush(store.getState());

    store.closeOverlay();
    renderer.flush(store.getState());

    expect(clearStderrLinesSpy).toHaveBeenCalledWith(2);
  });

  it("counts JSON overlay entries using their rendered stderr lines", () => {
    const { renderer, clearStderrLinesSpy, store, stderr } = createHarness();

    store.openOverlay({
      kind: "custom",
      entries: [{ kind: "json", value: { foo: "bar", nested: { baz: 1 } } }],
    });
    renderer.flush(store.getState());

    expect(stderr.chunks.join("")).toContain('"foo": "bar"');

    store.closeOverlay();
    renderer.flush(store.getState());

    expect(clearStderrLinesSpy).toHaveBeenCalledWith(6);
  });

  it("repaints retained bottom content using resized line estimates", () => {
    const { renderer, clearStderrLinesSpy, store, stderr } = createHarness();

    stderr.columns = 80;
    store.openOverlay({
      kind: "custom",
      entries: [
        {
          kind: "info",
          text: "alpha beta gamma delta epsilon",
        },
      ],
    });
    renderer.flush(store.getState());

    stderr.columns = 20;
    renderer.handleResize(store.getState());

    expect(clearStderrLinesSpy).toHaveBeenLastCalledWith(2);
    expect(stderr.chunks.join("")).toContain("alpha beta gamma");
    expect(stderr.chunks.join("")).toContain("delta epsilon");
  });
});
