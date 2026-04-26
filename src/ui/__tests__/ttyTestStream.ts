export function createTtyTestStream(
  isTTY = true,
  columns = 80,
): NodeJS.WriteStream & { chunks: string[] } {
  const chunks: string[] = [];

  return {
    chunks,
    columns,
    isTTY,
    write: (chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf-8"));
      return true;
    },
    cursorTo: () => true,
    clearLine: () => true,
    moveCursor: () => true,
    clearScreenDown: () => true,
  } as unknown as NodeJS.WriteStream & { chunks: string[] };
}

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}
