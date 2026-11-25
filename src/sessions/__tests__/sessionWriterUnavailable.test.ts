import { jest } from "@jest/globals";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

jest.unstable_mockModule("os-lock", () => {
  throw new Error("native module unavailable");
});
const { acquireSessionWriter } = await import("../sessionWriter.js");

it("refuses startup before storage mutation with reinstall instructions when locking is unavailable", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "missing-lock-"));
  try {
    await expect(acquireSessionWriter(directory, "session")).rejects.toThrow(
      /Reinstall with optional dependencies and a native build toolchain/,
    );
    expect(fs.readdirSync(directory)).toEqual([]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
