import * as textColors from "./textColors.js";
import * as statusColors from "./statusColors.js";
import { symbols } from "./symbols.js";

export function formatUserMessage(text: string): string {
  return textColors.userInput(text);
}

export function formatAssistantMessage(text: string): string {
  return textColors.assistant(text);
}

export function formatInputPrompt(text: string): string {
  return textColors.inputPrompt(text);
}

function formatAssistantPrefix(text: string): string {
  return textColors.assistantPrefix(text);
}

function formatAssistantGutter(text: string): string {
  return textColors.assistantGutter(text);
}

function formatInputBorder(text: string): string {
  return textColors.inputBorder(text);
}

function formatInputFill(text: string): string {
  return textColors.inputFill(text);
}

function formatInputPlaceholder(text: string): string {
  return textColors.inputPlaceholder(text);
}

function formatToolExecution(toolName: string): string {
  return statusColors.tool(`${symbols.bullet} ${toolName}`);
}

export function formatSuccess(text: string): string {
  return statusColors.success(`${symbols.success} ${text}`);
}

export function formatError(text: string): string {
  return statusColors.error(`${symbols.error} ${text}`);
}

export function formatWarning(text: string): string {
  return statusColors.warning(`${symbols.bullet} ${text}`);
}

export function formatCommand(text: string): string {
  return textColors.command(text);
}

export function formatInfo(text: string): string {
  return textColors.info(text);
}

export function formatSubtle(text: string): string {
  return textColors.subtle(text);
}
