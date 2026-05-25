import { submittedPromptResult } from "./promptComposerTestHelpers.js";
import * as readline from "readline";
import { createInteractiveInput } from "../interactiveInput.js";
import { createPromptComposer } from "../promptComposer.js";
import {
  createCapturingPassThroughStreams,
  createFakeReadlineHarness,
  flush,
} from "./promptComposerTestHelpers.js";

function createHarness() {
  const { inputStream, outputStream, getOutput } =
    createCapturingPassThroughStreams();
  const composer = createPromptComposer({
    input: inputStream as unknown as NodeJS.ReadStream,
    output: outputStream as unknown as NodeJS.WriteStream,
  });

  return {
    composer,
    inputStream,
    outputStream,
    getOutput,
  };
}

function createCountingHarness() {
  let createInterfaceCalls = 0;
  const harness = createHarnessWithFactory((options) => {
    createInterfaceCalls += 1;
    return readline.createInterface(options);
  });

  return {
    ...harness,
    getCreateInterfaceCalls: () => createInterfaceCalls,
  };
}

function createHarnessWithFactory(
  createInterface: typeof readline.createInterface,
) {
  const { inputStream, outputStream, getOutput } =
    createCapturingPassThroughStreams();

  const composer = createPromptComposer({
    input: inputStream as unknown as NodeJS.ReadStream,
    output: outputStream as unknown as NodeJS.WriteStream,
    createInterface,
  });

  return {
    composer,
    inputStream,
    outputStream,
    getOutput: () => output,
  };
}

describe("createPromptComposer", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("compose resolves submitted text", async () => {
    const harness = createHarness();

    const prompt = harness.composer.compose({
      mode: "chat",
      promptText: "Name? ",
    });
    await flush();
    harness.inputStream.write("alice\n");

    await expect(prompt).resolves.toEqual(
      submittedPromptResult("alice", "prompt"),
    );

    harness.composer.close();
  });

  it("compose resolves as closed when the composer is closed", async () => {
    const harness = createHarness();

    const prompt = harness.composer.compose({
      mode: "chat",
      promptText: "Name? ",
    });
    await flush();
    harness.composer.close();

    await expect(prompt).resolves.toEqual({ status: "closed" });
    expect(harness.composer.getCloseReason()).toBe("closed");
  });

  it("reuses the same underlying interface across sequential prompts", async () => {
    const harness = createCountingHarness();

    const first = harness.composer.compose({
      mode: "chat",
      promptText: "First? ",
    });
    await flush();
    harness.inputStream.write("one\n");
    await expect(first).resolves.toEqual(
      submittedPromptResult("one", "prompt"),
    );

    const second = harness.composer.compose({
      mode: "chat",
      promptText: "Second? ",
    });
    await flush();
    harness.inputStream.write("two\n");
    await expect(second).resolves.toEqual(
      submittedPromptResult("two", "prompt"),
    );

    expect(harness.getCreateInterfaceCalls()).toBe(1);
    harness.composer.close();
  });

  it("throws a clear error for concurrent prompts", async () => {
    const harness = createHarness();

    const first = harness.composer.compose({
      mode: "chat",
      promptText: "First? ",
    });
    await flush();

    await expect(
      harness.composer.compose({
        mode: "chat",
        promptText: "Second? ",
      }),
    ).rejects.toThrow("An interactive prompt is already active.");

    harness.inputStream.write("first\n");
    await expect(first).resolves.toEqual(
      submittedPromptResult("first", "prompt"),
    );

    harness.composer.close();
  });

  it.each([
    ["y", true],
    ["yes", true],
    ["n", false],
    ["no", false],
  ])("confirm accepts %s", async (answer, expected) => {
    const harness = createHarness();

    const prompt = harness.composer.confirm({
      promptText: "Continue? ",
      defaultValue: false,
    });
    await flush();
    harness.inputStream.write(`${answer}\n`);

    await expect(prompt).resolves.toBe(expected);

    harness.composer.close();
  });

  it("confirm applies default false on blank input", async () => {
    const harness = createHarness();

    const prompt = harness.composer.confirm({
      promptText: "Continue? ",
      defaultValue: false,
    });
    await flush();
    harness.inputStream.write("\n");

    await expect(prompt).resolves.toBe(false);

    harness.composer.close();
  });

  it("confirm applies default on closed prompt", async () => {
    const harness = createHarness();

    const prompt = harness.composer.confirm({
      promptText: "Continue? ",
      defaultValue: false,
    });
    await flush();
    harness.composer.close();

    await expect(prompt).resolves.toBe(false);
  });

  it("confirm reprompts after invalid input", async () => {
    const harness = createHarness();

    const prompt = harness.composer.confirm({
      promptText: "Continue? ",
      defaultValue: false,
    });
    await flush();
    harness.inputStream.write("maybe\n");
    await flush();
    harness.inputStream.write("y\n");

    await expect(prompt).resolves.toBe(true);
    expect(harness.getOutput()).toContain(
      "Invalid response. Please enter y or n.",
    );

    harness.composer.close();
  });

  it("preserves interrupted close reason when SIGINT is received", async () => {
    const readlineHarness = createFakeReadlineHarness();
    const killSpy = jest.spyOn(process, "kill").mockImplementation(() => true);

    const composer = createPromptComposer({
      createInterface: readlineHarness.createInterface,
    });
    const prompt = composer.compose({
      mode: "chat",
      promptText: "Name? ",
    });
    await flush();

    readlineHarness.emitSigint();
    expect(composer.getCloseReason()).toBe("interrupted");

    composer.close();
    await expect(prompt).resolves.toEqual({ status: "closed" });
    expect(composer.getCloseReason()).toBe("interrupted");

    killSpy.mockRestore();
  });
});

describe("createInteractiveInput", () => {
  it("delegates readLine, confirm, and close to the prompt composer", async () => {
    const compose = jest
      .fn()
      .mockResolvedValueOnce(submittedPromptResult("typed", "prompt"))
      .mockResolvedValueOnce({ status: "closed" });
    const confirm = jest.fn().mockResolvedValue(true);
    const getCloseReason = jest.fn().mockReturnValue("closed" as const);
    const close = jest.fn();
    const createComposer = jest.fn(() => ({
      compose,
      confirm,
      getCloseReason,
      close,
    }));

    const input = createInteractiveInput({
      createComposer,
    });

    await expect(input.readLine("Name? ")).resolves.toBe("typed");
    await expect(input.readLine("Name? ")).resolves.toBeNull();
    await expect(
      input.confirm("Continue? ", { defaultValue: true }),
    ).resolves.toBe(true);

    expect(createComposer).toHaveBeenCalledTimes(1);
    expect(compose).toHaveBeenNthCalledWith(1, {
      mode: "chat",
      promptText: "Name? ",
    });
    expect(confirm).toHaveBeenCalledWith({
      promptText: "Continue? ",
      defaultValue: true,
    });

    input.close();
    expect(close).toHaveBeenCalledTimes(1);
    expect(input.getCloseReason()).toBe("closed");
  });
});
