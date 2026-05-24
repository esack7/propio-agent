import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export type ImageReadFailureReason =
  | "missing"
  | "not_file"
  | "read_error"
  | "too_large"
  | "unsupported_type"
  | "invalid_bytes";

export type ImageReadResult =
  | {
      ok: true;
      data: string;
      mediaType: string;
      filename: string;
      path: string;
    }
  | { ok: false; reason: ImageReadFailureReason };

const EXTENSION_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

const READABLE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

export function buildImagePastePill(id: number): string {
  return `[Image #${id}]`;
}

export function imagePasteFailureMessage(
  reason: ImageReadFailureReason,
): string {
  switch (reason) {
    case "missing":
      return "Image file not found.";
    case "not_file":
      return "Image path is not a file.";
    case "read_error":
      return "Could not read image file.";
    case "too_large":
      return `Image exceeds ${MAX_IMAGE_BYTES / (1024 * 1024)} MiB limit.`;
    case "unsupported_type":
      return "BMP is not supported — convert to PNG or JPEG.";
    case "invalid_bytes":
      return "File does not look like a supported image.";
    default:
      return "Could not attach image.";
  }
}

export function normalizeDroppedPath(filePath: string): string {
  const trimmed = filePath.trim();
  if (trimmed === "~") {
    return os.homedir();
  }
  if (trimmed.startsWith("~/")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return path.resolve(trimmed);
}

function extensionForPath(filePath: string): string {
  return path.extname(filePath).toLowerCase();
}

function mediaTypeFromExtension(ext: string): string | undefined {
  return EXTENSION_MEDIA_TYPES[ext];
}

type MediaSignature = {
  mediaType: string;
  minLength: number;
  byteRuns: ReadonlyArray<{ offset: number; bytes: readonly number[] }>;
};

const MEDIA_SIGNATURES: readonly MediaSignature[] = [
  {
    mediaType: "image/png",
    minLength: 8,
    byteRuns: [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47] }],
  },
  {
    mediaType: "image/jpeg",
    minLength: 3,
    byteRuns: [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }],
  },
  {
    mediaType: "image/gif",
    minLength: 6,
    byteRuns: [{ offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] }],
  },
  {
    mediaType: "image/webp",
    minLength: 12,
    byteRuns: [
      { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
      { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
    ],
  },
];

function byteRunMatches(
  bytes: Buffer,
  offset: number,
  expected: readonly number[],
): boolean {
  return expected.every((byte, index) => bytes[offset + index] === byte);
}

function matchesMediaSignature(
  bytes: Buffer,
  signature: MediaSignature,
): boolean {
  return (
    bytes.length >= signature.minLength &&
    signature.byteRuns.every((run) =>
      byteRunMatches(bytes, run.offset, run.bytes),
    )
  );
}

function sniffMediaType(bytes: Buffer): string | null {
  return (
    MEDIA_SIGNATURES.find((signature) =>
      matchesMediaSignature(bytes, signature),
    )?.mediaType ?? null
  );
}

export function encodeImageDataUrl(bytes: Buffer, mediaType: string): string {
  return `data:${mediaType};base64,${bytes.toString("base64")}`;
}

export function validateImageBytes(
  bytes: Buffer,
):
  | { ok: true; mediaType: string }
  | { ok: false; reason: ImageReadFailureReason } {
  if (bytes.length > MAX_IMAGE_BYTES) {
    return { ok: false, reason: "too_large" };
  }

  const sniffed = sniffMediaType(bytes);
  if (!sniffed) {
    if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
      return { ok: false, reason: "unsupported_type" };
    }
    return { ok: false, reason: "invalid_bytes" };
  }

  return { ok: true, mediaType: sniffed };
}

export async function tryReadImageFromPath(
  filePath: string,
): Promise<ImageReadResult> {
  const normalizedPath = normalizeDroppedPath(filePath);
  const extension = extensionForPath(normalizedPath);

  if (extension === ".bmp") {
    return { ok: false, reason: "unsupported_type" };
  }

  if (!READABLE_EXTENSIONS.has(extension)) {
    return { ok: false, reason: "unsupported_type" };
  }

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(normalizedPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { ok: false, reason: "missing" };
    }
    return { ok: false, reason: "read_error" };
  }

  if (!stat.isFile()) {
    return { ok: false, reason: "not_file" };
  }

  if (stat.size > MAX_IMAGE_BYTES) {
    return { ok: false, reason: "too_large" };
  }

  let bytes: Buffer;
  try {
    bytes = await fs.readFile(normalizedPath);
  } catch {
    return { ok: false, reason: "read_error" };
  }

  const sniffed = sniffMediaType(bytes);
  const expected = mediaTypeFromExtension(extension);
  if (!sniffed || !expected || sniffed !== expected) {
    return { ok: false, reason: "invalid_bytes" };
  }

  const data = encodeImageDataUrl(bytes, expected);
  return {
    ok: true,
    data,
    mediaType: expected,
    filename: path.basename(normalizedPath),
    path: normalizedPath,
  };
}
