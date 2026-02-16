import ora from "ora";

interface OperationSpinnerOptions {
  enabled?: boolean;
  stream?: NodeJS.WriteStream;
}

export class OperationSpinner {
  private spinner: ReturnType<typeof ora>;

  constructor(text: string, options: OperationSpinnerOptions = {}) {
    this.spinner = ora({
      text,
      stream: options.stream ?? process.stderr,
      isEnabled: options.enabled,
    });
  }

  start(): void {
    this.spinner.start();
  }

  setText(text: string): void {
    this.spinner.text = text;
  }

  succeed(message: string): void {
    this.spinner.succeed(message);
  }

  fail(message: string): void {
    this.spinner.fail(message);
  }

  stop(): void {
    this.spinner.stop();
  }
}
