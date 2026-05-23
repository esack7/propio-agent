import {
  createAbortStateController,
  resolveInteractiveTurnAbortExitCode,
} from "../abortState.js";
import type { TerminalUi } from "../terminal.js";

function createUi(): Pick<TerminalUi, "warn" | "setMode"> & TerminalUi {
  return {
    warn: jest.fn(),
    setMode: jest.fn(),
  } as unknown as TerminalUi;
}

describe("createAbortStateController", () => {
  it("cancels an active turn on escape without setting shouldExit", () => {
    const ui = createUi();
    const abortState = createAbortStateController(ui);
    const controller = new AbortController();
    abortState.setCurrentAbortController(controller);

    expect(abortState.cancelActiveTurn("escape")).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBe("escape");
    expect(abortState.shouldExit()).toBe(false);
    expect(ui.warn).toHaveBeenCalledWith("Turn cancelled.");
    expect(ui.setMode).toHaveBeenCalledWith("awaitingInput");

    expect(abortState.cancelActiveTurn("escape")).toBe(false);
    expect(ui.warn).toHaveBeenCalledTimes(1);
  });

  it("aborts with sigint reason and sets shouldExit on SIGINT", () => {
    const ui = createUi();
    const abortState = createAbortStateController(ui);
    const close = jest.fn();
    const controller = new AbortController();
    abortState.setCurrentAbortController(controller);
    abortState.setActiveComposer({ close } as never);

    abortState.handleSigint();

    expect(abortState.shouldExit()).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBe("sigint");
    expect(close).toHaveBeenCalled();
  });
});

describe("resolveInteractiveTurnAbortExitCode", () => {
  it("returns null for escape cancel when the session is not exiting", () => {
    const controller = new AbortController();
    controller.abort("escape");

    expect(
      resolveInteractiveTurnAbortExitCode(controller.signal, () => false),
    ).toBeNull();
  });

  it("returns 130 for SIGINT exit and for unknown abort reasons", () => {
    const sigint = new AbortController();
    sigint.abort("sigint");
    expect(resolveInteractiveTurnAbortExitCode(sigint.signal, () => true)).toBe(
      130,
    );

    const generic = new AbortController();
    generic.abort();
    expect(
      resolveInteractiveTurnAbortExitCode(generic.signal, () => false),
    ).toBe(130);
  });
});
