import { PassThrough } from "stream";
import { createPromptComposer } from "../promptComposer.js";

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

describe("createPromptComposer", () => {
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
});
