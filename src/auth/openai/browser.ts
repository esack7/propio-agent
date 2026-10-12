import { spawn } from "node:child_process";

export async function openSystemBrowser(url: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "rundll32"
        : "xdg-open";
  const args =
    process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    const fail = () =>
      reject(
        new Error(
          "Could not open the system browser. Retry sign-in with --no-browser.",
        ),
      );
    child.once("error", fail);
    child.once("exit", (code) => (code === 0 ? resolve() : fail()));
  });
}

/** A returning manual sign-in never displays an ID token or email hint. */
export function safeManualAuthorizationUrl(value: string): string {
  const url = new URL(value);
  url.searchParams.delete("id_token_hint");
  url.searchParams.delete("login_hint");
  return url.href;
}
