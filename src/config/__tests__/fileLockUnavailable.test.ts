import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// An installation without the optional native package, such as one made with
// --omit=optional or on a platform where it does not build.
jest.unstable_mockModule("os-lock", () => {
  throw Object.assign(new Error("Cannot find package 'os-lock'"), {
    code: "ERR_MODULE_NOT_FOUND",
  });
});

const { FileLockUnavailableError, isFileLockAvailable, withFileLock } =
  await import("../fileLock.js");
const { FilePermissionStore, PermissionSettingsError } =
  await import("../permissionStore.js");

describe("without the optional os-lock package", () => {
  let directory: string;
  let filePath: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "propio-nolock-"));
    filePath = path.join(directory, "settings.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({ permissions: { deny: ["bash(git push:*)"] } }),
    );
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("reports that locking is unavailable instead of a module error", async () => {
    await expect(isFileLockAvailable()).resolves.toBe(false);
    const ran = jest.fn(async () => "ran");

    await expect(
      withFileLock(path.join(directory, "x.lock"), ran),
    ).rejects.toBeInstanceOf(FileLockUnavailableError);
    expect(ran).not.toHaveBeenCalled();
  });

  it("still reads rules, and refuses to save with a reason the operator can act on", async () => {
    const store = new FilePermissionStore({ filePath, owner: "local" });
    const before = fs.readFileSync(filePath, "utf8");

    await expect(store.load("local")).resolves.toMatchObject({
      deny: ["bash(git push:*)"],
    });
    await expect(store.savingUnavailableReason()).resolves.toMatch(
      /lacks the optional os-lock package.*by hand/,
    );
    const failure = await store
      .update("local", (current) => ({ ...current, allow: ["bash"] }))
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PermissionSettingsError);
    expect((failure as Error).message).toContain("Cannot save permissions to");
    expect((failure as Error).message).not.toContain("ERR_MODULE_NOT_FOUND");
    expect(fs.readFileSync(filePath, "utf8")).toBe(before);
  });
});
