import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type {
  TraceCaptureFailure,
  TraceEventEnvelope,
  TraceReadResult,
  TraceReadWarning,
  TraceMaterialReference,
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
  /** Private payload capture is opt-in; standard journals keep metadata only. */
  readonly captureLevel?: "standard" | "full";
}

export function materialDirectoryForJournal(journalPath: string): string {
  return `${path.basename(journalPath, ".jsonl")}.materials`;
}

function materialBytes(value: unknown): {
  bytes: Buffer;
  encoding: TraceMaterialReference["encoding"];
} {
  if (value instanceof Uint8Array) {
    return { bytes: Buffer.from(value), encoding: "binary" };
  }
  const serializable = JSON.parse(
    JSON.stringify(value, function (this: Record<string, unknown>, key, entry) {
      // Buffer.toJSON runs before the replacer; inspect the holder's raw value.
      const raw = this[key];
      return raw instanceof Uint8Array
        ? { $binary: Buffer.from(raw).toString("base64") }
        : entry;
    }),
  );
  const redacted = redactTraceValue(serializable, { preservePaths: true });
  return { bytes: Buffer.from(JSON.stringify(redacted)), encoding: "json" };
}

function syncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const fd = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Explicit-path, append-only local journal. Construction performs no discovery. */
export class JsonlTraceJournal implements TraceSink {
  private fd: number | undefined;
  private degraded = false;
  private readonly pendingMaterialPaths = new Set<string>();
  private readonly pendingMaterialDirectories = new Set<string>();

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

  get captureLevel(): "standard" | "full" {
    return this.options.captureLevel ?? "standard";
  }

  captureMaterial(value: unknown): TraceMaterialReference | undefined {
    if (this.options.captureLevel !== "full" || this.fd === undefined)
      return undefined;
    try {
      const { bytes, encoding } = materialBytes(value);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const directory = materialDirectoryForJournal(this.journalPath);
      const materialDirectory = this.ensureMaterialDirectory(directory);
      const relativePath = `${directory}/${sha256}.${encoding === "json" ? "json" : "bin"}`;
      const target = path.join(path.dirname(this.journalPath), relativePath);
      this.storeMaterial(target, bytes, sha256, materialDirectory);
      return { path: relativePath, sha256, sizeBytes: bytes.length, encoding };
    } catch (error) {
      this.captureFailure("material", error);
      return undefined;
    }
  }

  private ensureMaterialDirectory(directory: string): string {
    const materialDirectory = path.join(
      path.dirname(this.journalPath),
      directory,
    );
    fs.mkdirSync(materialDirectory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(materialDirectory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 ||
      path.dirname(fs.realpathSync(materialDirectory)) !==
        fs.realpathSync(path.dirname(this.journalPath))
    )
      throw new Error("Recovery material directory is not private");
    return materialDirectory;
  }

  private storeMaterial(
    target: string,
    bytes: Buffer,
    sha256: string,
    directory: string,
  ): void {
    const existing = fs.lstatSync(target, { throwIfNoEntry: false });
    if (existing) {
      if (
        !existing.isFile() ||
        existing.isSymbolicLink() ||
        (existing.mode & 0o077) !== 0 ||
        createHash("sha256").update(fs.readFileSync(target)).digest("hex") !==
          sha256
      )
        throw new Error(
          "Captured material path is not a private matching file",
        );
      return;
    }
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temp, "wx", 0o600);
      try {
        fs.writeFileSync(fd, bytes);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temp, target);
      this.pendingMaterialPaths.add(target);
      this.pendingMaterialDirectories.add(directory);
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
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
      this.flushMaterial();
    } catch (error) {
      this.captureFailure("material", error);
      return;
    }
    try {
      fs.fsyncSync(this.fd);
    } catch (error) {
      this.captureFailure("flush", error);
    }
  }

  private flushMaterial(): void {
    for (const file of this.pendingMaterialPaths) {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error("Captured material path changed before flush");
      const fd = fs.openSync(file, "r");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    for (const directory of this.pendingMaterialDirectories) {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("Captured material directory changed before flush");
      syncDirectory(directory);
      syncDirectory(path.dirname(directory));
    }
    this.pendingMaterialPaths.clear();
    this.pendingMaterialDirectories.clear();
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
