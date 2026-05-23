export type InputMode = "prompt" | "bash";

export function getModeFromInput(input: string): InputMode {
  return input.startsWith("!") ? "bash" : "prompt";
}

export function getValueFromInput(input: string): string {
  return input.startsWith("!") ? input.slice(1) : input;
}

export interface ApplyInputModeFromBufferResult {
  inputMode: InputMode;
  buffer: string;
  cursorAdjusted: number;
}

export function applyInputModeFromBuffer(
  currentMode: InputMode,
  buffer: string,
): ApplyInputModeFromBufferResult {
  if (currentMode === "prompt" && getModeFromInput(buffer) === "bash") {
    const stripped = getValueFromInput(buffer);
    return {
      inputMode: "bash",
      buffer: stripped,
      cursorAdjusted: stripped.length - buffer.length,
    };
  }

  return { inputMode: currentMode, buffer, cursorAdjusted: 0 };
}

export function formatBashHistoryEntry(command: string): string {
  return `!${command}`;
}

export function parseBashHistoryEntry(entry: string): string {
  return entry.startsWith("!") ? entry.slice(1) : entry;
}
