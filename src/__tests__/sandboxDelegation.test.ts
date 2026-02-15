import { EventEmitter } from "events";
import * as path from "path";
import { pathToFileURL } from "url";
import type { ChildProcess } from "child_process";
import {
  maybeRunSandboxDelegation,
  resolveSandboxWrapperPath,
  type SandboxDelegationDeps,
  type SpawnProcess,
} from "../sandboxDelegation.js";

class MockChildProcess extends EventEmitter {
  once(event: string, listener: (...args: unknown[]) => void): this {
    return super.once(event, listener);
  }
}

function asChildProcess(emitter: MockChildProcess): ChildProcess {
  return emitter as unknown as ChildProcess;
}

describe("sandbox delegation", () => {
  it("resolves wrapper path relative to entrypoint location", () => {
    const srcPath = pathToFileURL("/tmp/project/src/index.ts").href;
    const distPath = pathToFileURL("/tmp/project/dist/index.js").href;

    expect(resolveSandboxWrapperPath(srcPath)).toBe(
      path.resolve("/tmp/project/bin/propio-sandbox"),
    );
    expect(resolveSandboxWrapperPath(distPath)).toBe(
      path.resolve("/tmp/project/bin/propio-sandbox"),
    );
  });

  it("keeps native mode when --sandbox is absent", async () => {
    const resolveWrapperPath = jest.fn(() => "/tmp/unused");
    const validateWrapper = jest.fn();
    const spawnProcess = jest.fn() as unknown as SpawnProcess;

    const result = await maybeRunSandboxDelegation(["--help"], {
      resolveWrapperPath,
      validateWrapper,
      spawnProcess,
    });

    expect(result).toBeNull();
    expect(resolveWrapperPath).not.toHaveBeenCalled();
    expect(validateWrapper).not.toHaveBeenCalled();
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("spawns wrapper with inherited stdio and cwd, excluding --sandbox", async () => {
    const wrapperPath = "/tmp/project/bin/propio-sandbox";
    const mockChild = new MockChildProcess();
    const spawnProcess: SpawnProcess = jest.fn(() => {
      setImmediate(() => {
        mockChild.emit("close", 0, null);
      });
      return asChildProcess(mockChild);
    });

    const result = await maybeRunSandboxDelegation(
      ["--sandbox", "--help", "--foo", "bar"],
      {
        resolveWrapperPath: () => wrapperPath,
        validateWrapper: () => {},
        spawnProcess,
      },
    );

    expect(result).toBe(0);
    expect(spawnProcess).toHaveBeenCalledWith(
      wrapperPath,
      ["--help", "--foo", "bar"],
      {
        cwd: process.cwd(),
        shell: false,
        stdio: "inherit",
      },
    );
  });

  it("returns non-zero with clear error when wrapper validation fails", async () => {
    const logError = jest.fn();
    const spawnProcess = jest.fn() as unknown as SpawnProcess;

    const result = await maybeRunSandboxDelegation(["--sandbox"], {
      resolveWrapperPath: () => "/tmp/project/bin/propio-sandbox",
      validateWrapper: () => {
        throw new Error("Sandbox wrapper not found");
      },
      spawnProcess,
      logError,
    });

    expect(result).toBe(1);
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith("Sandbox wrapper not found");
  });

  it("returns non-zero and reports spawn/runtime failures", async () => {
    const logError = jest.fn();
    const mockChild = new MockChildProcess();
    const spawnProcess: SpawnProcess = jest.fn(() => {
      setImmediate(() => {
        mockChild.emit("error", new Error("EACCES"));
      });
      return asChildProcess(mockChild);
    });

    const deps: Partial<SandboxDelegationDeps> = {
      resolveWrapperPath: () => "/tmp/project/bin/propio-sandbox",
      validateWrapper: () => {},
      spawnProcess,
      logError,
    };

    const result = await maybeRunSandboxDelegation(["--sandbox"], deps);

    expect(result).toBe(1);
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining("Failed to start sandbox wrapper"),
    );
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("EACCES"));
  });

  it("returns non-zero when wrapper exits due to signal", async () => {
    const logError = jest.fn();
    const mockChild = new MockChildProcess();
    const spawnProcess: SpawnProcess = jest.fn(() => {
      setImmediate(() => {
        mockChild.emit("close", null, "SIGTERM");
      });
      return asChildProcess(mockChild);
    });

    const result = await maybeRunSandboxDelegation(["--sandbox"], {
      resolveWrapperPath: () => "/tmp/project/bin/propio-sandbox",
      validateWrapper: () => {},
      spawnProcess,
      logError,
    });

    expect(result).toBe(1);
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("SIGTERM"));
  });
});
