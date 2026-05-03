import chalk from "chalk";

const detectedColorLevel = chalk.level;

export function setColorEnabled(enabled: boolean): void {
  chalk.level = enabled ? detectedColorLevel : 0;
}

const textColors = {
  userInput: chalk.hex("#56B6C2"),
  assistant: chalk.hex("#ABB2BF"),
  inputPrompt: chalk.hex("#56B6C2"),
  assistantPrefix: chalk.hex("#5C6370"),
  assistantGutter: chalk.hex("#5C6370"),
  inputBorder: chalk.hex("#5C6370"),
  inputFill: chalk.bgHex("#282C34"),
  inputPlaceholder: chalk.hex("#5C6370"),
  command: chalk.hex("#E5C07B"),
  subtle: chalk.hex("#5C6370"),
  info: chalk.hex("#61AFEF"),
};

export const userInput = (text: string) => textColors.userInput(text);
export const assistant = (text: string) => textColors.assistant(text);
export const inputPrompt = (text: string) => textColors.inputPrompt(text);
export const assistantPrefix = (text: string) => textColors.assistantPrefix(text);
export const assistantGutter = (text: string) => textColors.assistantGutter(text);
export const inputBorder = (text: string) => textColors.inputBorder(text);
export const inputFill = (text: string) => textColors.inputFill(text);
export const inputPlaceholder = (text: string) => textColors.inputPlaceholder(text);
export const command = (text: string) => textColors.command(text);
export const subtle = (text: string) => textColors.subtle(text);
export const info = (text: string) => textColors.info(text);
