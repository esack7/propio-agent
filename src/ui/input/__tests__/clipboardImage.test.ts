import {
  buildOsascriptClipboardScript,
  encodeClipboardBytes,
  MAX_CLIPBOARD_SUBPROCESS_BYTES,
  readClipboardImageCandidates,
  tryReadImageFromClipboard,
  validateClipboardCandidates,
} from "../clipboardImage.js";
import { MAX_IMAGE_BYTES } from "../imagePaste.js";

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x00]);

function pngLikeBuffer(byteLength: number): Buffer {
  const bytes = Buffer.alloc(byteLength, 0x00);
  bytes[0] = 0x89;
  bytes[1] = 0x50;
  bytes[2] = 0x4e;
  bytes[3] = 0x47;
  bytes[4] = 0x0d;
  bytes[5] = 0x0a;
  bytes[6] = 0x1a;
  bytes[7] = 0x0a;
  return bytes;
}

function createOsascriptBase64ExecFile(bytes: Buffer) {
  return jest.fn(async (command: string) => {
    if (command === "osascript") {
      return { stdout: Buffer.from(bytes.toString("base64"), "utf8") };
    }
    return { stdout: Buffer.alloc(0) };
  });
}

function readDarwinClipboard(
  execFile: Parameters<typeof tryReadImageFromClipboard>[0]["execFile"],
  commandExists: (command: string) => boolean = () => false,
) {
  return tryReadImageFromClipboard({
    platform: "darwin",
    execFile,
    commandExists,
  });
}

describe("buildOsascriptClipboardScript", () => {
  it("encodes clipboard data via the NSData instance method", () => {
    const script = buildOsascriptClipboardScript();

    expect(script).toContain(
      "set encoded to imageData's base64EncodedStringWithOptions:0",
    );
    expect(script).not.toContain(
      "NSData's base64EncodedStringWithOptions:imageData",
    );
  });
});

describe("encodeClipboardBytes", () => {
  it("encodes supported image types as data URLs", () => {
    const result = encodeClipboardBytes(PNG_BYTES, "image/png", "clip.png");
    expect(result).toEqual({
      ok: true,
      data: expect.stringMatching(/^data:image\/png;base64,/),
      mediaType: "image/png",
      filename: "clip.png",
    });
  });

  it("rejects images larger than MAX_IMAGE_BYTES", () => {
    const tooLarge = pngLikeBuffer(MAX_IMAGE_BYTES + 1);

    expect(encodeClipboardBytes(tooLarge, "image/png")).toEqual({
      ok: false,
      reason: "too_large",
    });
  });

  it("rejects unsupported BMP bytes", () => {
    const bmp = Buffer.from([0x42, 0x4d, 0x00, 0x00]);
    expect(encodeClipboardBytes(bmp, "image/bmp")).toEqual({
      ok: false,
      reason: "unsupported_type",
    });
  });
});

describe("validateClipboardCandidates", () => {
  it("returns too_large for oversized decoded candidates", () => {
    expect(
      validateClipboardCandidates([pngLikeBuffer(MAX_IMAGE_BYTES + 1)]),
    ).toEqual({ ok: false, reason: "too_large" });
  });

  it("returns too_large when subprocess output exceeded the base64 buffer cap", () => {
    expect(validateClipboardCandidates(["too_large"])).toEqual({
      ok: false,
      reason: "too_large",
    });
  });
});

describe("readClipboardImageCandidates", () => {
  it("uses a single osascript subprocess before pngpaste fallback", async () => {
    const execFile = jest.fn(async (command: string) => {
      if (command === "osascript") {
        return { stdout: Buffer.alloc(0) };
      }
      if (command === "pngpaste") {
        return { stdout: PNG_BYTES };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const deadlineMs = Date.now() + 1000;
    const candidates = await readClipboardImageCandidates(
      execFile as never,
      (command) => command === "pngpaste",
      deadlineMs,
    );

    expect(execFile).toHaveBeenCalledTimes(2);
    expect(execFile.mock.calls[0]?.[0]).toBe("osascript");
    expect(execFile.mock.calls[1]?.[0]).toBe("pngpaste");
    expect(candidates).toEqual([PNG_BYTES]);
  });
});

describe("tryReadImageFromClipboard", () => {
  it("returns unsupported_platform on non-darwin", async () => {
    await expect(
      tryReadImageFromClipboard({ platform: "linux" }),
    ).resolves.toEqual({ ok: false, reason: "unsupported_platform" });
  });

  it("returns no_image when subprocesses yield nothing", async () => {
    const execFile = jest.fn(async () => ({ stdout: Buffer.alloc(0) }));

    await expect(
      tryReadImageFromClipboard({
        platform: "darwin",
        execFile: execFile as never,
        commandExists: () => false,
      }),
    ).resolves.toEqual({ ok: false, reason: "no_image" });
  });

  it("decodes PNG base64 from a single osascript subprocess", async () => {
    const execFile = createOsascriptBase64ExecFile(PNG_BYTES);

    await expect(readDarwinClipboard(execFile as never)).resolves.toMatchObject(
      {
        ok: true,
        mediaType: "image/png",
        filename: "clipboard.png",
      },
    );
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("accepts base64 output larger than raw MAX_IMAGE_BYTES but within subprocess cap", async () => {
    const rawBytes = pngLikeBuffer(7 * 1024 * 1024);
    const base64Output = rawBytes.toString("base64");
    expect(base64Output.length).toBeGreaterThan(MAX_IMAGE_BYTES + 1024);
    expect(base64Output.length).toBeLessThanOrEqual(
      MAX_CLIPBOARD_SUBPROCESS_BYTES,
    );

    const execFile = createOsascriptBase64ExecFile(rawBytes);

    await expect(readDarwinClipboard(execFile as never)).resolves.toMatchObject(
      {
        ok: true,
        mediaType: "image/png",
      },
    );
  });

  it("returns too_large when decoded clipboard bytes exceed MAX_IMAGE_BYTES", async () => {
    const rawBytes = pngLikeBuffer(MAX_IMAGE_BYTES + 1);
    const execFile = createOsascriptBase64ExecFile(rawBytes);

    await expect(readDarwinClipboard(execFile as never)).resolves.toEqual({
      ok: false,
      reason: "too_large",
    });
  });

  it("returns too_large when osascript stdout exceeds the base64 subprocess cap", async () => {
    const execFile = jest.fn(async () => {
      const error = new Error("maxBuffer exceeded") as NodeJS.ErrnoException;
      error.code = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
      throw error;
    });

    await expect(
      tryReadImageFromClipboard({
        platform: "darwin",
        execFile: execFile as never,
        commandExists: () => false,
      }),
    ).resolves.toEqual({ ok: false, reason: "too_large" });
  });

  it("falls back to pngpaste when osascript has no image", async () => {
    const execFile = jest.fn(async (command: string) => {
      if (command === "pngpaste") {
        return { stdout: PNG_BYTES };
      }
      return { stdout: Buffer.alloc(0) };
    });

    await expect(
      readDarwinClipboard(
        execFile as never,
        (command) => command === "pngpaste",
      ),
    ).resolves.toMatchObject({ ok: true, mediaType: "image/png" });
  });

  it("returns gracefully when subprocesses fail", async () => {
    const execFile = jest.fn(async () => {
      throw new Error("spawn failed");
    });

    await expect(
      tryReadImageFromClipboard({
        platform: "darwin",
        execFile: execFile as never,
        commandExists: () => false,
      }),
    ).resolves.toEqual({ ok: false, reason: "no_image" });
  });

  it("respects a total clipboard-read deadline across subprocesses", async () => {
    jest.useFakeTimers();
    const execFile = jest.fn(
      (_command: string, _args: string[], options: { timeout?: number }) =>
        new Promise<{ stdout: Buffer }>((_resolve, reject) => {
          const delayMs = options.timeout ?? 0;
          setTimeout(() => {
            const error = new Error("timeout") as NodeJS.ErrnoException;
            error.code = "ETIMEDOUT";
            reject(error);
          }, delayMs);
        }),
    );

    const readPromise = tryReadImageFromClipboard({
      platform: "darwin",
      execFile: execFile as never,
      commandExists: (command) => command === "pngpaste",
      timeoutMs: 50,
    });

    await jest.advanceTimersByTimeAsync(60);
    await expect(readPromise).resolves.toEqual({
      ok: false,
      reason: "no_image",
    });
    expect(execFile.mock.calls.length).toBeLessThanOrEqual(2);

    jest.useRealTimers();
  });

  it("supports JPEG clipboard bytes from osascript", async () => {
    const execFile = createOsascriptBase64ExecFile(JPEG_BYTES);

    await expect(readDarwinClipboard(execFile as never)).resolves.toMatchObject(
      {
        ok: true,
        mediaType: "image/jpeg",
        filename: "clipboard.jpg",
      },
    );
  });
});
