/** True when running inside the propio sandbox container. */
export function isSandboxMode(): boolean {
  return process.env.IS_SANDBOX === "true";
}
