import chalk from "chalk";

const statusColors = {
  tool: chalk.hex("#C678DD"),
  success: chalk.hex("#98C379"),
  error: chalk.hex("#E06C75"),
  warning: chalk.hex("#D19A66"),
};

export const tool = (text: string) => statusColors.tool(text);
export const success = (text: string) => statusColors.success(text);
export const error = (text: string) => statusColors.error(text);
export const warning = (text: string) => statusColors.warning(text);
