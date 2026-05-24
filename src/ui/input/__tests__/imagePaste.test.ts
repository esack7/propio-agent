import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MAX_IMAGE_BYTES, tryReadImageFromPath } from "../imagePaste.js";

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

async function writeTempFile(
  dir: string,
  name: string,
  bytes: Buffer,
): Promise<string> {
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, bytes);
  return filePath;
}

describe("tryReadImageFromPath", () => {
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "propio-image-paste-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("reads a small PNG as a data URL", async () => {
    const filePath = await writeTempFile(tempDir, "a.png", PNG_BYTES);
    const result = await tryReadImageFromPath(filePath);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.startsWith("data:image/png;base64,")).toBe(true);
      expect(result.mediaType).toBe("image/png");
    }
  });

  it("reads a JPEG with image/jpeg in the data URL", async () => {
    const filePath = await writeTempFile(tempDir, "a.jpg", JPEG_BYTES);
    const result = await tryReadImageFromPath(filePath);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.startsWith("data:image/jpeg;base64,")).toBe(true);
      expect(result.mediaType).toBe("image/jpeg");
    }
  });

  it("rejects files over the size limit", async () => {
    const huge = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    huge.set(PNG_BYTES);
    const filePath = await writeTempFile(tempDir, "large.png", huge);

    const result = await tryReadImageFromPath(filePath);
    expect(result).toEqual({ ok: false, reason: "too_large" });
  });

  it("rejects bmp with unsupported_type", async () => {
    const filePath = await writeTempFile(tempDir, "a.bmp", Buffer.from("BM"));
    const result = await tryReadImageFromPath(filePath);
    expect(result).toEqual({ ok: false, reason: "unsupported_type" });
  });

  it("rejects bytes that do not match the extension", async () => {
    const filePath = await writeTempFile(tempDir, "bad.png", JPEG_BYTES);
    const result = await tryReadImageFromPath(filePath);
    expect(result).toEqual({ ok: false, reason: "invalid_bytes" });
  });

  it("returns missing for ENOENT paths", async () => {
    const result = await tryReadImageFromPath(
      path.join(tempDir, "missing.png"),
    );
    expect(result).toEqual({ ok: false, reason: "missing" });
  });

  it("returns not_file for directories", async () => {
    const dirPath = path.join(tempDir, "folder.png");
    await fs.mkdir(dirPath);
    const result = await tryReadImageFromPath(dirPath);
    expect(result).toEqual({ ok: false, reason: "not_file" });
  });
});
