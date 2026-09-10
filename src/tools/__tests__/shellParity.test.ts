import { executeNodeShell } from "../index.js";

const nodeCommand = (script: string) =>
  `'${process.execPath.replace(/'/g, "'\\''")}' -e '${script.replace(/'/g, "'\\''")}'`;

it.each(["stdout", "stderr"])(
  "preserves multibyte %s across both shell backends",
  async (stream) => {
    const command = nodeCommand(`process.${stream}.write("€".repeat(100000))`);
    for (const abortSignal of [undefined, new AbortController().signal]) {
      const result = await executeNodeShell({
        command,
        cwd: process.cwd(),
        maxBuffer: 400000,
        abortSignal,
      });
      expect(result[stream as "stdout" | "stderr"]).toBe("€".repeat(100000));
      expect(result.maxBufferExceeded).toBeUndefined();
    }
  },
);

it.each(["stdout", "stderr"])(
  "enforces byte caps for multibyte %s on both backends",
  async (stream) => {
    const command = nodeCommand(`process.${stream}.write("€".repeat(1000))`);
    for (const abortSignal of [undefined, new AbortController().signal]) {
      const result = await executeNodeShell({
        command,
        cwd: process.cwd(),
        maxBuffer: 1201,
        abortSignal,
      });
      expect(result.maxBufferExceeded).toBe(true);
      expect(result.stderr).toContain("maxBuffer length exceeded");
      if (abortSignal) {
        const captured = result[stream as "stdout" | "stderr"].split("\n")[0];
        expect(Buffer.byteLength(captured)).toBeLessThanOrEqual(1201);
        expect(captured).not.toContain("\ufffd");
      }
    }
  },
);

it("preserves the failure message for empty-stderr nonzero exits", async () => {
  const options = { command: "exit 3", cwd: process.cwd() };
  expect(
    await executeNodeShell({
      ...options,
      abortSignal: new AbortController().signal,
    }),
  ).toEqual(await executeNodeShell(options));
});
