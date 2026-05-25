export const BRACKETED_PASTE_ENABLE = "\x1b[?2004h";
export const BRACKETED_PASTE_DISABLE = "\x1b[?2004l";

export function enableBracketedPaste(stream: NodeJS.WriteStream): void {
  if (stream.isTTY) {
    stream.write(BRACKETED_PASTE_ENABLE);
  }
}

export function disableBracketedPaste(stream: NodeJS.WriteStream): void {
  if (stream.isTTY) {
    stream.write(BRACKETED_PASTE_DISABLE);
  }
}
