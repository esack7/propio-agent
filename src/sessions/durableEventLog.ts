import * as fs from "node:fs";
import * as path from "node:path";
import {
  parseProtocolEvent,
  type ProtocolEvent,
  type SessionEventLog,
} from "../agent-core/protocol.js";

/** Sequential-writer JSONL log. Initialization validates once; appends never reread history. */
export class DurableEventLog implements SessionEventLog {
  private events: ProtocolEvent[];
  private validBytes = 0;
  private observedBytes = 0;
  private torn = false;
  private failed = false;

  constructor(private readonly filename: string) {
    if (!path.isAbsolute(filename))
      throw new TypeError("Protocol log path must be absolute");
    const stat = fs.lstatSync(filename, { throwIfNoEntry: false });
    if (stat && (!stat.isFile() || stat.isSymbolicLink()))
      throw new Error(`Unsafe protocol log: ${filename}`);
    const content = stat ? fs.readFileSync(filename, "utf8") : "";
    const lines = content.split("\n");
    const tail = lines.pop()!;
    this.torn = tail.length > 0;
    this.events = lines.map((line, index) => {
      try {
        return parseProtocolEvent(JSON.parse(line));
      } catch (cause) {
        throw new Error(
          `Corrupt protocol log ${filename} at line ${index + 1}: ${String(cause)}`,
        );
      }
    });
    for (let i = 1; i < this.events.length; i++) {
      if (this.events[i].seq !== this.events[i - 1].seq + 1)
        throw new Error(`Noncontiguous protocol log: ${filename}`);
    }
    this.observedBytes = Buffer.byteLength(content);
    this.validBytes = this.observedBytes - Buffer.byteLength(tail);
  }

  get coverageWarning(): string | undefined {
    return this.failed || fs.existsSync(`${this.filename}.gap`)
      ? "Protocol recording failed during an earlier turn; replay coverage is partial."
      : this.torn
        ? "An interrupted final protocol record was ignored; replay coverage ends at the last durable record."
        : undefined;
  }

  private refresh(): void {
    const stat = fs.lstatSync(this.filename, { throwIfNoEntry: false });
    if (stat && (!stat.isFile() || stat.isSymbolicLink()))
      throw new Error(`Unsafe protocol log: ${this.filename}`);
    const size = stat?.size ?? 0;
    if (size === this.observedBytes) return;
    if (size < this.validBytes)
      throw new Error(
        `Protocol log was replaced or truncated: ${this.filename}`,
      );
    const suffix = Buffer.alloc(size - this.validBytes);
    const fd = fs.openSync(this.filename, "r");
    try {
      fs.readSync(fd, suffix, 0, suffix.length, this.validBytes);
    } finally {
      fs.closeSync(fd);
    }
    this.acceptSuffix(suffix, size);
  }

  private acceptSuffix(suffix: Buffer, size: number): void {
    const lines = suffix.toString("utf8").split("\n");
    const tail = lines.pop()!;
    const added = lines.map((line) => parseProtocolEvent(JSON.parse(line)));
    let previous = this.events[this.events.length - 1]?.seq;
    for (const event of added) {
      if (previous !== undefined && event.seq !== previous + 1)
        throw new Error(`Noncontiguous protocol log: ${this.filename}`);
      previous = event.seq;
    }
    this.events.push(...added);
    this.observedBytes = size;
    this.validBytes = size - Buffer.byteLength(tail);
    this.torn = tail.length > 0;
  }

  get lastSequence(): number | undefined {
    this.refresh();
    return this.events[this.events.length - 1]?.seq;
  }

  after(cursor: number): readonly ProtocolEvent[] {
    this.refresh();
    if (!Number.isSafeInteger(cursor) || cursor < 0)
      throw new RangeError("Invalid event cursor");
    return this.events.slice(
      Math.max(0, cursor - (this.events[0]?.seq ?? 1) + 1),
    );
  }

  append(value: ProtocolEvent): void {
    if (this.failed)
      throw new Error(
        "Protocol recording is degraded; reopen the session before recording again",
      );
    const event = parseProtocolEvent(JSON.parse(JSON.stringify(value)));
    let lastSequence: number | undefined;
    try {
      lastSequence = this.lastSequence;
    } catch (error) {
      this.markFailed();
      throw error;
    }
    if (lastSequence !== undefined && event.seq !== lastSequence + 1)
      throw new Error("Event log sequence must be contiguous");
    let fd: number | undefined;
    try {
      fs.mkdirSync(path.dirname(this.filename), {
        recursive: true,
        mode: 0o700,
      });
      fd = fs.openSync(this.filename, "a", 0o600);
      if (this.torn) fs.ftruncateSync(fd, this.validBytes);
      const line = `${JSON.stringify(event)}\n`;
      fs.writeFileSync(fd, line);
      fs.fsyncSync(fd);
      this.validBytes += Buffer.byteLength(line);
      this.observedBytes = this.validBytes;
      this.torn = false;
      this.events.push(event);
      if (process.platform !== "win32") {
        const directoryFd = fs.openSync(path.dirname(this.filename), "r");
        try {
          fs.fsyncSync(directoryFd);
        } finally {
          fs.closeSync(directoryFd);
        }
      }
    } catch (error) {
      this.markFailed();
      throw error;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  private markFailed(): void {
    this.failed = true;
    try {
      fs.writeFileSync(`${this.filename}.gap`, "Protocol recording failed\n", {
        mode: 0o600,
        flag: "wx",
      });
    } catch {
      /* Preserve original failure. */
    }
  }
}
