import {
  BRACKETED_PASTE_DISABLE,
  BRACKETED_PASTE_ENABLE,
  disableBracketedPaste,
  enableBracketedPaste,
} from "../bracketedPaste.js";
import { createTtyTestStream } from "../../__tests__/ttyTestStream.js";

describe("bracketedPaste", () => {
  it("writes enable and disable sequences on a TTY stream", () => {
    const stream = createTtyTestStream(true);

    enableBracketedPaste(stream);
    disableBracketedPaste(stream);

    expect(stream.chunks).toEqual([
      BRACKETED_PASTE_ENABLE,
      BRACKETED_PASTE_DISABLE,
    ]);
  });

  it("skips enable and disable when the stream is not a TTY", () => {
    const stream = createTtyTestStream(false);

    enableBracketedPaste(stream);
    disableBracketedPaste(stream);

    expect(stream.chunks).toEqual([]);
  });

  it("allows disable on a non-TTY without writing", () => {
    const stream = createTtyTestStream(false);
    expect(() => disableBracketedPaste(stream)).not.toThrow();
    expect(stream.chunks).toEqual([]);
  });
});
