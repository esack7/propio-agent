import yoctoSpinner, { type Spinner } from "yocto-spinner";

interface OperationSpinnerOptions {
  enabled?: boolean;
  stream?: NodeJS.WriteStream;
  phase?: string;
  showElapsed?: boolean;
  elapsedUpdateIntervalMs?: number;
}

export class OperationSpinner {
  private spinner: Spinner;
  private baseText: string;
  private phase: string | null;
  private readonly enabled: boolean;
  private readonly showElapsed: boolean;
  private readonly elapsedUpdateIntervalMs: number;
  private startedAtMs: number | null = null;
  private elapsedTimerId: NodeJS.Timeout | null = null;

  constructor(text: string, options: OperationSpinnerOptions = {}) {
    this.baseText = text;
    this.phase = options.phase ?? null;
    this.enabled = options.enabled ?? true;
    this.showElapsed = options.showElapsed ?? true;
    this.elapsedUpdateIntervalMs = options.elapsedUpdateIntervalMs ?? 1000;
    this.spinner = yoctoSpinner({
      text: this.composeText(),
      stream: options.stream ?? process.stderr,
    });
  }

  start(): void {
    if (!this.enabled) {
      return;
    }

    this.startedAtMs = Date.now();
    this.refreshText();
    this.startElapsedTicker();
    this.spinner.start();
  }

  setText(text: string): void {
    this.baseText = text;
    this.refreshText();
  }

  setPhase(phase: string | null): void {
    this.phase = phase;
    this.refreshText();
  }

  succeed(message: string): void {
    this.stopElapsedTicker();
    if (!this.enabled) {
      return;
    }

    this.spinner.success(message);
  }

  fail(message: string): void {
    this.stopElapsedTicker();
    if (!this.enabled) {
      return;
    }

    this.spinner.error(message);
  }

  stop(): void {
    this.stopElapsedTicker();
    if (!this.enabled) {
      return;
    }

    this.spinner.stop();
  }

  private composeText(): string {
    const phasePrefix = this.phase ? `[${this.phase}] ` : "";
    const elapsedSuffix = this.getElapsedSuffix();
    return `${phasePrefix}${this.baseText}${elapsedSuffix}`;
  }

  private getElapsedSuffix(): string {
    if (!this.showElapsed || this.startedAtMs === null) {
      return "";
    }

    const elapsedSeconds = Math.max(
      0,
      Math.floor((Date.now() - this.startedAtMs) / 1000),
    );

    return ` (${elapsedSeconds}s)`;
  }

  private refreshText(): void {
    if (!this.enabled) {
      return;
    }

    this.spinner.text = this.composeText();
  }

  private startElapsedTicker(): void {
    if (!this.showElapsed || this.elapsedTimerId !== null) {
      return;
    }

    this.elapsedTimerId = setInterval(() => {
      this.refreshText();
    }, this.elapsedUpdateIntervalMs);
    this.elapsedTimerId.unref();
  }

  private stopElapsedTicker(): void {
    if (this.elapsedTimerId !== null) {
      clearInterval(this.elapsedTimerId);
      this.elapsedTimerId = null;
    }
  }
}
