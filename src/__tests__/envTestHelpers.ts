/** Clear IS_SANDBOX before a test; returns the prior value for restoreSandboxEnv. */
export function clearSandboxEnvForTest(): string | undefined {
  const previous = process.env.IS_SANDBOX;
  delete process.env.IS_SANDBOX;
  return previous;
}

export function restoreSandboxEnv(previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env.IS_SANDBOX;
  } else {
    process.env.IS_SANDBOX = previous;
  }
}
