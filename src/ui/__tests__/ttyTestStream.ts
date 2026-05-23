import * as readline from "readline";
import { EventEmitter } from "events";
import { PassThrough } from "stream";

export type TtyInputStream = PassThrough & {
  isTTY: boolean;
  setRawMode: jest.Mock;
  pause: jest.Mock;
  resume: jest.Mock;
};

export function createTtyInputStream(): TtyInputStream {
  const inputStream = new PassThrough() as TtyInputStream;
  inputStream.isTTY = true;
  inputStream.setRawMode = jest.fn();
  inputStream.pause = jest.fn();
  inputStream.resume = jest.fn();
  return inputStream;
}

export function withKeypressEvents(inputStream: PassThrough): TtyInputStream {
  readline.emitKeypressEvents(inputStream);
  return inputStream as TtyInputStream;
}

export function createTtyTestStream(
  isTTY = true,
  columns = 80,
): NodeJS.WriteStream & { chunks: string[] } {
  const chunks: string[] = [];
  const emitter = new EventEmitter();

  return {
    chunks,
    columns,
    isTTY,
    write: (chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf-8"));
      return true;
    },
    cursorTo: () => true,
    clearLine: () => true,
    moveCursor: () => true,
    clearScreenDown: () => true,
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    removeListener: emitter.removeListener.bind(emitter),
    emit: emitter.emit.bind(emitter),
  } as unknown as NodeJS.WriteStream & { chunks: string[] };
}

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}
