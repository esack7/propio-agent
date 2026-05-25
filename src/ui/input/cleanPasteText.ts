const ANSI_ESCAPE_PATTERN = /\x1B\[[0-?]*[ -/]*[@-~]/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, "");
}

/** Normalize pasted terminal text for buffer insertion. */
export function cleanPasteText(text: string): string {
  return stripAnsi(text).replace(/\r\n?/g, "\n").replace(/\t/g, " ");
}
