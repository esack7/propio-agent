import * as fs from "node:fs";
import * as path from "node:path";
import type {
  TraceCaptureFailure,
  TraceEventEnvelope,
  TraceReadResult,
  TraceReadWarning,
  TraceRecordOptions,
  TraceSink,
} from "./types.js";
import { redactTraceValue } from "./redaction.js";

export interface JsonlTraceJournalOptions {
  readonly onCaptureFailure?: (failure: TraceCaptureFailure) => void;
  /** Defaults to syncing only when record(..., { durable: true }) is used. */
  readonly syncEveryRecord?: boolean;
  /** Defaults to standard secret redaction. */
  readonly redact?: boolean;
}

/** Explicit-path, append-only local journal. Construction performs no discovery. */
export class JsonlTraceJournal implements TraceSink {
  private fd: number | undefined;
  private degraded = false;

  constructor(
    readonly journalPath: string,
    private readonly options: JsonlTraceJournalOptions = {},
  ) {
    try {
      fs.mkdirSync(path.dirname(journalPath), { recursive: true, mode: 0o700 });
      this.fd = fs.openSync(journalPath, "a", 0o600);
    } catch (error) {
      this.captureFailure("open", error);
    }
  }

  get captureDegraded(): boolean {
    return this.degraded;
  }

  record(event: TraceEventEnvelope, options?: TraceRecordOptions): void {
    if (this.fd === undefined) return;
    try {
      const persistedEvent =
        this.options.redact === false ? event : redactTraceValue(event);
      fs.writeSync(
        this.fd,
        `${JSON.stringify(persistedEvent)}\n`,
        undefined,
        "utf8",
      );
    } catch (error) {
      this.captureFailure("write", error);
      return;
    }

    if (options?.durable || this.options.syncEveryRecord) {
      this.flush();
    }
  }

  flush(): void {
    if (this.fd === undefined) return;
    try {
      fs.fsyncSync(this.fd);
    } catch (error) {
      this.captureFailure("flush", error);
    }
  }

  close(): void {
    const fd = this.fd;
    if (fd === undefined) return;
    this.flush();
    this.fd = undefined;
    try {
      fs.closeSync(fd);
    } catch (error) {
      this.captureFailure("close", error);
    }
  }

  private captureFailure(
    operation: TraceCaptureFailure["operation"],
    error: unknown,
  ): void {
    this.degraded = true;
    const failure: TraceCaptureFailure = {
      journalPath: this.journalPath,
      operation,
      errorName: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
    };
    try {
      this.options.onCaptureFailure?.(failure);
    } catch {
      // The independent warning channel is also observational.
    }
  }
}

export function readTraceJournal(journalPath: string): TraceReadResult {
  const content = fs.readFileSync(journalPath, "utf8");
  const lines = content.split("\n");
  const endsWithNewline = content.endsWith("\n");
  const events: TraceEventEnvelope[] = [];
  const warnings: TraceReadWarning[] = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as TraceEventEnvelope);
    } catch (error) {
      const isFinalTruncatedLine =
        index === lines.length - 1 && !endsWithNewline;
      warnings.push({
        type: isFinalTruncatedLine ? "truncated_final_line" : "invalid_line",
        line: index + 1,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { events, warnings };
}
