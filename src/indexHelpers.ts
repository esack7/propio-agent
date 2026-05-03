import type { AgentDiagnosticEvent } from "./diagnostics.js";
import type { TerminalUi } from "./ui/terminal.js";

export function isLlmDebugEnabled(parsedFlag: boolean): boolean {
  if (parsedFlag) {
    return true;
  }
  const envValue = process.env.PROPIO_DEBUG_LLM;
  if (!envValue) {
    return false;
  }
  const normalized = envValue.toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export interface StyledLine {
  readonly text: string;
  readonly style: "info" | "subtle" | "section";
}

export function renderStyledLines(
  ui: Pick<TerminalUi, "command" | "info" | "subtle" | "section">,
  lines: ReadonlyArray<StyledLine>,
): void {
  for (const line of lines) {
    switch (line.style) {
      case "section":
        ui.section(line.text);
        break;
      case "info":
        ui.info(line.text);
        break;
      case "subtle":
        ui.subtle(line.text);
        break;
    }
  }
}

export function formatDiagnosticLogLine(
  timestamp: string,
  event: AgentDiagnosticEvent,
): string {
  return `[llm-debug ${timestamp}] ${JSON.stringify(event)}\n`;
}
