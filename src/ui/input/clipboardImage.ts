import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { promisify } from "node:util";
import {
  encodeImageDataUrl,
  MAX_IMAGE_BYTES,
  validateImageBytes,
  type ImageReadFailureReason,
} from "./imagePaste.js";

const execFileAsync = promisify(execFile);

export type ClipboardImageFailureReason =
  ImageReadFailureReason | "unsupported_platform" | "no_image";

export type ClipboardImageResult =
  | {
      ok: true;
      data: string;
      mediaType: string;
      filename: string;
    }
  | { ok: false; reason: ClipboardImageFailureReason };

export interface ClipboardImageDeps {
  platform?: NodeJS.Platform;
  execFile?: typeof execFileAsync;
  commandExists?: (command: string) => boolean;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

/** Base64 expands raw image bytes by 4/3; subprocess stdout must fit encoded output. */
export const MAX_CLIPBOARD_SUBPROCESS_BYTES =
  Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4096;

const CLIPBOARD_PASTEBOARD_TYPES = [
  "public.png",
  "Apple PNG pasteboard type",
  "public.jpeg",
] as const;

export function buildOsascriptClipboardScript(
  pasteboardTypes: readonly string[] = CLIPBOARD_PASTEBOARD_TYPES,
): string {
  const typeList = pasteboardTypes.map((type) => `"${type}"`).join(", ");
  return String.raw`
use framework "AppKit"
use framework "Foundation"
set pb to current application's NSPasteboard's generalPasteboard()
set typeList to {${typeList}}
repeat with pasteboardType in typeList
  set imageData to pb's dataForType:pasteboardType
  if imageData is not missing value then
    set encoded to imageData's base64EncodedStringWithOptions:0
    return encoded as text
  end if
end repeat
return ""
`.trim();
}

function defaultCommandExists(command: string): boolean {
  const pathEntries = (process.env.PATH ?? "")
    .split(":")
    .filter((entry) => entry.length > 0);

  for (const directory of pathEntries) {
    try {
      fs.accessSync(`${directory}/${command}`, fs.constants.X_OK);
      return true;
    } catch {
      // continue
    }
  }

  return false;
}

function extensionForMediaType(mediaType: string): string {
  switch (mediaType) {
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default:
      return "png";
  }
}

export function encodeClipboardBytes(
  bytes: Buffer,
  mediaType: string,
  filename?: string,
): ClipboardImageResult {
  const validated = validateImageBytes(bytes);
  if (!validated.ok) {
    return validated;
  }

  const resolvedMediaType = mediaType || validated.mediaType;
  const resolvedFilename =
    filename ?? `clipboard.${extensionForMediaType(resolvedMediaType)}`;

  return {
    ok: true,
    data: encodeImageDataUrl(bytes, validated.mediaType),
    mediaType: validated.mediaType,
    filename: resolvedFilename,
  };
}

type SubprocessReadResult =
  { ok: true; stdout: Buffer } | { ok: false; maxBufferExceeded: boolean };

function decodeBase64Output(output: Buffer): Buffer | null {
  const asText = output.toString("utf8").trim();
  if (asText.length === 0) {
    return null;
  }

  try {
    return Buffer.from(asText, "base64");
  } catch {
    return null;
  }
}

async function runSubprocess(
  execFileImpl: typeof execFileAsync,
  command: string,
  args: readonly string[],
  timeoutMs: number,
  maxBuffer: number,
): Promise<SubprocessReadResult> {
  if (timeoutMs <= 0) {
    return { ok: false, maxBufferExceeded: false };
  }

  try {
    const { stdout } = await execFileImpl(command, [...args], {
      encoding: "buffer",
      maxBuffer,
      timeout: timeoutMs,
    });
    return { ok: true, stdout };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      maxBufferExceeded: code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
    };
  }
}

async function readViaOsascript(
  execFileImpl: typeof execFileAsync,
  timeoutMs: number,
): Promise<Buffer | "too_large" | null> {
  const result = await runSubprocess(
    execFileImpl,
    "osascript",
    ["-e", buildOsascriptClipboardScript()],
    timeoutMs,
    MAX_CLIPBOARD_SUBPROCESS_BYTES,
  );

  if (!result.ok) {
    return result.maxBufferExceeded ? "too_large" : null;
  }

  if (result.stdout.length === 0) {
    return null;
  }

  return decodeBase64Output(result.stdout);
}

async function readViaPngpaste(
  execFileImpl: typeof execFileAsync,
  timeoutMs: number,
): Promise<Buffer | "too_large" | null> {
  const result = await runSubprocess(
    execFileImpl,
    "pngpaste",
    ["-"],
    timeoutMs,
    MAX_IMAGE_BYTES + 1024,
  );

  if (!result.ok) {
    return result.maxBufferExceeded ? "too_large" : null;
  }

  return result.stdout.length > 0 ? result.stdout : null;
}

export async function readClipboardImageCandidates(
  execFileImpl: typeof execFileAsync,
  commandExists: (command: string) => boolean,
  deadlineMs: number,
): Promise<Array<Buffer | "too_large">> {
  const candidates: Array<Buffer | "too_large"> = [];
  const remainingTimeout = (): number => Math.max(0, deadlineMs - Date.now());

  const osascriptOutput = await readViaOsascript(
    execFileImpl,
    remainingTimeout(),
  );
  if (osascriptOutput === "too_large") {
    candidates.push("too_large");
    return candidates;
  }
  if (osascriptOutput) {
    candidates.push(osascriptOutput);
    return candidates;
  }

  if (commandExists("pngpaste") && remainingTimeout() > 0) {
    const pngpasteOutput = await readViaPngpaste(
      execFileImpl,
      remainingTimeout(),
    );
    if (pngpasteOutput === "too_large") {
      candidates.push("too_large");
    } else if (pngpasteOutput) {
      candidates.push(pngpasteOutput);
    }
  }

  return candidates;
}

export function validateClipboardCandidates(
  candidates: readonly (Buffer | "too_large")[],
): ClipboardImageResult {
  for (const candidate of candidates) {
    if (candidate === "too_large") {
      return { ok: false, reason: "too_large" };
    }

    const encoded = encodeClipboardBytes(candidate, "");
    if (encoded.ok) {
      return encoded;
    }

    if (
      encoded.reason === "too_large" ||
      encoded.reason === "unsupported_type"
    ) {
      return encoded;
    }
  }

  return { ok: false, reason: "no_image" };
}

export async function tryReadImageFromClipboard(
  deps: ClipboardImageDeps = {},
): Promise<ClipboardImageResult> {
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin") {
    return { ok: false, reason: "unsupported_platform" };
  }

  const execFileImpl = deps.execFile ?? execFileAsync;
  const commandExists = deps.commandExists ?? defaultCommandExists;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadlineMs = Date.now() + timeoutMs;

  const candidates = await readClipboardImageCandidates(
    execFileImpl,
    commandExists,
    deadlineMs,
  );
  return validateClipboardCandidates(candidates);
}
