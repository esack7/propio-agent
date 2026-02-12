import chalk from "chalk";

// One Atom Dark color palette using chalk.hex()
const colors = {
  userInput: chalk.hex("#56B6C2"), // Cyan
  assistant: chalk.hex("#ABB2BF"), // Light Gray
  tool: chalk.hex("#C678DD"), // Purple
  success: chalk.hex("#98C379"), // Green
  error: chalk.hex("#E06C75"), // Red
  warning: chalk.hex("#D19A66"), // Orange
  command: chalk.hex("#E5C07B"), // Yellow
  subtle: chalk.hex("#5C6370"), // Dark Gray
  info: chalk.hex("#61AFEF"), // Blue
};

// Export color functions for each semantic role
export const userInput = (text: string) => colors.userInput(text);
export const assistant = (text: string) => colors.assistant(text);
export const tool = (text: string) => colors.tool(text);
export const success = (text: string) => colors.success(text);
export const error = (text: string) => colors.error(text);
export const warning = (text: string) => colors.warning(text);
export const command = (text: string) => colors.command(text);
export const subtle = (text: string) => colors.subtle(text);
export const info = (text: string) => colors.info(text);
