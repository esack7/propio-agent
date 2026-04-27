import { formatSubtle } from "./formatting.js";
import type { TerminalWriter } from "./terminalWriter.js";

type StyleFn = (text: string, formatter: (value: string) => string) => string;

export interface FooterRendererOptions {
  writer: TerminalWriter;
  style: StyleFn;
  clearStatus: () => void;
  interactive: boolean;
  json: boolean;
}

export class FooterRenderer {
  constructor(private readonly options: FooterRendererOptions) {}

  idleFooter(text: string): void {
    if (this.options.json || !this.options.interactive) {
      return;
    }

    this.options.clearStatus();
    this.options.writer.writeStderrLine(this.options.style(text, formatSubtle));
  }
}
