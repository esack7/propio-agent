import * as colors from "./colors.js";
import { symbols } from "./symbols.js";

export function formatUserMessage(text: string): string {
  return colors.userInput(text);
}

export function formatAssistantMessage(text: string): string {
  return colors.assistant(text);
}

export function formatInputPrompt(text: string): string {
  return colors.inputPrompt(text);
}

export function formatAssistantPrefix(text: string): string {
  return colors.assistantPrefix(text);
}

export function formatAssistantGutter(text: string): string {
  return colors.assistantGutter(text);
}

export function formatInputBorder(text: string): string {
  return colors.inputBorder(text);
}

export function formatInputFill(text: string): string {
  return colors.inputFill(text);
}

export function formatInputPlaceholder(text: string): string {
  return colors.inputPlaceholder(text);
}

export function formatToolExecution(toolName: string): string {
  return colors.tool(`${symbols.bullet} ${toolName}`);
}

export function formatSuccess(text: string): string {
  return colors.success(`${symbols.success} ${text}`);
}

export function formatError(text: string): string {
  return colors.error(`${symbols.error} ${text}`);
}

export function formatWarning(text: string): string {
  return colors.warning(`${symbols.bullet} ${text}`);
}

export function formatCommand(text: string): string {
  return colors.command(text);
}

export function formatInfo(text: string): string {
  return colors.info(text);
}

export function formatSubtle(text: string): string {
  return colors.subtle(text);
}
