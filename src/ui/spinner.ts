import ora from "ora";

export class OperationSpinner {
  private spinner: ReturnType<typeof ora>;

  constructor(text: string) {
    this.spinner = ora(text);
  }

  start(): void {
    this.spinner.start();
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
