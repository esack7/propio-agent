import { cleanPasteText, createPasteHandler } from "../pasteHandler.js";

describe("cleanPasteText", () => {
  it("strips ANSI sequences", () => {
    expect(cleanPasteText("\x1B[31mred\x1B[0m")).toBe("red");
  });

  it("normalizes CRLF without doubling newlines", () => {
    expect(cleanPasteText("a\r\nb")).toBe("a\nb");
    expect(cleanPasteText("a\r\nb")).not.toBe("a\n\nb");
  });

  it("normalizes lone carriage returns", () => {
    expect(cleanPasteText("a\rb")).toBe("a\nb");
  });

  it("replaces tabs with spaces", () => {
    expect(cleanPasteText("a\tb")).toBe("a b");
  });
});

describe("createPasteHandler", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("ignores empty submitPaste without onEmptyPaste", () => {
    const onTextPaste = jest.fn();
    const handler = createPasteHandler({
      getInputMode: () => "prompt",
      onTextPaste,
      debounceMs: 100,
    });

    handler.submitPaste("", { isPasted: true });
    expect(handler.isPasting()).toBe(false);

    jest.advanceTimersByTime(200);
    expect(onTextPaste).not.toHaveBeenCalled();
    handler.dispose();
  });

  it("invokes onEmptyPaste for empty bracketed paste", async () => {
    const onEmptyPaste = jest.fn(async () => {});
    const handler = createPasteHandler({
      getInputMode: () => "prompt",
      onTextPaste: jest.fn(),
      onEmptyPaste,
    });

    handler.submitPaste("", { isPasted: true });
    expect(handler.isPasting()).toBe(true);

    await Promise.resolve();
    await Promise.resolve();

    expect(onEmptyPaste).toHaveBeenCalledTimes(1);
    expect(handler.isPasting()).toBe(false);
    handler.dispose();
  });

  it("ignores empty paste when isPasted is false", () => {
    const onEmptyPaste = jest.fn();
    const handler = createPasteHandler({
      getInputMode: () => "prompt",
      onTextPaste: jest.fn(),
      onEmptyPaste,
    });

    handler.submitPaste("", { isPasted: false });
    expect(handler.isPasting()).toBe(false);
    expect(onEmptyPaste).not.toHaveBeenCalled();
    handler.dispose();
  });

  it("does not invoke onEmptyPaste after dispose", async () => {
    let resolveEmptyPaste: (() => void) | undefined;
    const onEmptyPaste = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveEmptyPaste = resolve;
        }),
    );
    const handler = createPasteHandler({
      getInputMode: () => "prompt",
      onTextPaste: jest.fn(),
      onEmptyPaste,
    });

    handler.submitPaste("", { isPasted: true });
    await Promise.resolve();
    handler.dispose();
    resolveEmptyPaste?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(onEmptyPaste).toHaveBeenCalledTimes(1);
    handler.dispose();
  });

  it("merges debounced submitPaste calls", () => {
    const onTextPaste = jest.fn();
    const handler = createPasteHandler({
      getInputMode: () => "prompt",
      onTextPaste,
      debounceMs: 100,
    });

    handler.submitPaste("hello", { isPasted: true });
    handler.submitPaste(" world", { isPasted: true });
    expect(handler.isPasting()).toBe(true);

    jest.advanceTimersByTime(101);
    expect(onTextPaste).toHaveBeenCalledWith("hello world");
    expect(handler.isPasting()).toBe(false);
    handler.dispose();
  });

  it("does not invoke callbacks after dispose", () => {
    const onTextPaste = jest.fn();
    const handler = createPasteHandler({
      getInputMode: () => "prompt",
      onTextPaste,
      debounceMs: 100,
    });

    handler.submitPaste("late", { isPasted: true });
    handler.dispose();
    jest.advanceTimersByTime(200);
    expect(onTextPaste).not.toHaveBeenCalled();
  });

  it("routes path-only image drops to onImagePaths in prompt mode", () => {
    const onTextPaste = jest.fn();
    const onImagePaths = jest.fn();
    const handler = createPasteHandler({
      getInputMode: () => "prompt",
      onTextPaste,
      onImagePaths,
      debounceMs: 0,
    });

    handler.submitPaste("/tmp/a.png\n/tmp/b.jpg", { isPasted: true });
    jest.advanceTimersByTime(1);

    expect(onImagePaths).toHaveBeenCalledWith(["/tmp/a.png", "/tmp/b.jpg"]);
    expect(onTextPaste).not.toHaveBeenCalled();
    handler.dispose();
  });

  it("uses onTextPaste only in bash mode for image paths", () => {
    const onTextPaste = jest.fn();
    const onImagePaths = jest.fn();
    const handler = createPasteHandler({
      getInputMode: () => "bash",
      onTextPaste,
      onImagePaths,
      debounceMs: 0,
    });

    handler.submitPaste("/tmp/a.png", { isPasted: true });
    jest.advanceTimersByTime(1);

    expect(onTextPaste).toHaveBeenCalledWith("/tmp/a.png");
    expect(onImagePaths).not.toHaveBeenCalled();
    handler.dispose();
  });

  it("keeps mixed image path and prose on onTextPaste", () => {
    const onTextPaste = jest.fn();
    const onImagePaths = jest.fn();
    const handler = createPasteHandler({
      getInputMode: () => "prompt",
      onTextPaste,
      onImagePaths,
      debounceMs: 0,
    });

    handler.submitPaste("/tmp/a.png\nnotes", { isPasted: true });
    jest.advanceTimersByTime(1);

    expect(onTextPaste).toHaveBeenCalledWith("/tmp/a.png\nnotes");
    expect(onImagePaths).not.toHaveBeenCalled();
    handler.dispose();
  });

  it("buffers multi-char printable segments atomically", () => {
    const onTextPaste = jest.fn();
    const handler = createPasteHandler({
      getInputMode: () => "prompt",
      onTextPaste,
      burstCharIntervalMs: 20,
    });

    expect(handler.onPrintableText("ab")).toBe("buffered");
    expect(onTextPaste).not.toHaveBeenCalled();

    jest.advanceTimersByTime(21);
    expect(onTextPaste).toHaveBeenCalledWith("ab");
    handler.dispose();
  });

  it("flushes multi-char burst segments as paste on idle", () => {
    const onTextPaste = jest.fn();
    const handler = createPasteHandler({
      getInputMode: () => "prompt",
      onTextPaste,
      burstCharIntervalMs: 20,
    });

    expect(handler.onPrintableText("ab")).toBe("buffered");
    expect(handler.onPrintableText("c")).toBe("buffered");

    jest.advanceTimersByTime(21);
    expect(onTextPaste).toHaveBeenCalledWith("abc");
    handler.dispose();
  });

  it("buffers rapid single-character input when inter-key gap is within the burst window", () => {
    const onTextPaste = jest.fn();
    const handler = createPasteHandler({
      getInputMode: () => "prompt",
      onTextPaste,
      burstCharIntervalMs: 20,
    });

    expect(handler.onPrintableText("a")).toBe("typed");
    jest.advanceTimersByTime(5);
    expect(handler.onPrintableText("b")).toBe("buffered");
    jest.advanceTimersByTime(5);
    expect(handler.onPrintableText("c")).toBe("buffered");
    expect(handler.isPasting()).toBe(true);

    jest.advanceTimersByTime(21);
    expect(onTextPaste).toHaveBeenCalledWith("bc");
    handler.dispose();
  });

  it("buffers same-tick single-character input after the first key", () => {
    const onTextPaste = jest.fn();
    const handler = createPasteHandler({
      getInputMode: () => "prompt",
      onTextPaste,
      burstCharIntervalMs: 20,
    });

    expect(handler.onPrintableText("a")).toBe("typed");
    expect(handler.onPrintableText("b")).toBe("buffered");
    expect(handler.isPasting()).toBe(true);

    handler.flushBeforeNonChar();
    expect(onTextPaste).toHaveBeenCalledWith("b");
    handler.dispose();
  });

  it("keeps isPasting true until async onImagePaths resolves", async () => {
    const onTextPaste = jest.fn();
    let resolveImagePaths: (() => void) | undefined;
    const onImagePaths = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveImagePaths = resolve;
        }),
    );
    const handler = createPasteHandler({
      getInputMode: () => "prompt",
      onTextPaste,
      onImagePaths,
      debounceMs: 0,
    });

    handler.submitPaste("/tmp/a.png", { isPasted: true });
    jest.advanceTimersByTime(1);
    await Promise.resolve();

    expect(handler.isPasting()).toBe(true);
    expect(onImagePaths).toHaveBeenCalled();

    resolveImagePaths?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(handler.isPasting()).toBe(false);
    handler.dispose();
  });

  it("falls back to onTextPaste when onImagePaths rejects", async () => {
    const onTextPaste = jest.fn();
    const onImagePaths = jest.fn(() =>
      Promise.reject(new Error("read failed")),
    );
    const handler = createPasteHandler({
      getInputMode: () => "prompt",
      onTextPaste,
      onImagePaths,
      debounceMs: 0,
    });

    handler.submitPaste("/tmp/a.png", { isPasted: true });
    jest.advanceTimersByTime(1);
    await Promise.resolve();
    await Promise.resolve();

    expect(onTextPaste).toHaveBeenCalledWith("/tmp/a.png");
    expect(handler.isPasting()).toBe(false);
    handler.dispose();
  });

  it("does not fall back to onTextPaste after dispose when onImagePaths rejects", async () => {
    const onTextPaste = jest.fn();
    let rejectImagePaths: ((error: Error) => void) | undefined;
    const onImagePaths = jest.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectImagePaths = reject;
        }),
    );
    const handler = createPasteHandler({
      getInputMode: () => "prompt",
      onTextPaste,
      onImagePaths,
      debounceMs: 0,
    });

    handler.submitPaste("/tmp/a.png", { isPasted: true });
    jest.advanceTimersByTime(1);
    await Promise.resolve();
    handler.dispose();
    rejectImagePaths!(new Error("read failed"));
    await Promise.resolve();
    await Promise.resolve();

    expect(onTextPaste).not.toHaveBeenCalled();
    handler.dispose();
  });

  it("does not invoke callbacks after dispose invalidates delivery", async () => {
    const onTextPaste = jest.fn();
    let resolveImagePaths: (() => void) | undefined;
    const onImagePaths = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveImagePaths = resolve;
        }),
    );
    const handler = createPasteHandler({
      getInputMode: () => "prompt",
      onTextPaste,
      onImagePaths,
      debounceMs: 0,
    });

    handler.submitPaste("/tmp/a.png", { isPasted: true });
    jest.advanceTimersByTime(1);
    await Promise.resolve();
    handler.dispose();
    resolveImagePaths?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(onTextPaste).not.toHaveBeenCalled();
    expect(onImagePaths).toHaveBeenCalled();
  });

  it("flushBeforeNonChar delivers buffered burst before navigation", () => {
    const onTextPaste = jest.fn();
    const handler = createPasteHandler({
      getInputMode: () => "prompt",
      onTextPaste,
      burstCharIntervalMs: 20,
    });

    handler.onPrintableText("ab");
    handler.flushBeforeNonChar();

    expect(onTextPaste).toHaveBeenCalledWith("ab");
    expect(handler.isPasting()).toBe(false);
    handler.dispose();
  });
});
