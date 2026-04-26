import { TranscriptRenderer } from "../transcriptRenderer.js";
import type { TerminalWriter } from "../terminalWriter.js";

function createWriter(events: string[]): TerminalWriter {
  return {
    writeStderrLine: (text: string) => {
      events.push(`line:${text}`);
    },
    writeStderr: (text: string) => {
      events.push(`raw:${text}`);
    },
    writeStdoutLine: (text: string) => {
      events.push(`out:${text}`);
    },
  } as unknown as TerminalWriter;
}

describe("TranscriptRenderer", () => {
  it("clears active status before emitting durable transcript output", () => {
    const events: string[] = [];
    const clearStatus = jest.fn(() => {
      events.push("clear");
    });
    const renderer = new TranscriptRenderer({
      writer: createWriter(events),
      style: (text) => text,
      clearStatus,
      interactive: false,
    });

    renderer.info("hello");

    expect(clearStatus).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["clear", "line:hello"]);
  });

  it("renders turn completion as durable transcript output", () => {
    const events: string[] = [];
    const renderer = new TranscriptRenderer({
      writer: createWriter(events),
      style: (text) => text,
      clearStatus: jest.fn(),
      interactive: true,
    });

    renderer.turnComplete(4200);

    expect(events).toEqual(["line:Turn complete in 4.2s"]);
  });
});
