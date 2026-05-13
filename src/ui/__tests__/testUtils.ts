import type { OperationSpinner } from "../spinner.js";

export function createMockStream(
  isTTY = true,
): NodeJS.WriteStream & { chunks: string[] } {
  const chunks: string[] = [];

  return {
    chunks,
    columns: 80,
    isTTY,
    write: (chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    },
  } as unknown as NodeJS.WriteStream & { chunks: string[] };
}

export function createMockSpinner() {
  const spinner = {
    start: jest.fn(),
    setPhase: jest.fn(),
    setText: jest.fn(),
    succeed: jest.fn(),
    fail: jest.fn(),
    stop: jest.fn(),
  };

  const createSpinner = jest.fn(() => spinner as unknown as OperationSpinner);
  return { spinner, createSpinner };
}