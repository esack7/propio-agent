import { error as colorError, success as colorSuccess } from "./statusColors.js";
import { formatInfo } from "./formatting.js";
import { OperationSpinner } from "./spinner.js";

type StyleFn = (text: string, formatter: (value: string) => string) => string;

interface SpinnerLike {
  start(): void;
  setPhase(phase: string | null): void;
  setText(text: string): void;
  succeed(message: string): void;
  fail(message: string): void;
  stop(): void;
}

interface SpinnerOptions {
  enabled?: boolean;
  stream?: NodeJS.WriteStream;
  phase?: string;
}

export type SpinnerFactory = (
  text: string,
  options: SpinnerOptions,
) => SpinnerLike;

export interface StatusRendererOptions {
  stream: NodeJS.WriteStream;
  style: StyleFn;
  interactive: boolean;
  plain: boolean;
  json: boolean;
  fallbackInfo: (text: string) => void;
  createSpinner?: SpinnerFactory;
}

export class StatusRenderer {
  private spinner: SpinnerLike | null = null;

  constructor(private readonly options: StatusRendererOptions) {}

  status(text: string, phase?: string): void {
    if (this.options.json) {
      return;
    }

    if (
      !this.options.interactive ||
      this.options.plain ||
      !this.options.stream.isTTY
    ) {
      this.options.fallbackInfo(text);
      return;
    }

    const formatted = this.options.style(text, formatInfo);
    if (!this.spinner) {
      this.spinner = this.createSpinner(formatted, phase);
      this.spinner.start();
      return;
    }

    this.spinner.setPhase(phase ?? null);
    this.spinner.setText(formatted);
  }

  progress(current: number, total: number, label?: string): void {
    const safeTotal = total <= 0 ? 1 : total;
    const boundedCurrent = Math.max(0, Math.min(current, safeTotal));
    const percentage = Math.floor((boundedCurrent / safeTotal) * 100);
    const progressText = label
      ? `${label} (${boundedCurrent}/${safeTotal}, ${percentage}%)`
      : `${boundedCurrent}/${safeTotal} (${percentage}%)`;
    this.status(progressText);
  }

  clear(): void {
    if (!this.spinner) {
      return;
    }

    this.spinner.stop();
    this.spinner = null;
  }

  succeed(text: string): boolean {
    if (!this.spinner) {
      return false;
    }

    const formatted = this.options.style(text, colorSuccess);
    this.spinner.succeed(formatted);
    this.spinner = null;
    return true;
  }

  fail(text: string): boolean {
    if (!this.spinner) {
      return false;
    }

    const formatted = this.options.style(text, colorError);
    this.spinner.fail(formatted);
    this.spinner = null;
    return true;
  }

  private createSpinner(text: string, phase?: string): SpinnerLike {
    const factory =
      this.options.createSpinner ??
      ((spinnerText: string, spinnerOptions: SpinnerOptions) =>
        new OperationSpinner(spinnerText, spinnerOptions));

    return factory(text, {
      enabled: true,
      stream: this.options.stream,
      phase,
    });
  }
}
