import { PassThrough } from "stream";
import { createInteractiveInput } from "../interactiveInput.js";

function createHarness() {
  const inputStream = new PassThrough();
  const outputStream = new PassThrough();
  outputStream.setEncoding("utf8");
  let output = "";
  outputStream.on("data", (chunk) => {
    output += chunk;
  });

  const input = createInteractiveInput({
    input: inputStream as unknown as NodeJS.ReadStream,
    output: outputStream as unknown as NodeJS.WriteStream,
  });

  return {
    input,
    inputStream,
    outputStream,
    getOutput: () => output,
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("createInteractiveInput", () => {
  it("readLine resolves typed input", async () => {
    const harness = createHarness();

    const prompt = harness.input.readLine("Name? ");
    await flush();
    harness.inputStream.write("alice\n");

    await expect(prompt).resolves.toBe("alice");

    harness.input.close();
  });

  it("readLine returns null on close", async () => {
    const harness = createHarness();

    const prompt = harness.input.readLine("Name? ");
    await flush();
    harness.input.close();

    await expect(prompt).resolves.toBeNull();
    expect(harness.input.getCloseReason()).toBe("closed");
  });

  it("reuses the same interface across sequential prompts", async () => {
    const harness = createHarness();

    const first = harness.input.readLine("First? ");
    await flush();
    harness.inputStream.write("one\n");
    await expect(first).resolves.toBe("one");

    const second = harness.input.readLine("Second? ");
    await flush();
    harness.inputStream.write("two\n");
    await expect(second).resolves.toBe("two");

    harness.input.close();
  });

  it.each([
    ["y", true],
    ["yes", true],
    ["n", false],
    ["no", false],
  ])("confirm accepts %s", async (answer, expected) => {
    const harness = createHarness();

    const prompt = harness.input.confirm("Continue? ", { defaultValue: false });
    await flush();
    harness.inputStream.write(`${answer}\n`);

    await expect(prompt).resolves.toBe(expected);

    harness.input.close();
  });

  it("confirm applies default false on blank input", async () => {
    const harness = createHarness();

    const prompt = harness.input.confirm("Continue? ", { defaultValue: false });
    await flush();
    harness.inputStream.write("\n");

    await expect(prompt).resolves.toBe(false);

    harness.input.close();
  });

  it("confirm applies default on closed prompt", async () => {
    const harness = createHarness();

    const prompt = harness.input.confirm("Continue? ", { defaultValue: false });
    await flush();
    harness.input.close();

    await expect(prompt).resolves.toBe(false);
  });

  it("confirm reprompts after invalid input", async () => {
    const harness = createHarness();

    const prompt = harness.input.confirm("Continue? ", { defaultValue: false });
    await flush();
    harness.inputStream.write("maybe\n");
    await flush();
    harness.inputStream.write("y\n");

    await expect(prompt).resolves.toBe(true);
    expect(harness.getOutput()).toContain(
      "Invalid response. Please enter y or n.",
    );
    expect(
      (harness.getOutput().match(/Continue\?/g) || []).length,
    ).toBeGreaterThanOrEqual(2);

    harness.input.close();
  });
});
