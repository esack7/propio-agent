import { StatusRenderer, type SpinnerFactory } from "../statusRenderer.js";
import { createMockSpinner, createMockStream } from "./testUtils.js";

function createRenderer(
  stream: NodeJS.WriteStream,
  createSpinner: SpinnerFactory,
  fallbackInfo: (text: string) => void = jest.fn(),
): StatusRenderer {
  return new StatusRenderer({
    stream,
    style: (text) => text,
    interactive: true,
    plain: false,
    json: false,
    fallbackInfo,
    createSpinner,
  });
}

describe("StatusRenderer", () => {
  it("creates and updates a spinner for active status output", () => {
    const stream = createMockStream();
    const { spinner, createSpinner } = createMockSpinner();
    const renderer = createRenderer(stream, createSpinner);

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
    const { spinner, createSpinner } = createMockSpinner();
    const renderer = createRenderer(stream, createSpinner);

    renderer.progress(2, 4, "Downloading");
    renderer.succeed("Done");

    expect(createSpinner.mock.calls[0][0]).toBe("Downloading (2/4, 50%)");
    expect(spinner.succeed).toHaveBeenCalledWith("Done");
    expect(spinner.stop).not.toHaveBeenCalled();
  });

  it("fails an active spinner without duplicating the failure symbol", () => {
    const stream = createMockStream();
    const { spinner, createSpinner } = createMockSpinner();
    const renderer = createRenderer(stream, createSpinner);

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
    const renderer = createRenderer(stream, createSpinner, fallbackInfo);

    renderer.progress(1, 2, "Downloading");

    expect(fallbackInfo).toHaveBeenCalledWith("Downloading (1/2, 50%)");
    expect(createSpinner).not.toHaveBeenCalled();
  });
});
