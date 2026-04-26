import { StatusRenderer } from "../statusRenderer.js";

function createMockStream(
  isTTY = true,
): NodeJS.WriteStream & { chunks: string[] } {
  const chunks: string[] = [];

  return {
    chunks,
    columns: 80,
    isTTY,
    write: (chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf-8"));
      return true;
    },
  } as unknown as NodeJS.WriteStream & { chunks: string[] };
}

describe("StatusRenderer", () => {
  it("creates and updates a spinner for active status output", () => {
    const stream = createMockStream();
    const spinner = {
      start: jest.fn(),
      setPhase: jest.fn(),
      setText: jest.fn(),
      succeed: jest.fn(),
      fail: jest.fn(),
      stop: jest.fn(),
    };
    const createSpinner = jest.fn(() => spinner);
    const renderer = new StatusRenderer({
      stream,
      style: (text) => text,
      interactive: true,
      plain: false,
      json: false,
      fallbackInfo: jest.fn(),
      createSpinner,
    });

    renderer.status("Working", "tool call");
    renderer.status("Still working");

    expect(createSpinner).toHaveBeenCalledTimes(1);
    expect(createSpinner.mock.calls[0][0]).toBe("Working");
    expect(createSpinner.mock.calls[0][1]).toEqual({
      enabled: true,
      stream,
      phase: "tool call",
    });
    expect(spinner.start).toHaveBeenCalledTimes(1);
    expect(spinner.setPhase).toHaveBeenCalledWith(null);
    expect(spinner.setText).toHaveBeenCalledWith("Still working");
  });

  it("formats progress and clears active spinners on completion", () => {
    const stream = createMockStream();
    const spinner = {
      start: jest.fn(),
      setPhase: jest.fn(),
      setText: jest.fn(),
      succeed: jest.fn(),
      fail: jest.fn(),
      stop: jest.fn(),
    };
    const createSpinner = jest.fn(() => spinner);
    const renderer = new StatusRenderer({
      stream,
      style: (text) => text,
      interactive: true,
      plain: false,
      json: false,
      fallbackInfo: jest.fn(),
      createSpinner,
    });

    renderer.progress(2, 4, "Downloading");
    renderer.succeed("Done");

    expect(createSpinner.mock.calls[0][0]).toBe("Downloading (2/4, 50%)");
    expect(spinner.succeed).toHaveBeenCalledWith("Done");
    expect(spinner.stop).not.toHaveBeenCalled();
  });

  it("fails an active spinner without duplicating the failure symbol", () => {
    const stream = createMockStream();
    const spinner = {
      start: jest.fn(),
      setPhase: jest.fn(),
      setText: jest.fn(),
      succeed: jest.fn(),
      fail: jest.fn(),
      stop: jest.fn(),
    };
    const createSpinner = jest.fn(() => spinner);
    const renderer = new StatusRenderer({
      stream,
      style: (text) => text,
      interactive: true,
      plain: false,
      json: false,
      fallbackInfo: jest.fn(),
      createSpinner,
    });

    renderer.status("Working");
    renderer.fail("Failed");

    expect(spinner.fail).toHaveBeenCalledTimes(1);
    expect(spinner.fail.mock.calls[0][0]).toBe("Failed");
    expect(spinner.fail.mock.calls[0][0]).not.toContain("✖");
  });

  it("falls back to info output when spinner mode is unavailable", () => {
    const stream = createMockStream(false);
    const fallbackInfo = jest.fn();
    const createSpinner = jest.fn();
    const renderer = new StatusRenderer({
      stream,
      style: (text) => text,
      interactive: true,
      plain: false,
      json: false,
      fallbackInfo,
      createSpinner,
    });

    renderer.progress(1, 2, "Downloading");

    expect(fallbackInfo).toHaveBeenCalledWith("Downloading (1/2, 50%)");
    expect(createSpinner).not.toHaveBeenCalled();
  });
});
