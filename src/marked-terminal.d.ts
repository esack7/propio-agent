declare module "marked-terminal" {
  import { Marked } from "marked";

  export interface TerminalOptions {
    [key: string]: any;
  }

  export function markedTerminal(
    options?: TerminalOptions,
    highlightOptions?: any,
  ): { renderer: any };

  export default function TerminalRenderer(
    options?: TerminalOptions,
    highlightOptions?: any,
  ): any;
}
