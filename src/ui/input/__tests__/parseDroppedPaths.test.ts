import * as os from "node:os";
import * as path from "node:path";
import { normalizeDroppedPath } from "../imagePaste.js";
import {
  classifyDroppedText,
  isImagePath,
  parseDroppedPathsLine,
} from "../parseDroppedPaths.js";

describe("parseDroppedPaths", () => {
  describe("isImagePath", () => {
    it("recognizes common image extensions including bmp", () => {
      expect(isImagePath("/tmp/photo.PNG")).toBe(true);
      expect(isImagePath("/tmp/photo.jpg")).toBe(true);
      expect(isImagePath("/tmp/photo.bmp")).toBe(true);
      expect(isImagePath("/tmp/doc.txt")).toBe(false);
    });
  });

  describe("parseDroppedPathsLine", () => {
    it("rejects path plus trailing prose on the same line", () => {
      expect(parseDroppedPathsLine("/tmp/a.png notes")).toEqual({
        ok: false,
        paths: ["/tmp/a.png"],
      });
    });

    it("parses quoted paths with spaces", () => {
      expect(parseDroppedPathsLine("'/path/with spaces.png'")).toEqual({
        ok: true,
        paths: ["/path/with spaces.png"],
      });
    });

    it("rejects quoted bare filenames that are not path-shaped", () => {
      expect(parseDroppedPathsLine('"photo.png"')).toEqual({
        ok: false,
        paths: [],
      });
    });

    it("accepts quoted relative paths", () => {
      expect(parseDroppedPathsLine('"./photo.png"')).toEqual({
        ok: true,
        paths: ["./photo.png"],
      });
    });

    it("parses multiple paths on one line", () => {
      expect(parseDroppedPathsLine("/tmp/a.png /tmp/b.jpg")).toEqual({
        ok: true,
        paths: ["/tmp/a.png", "/tmp/b.jpg"],
      });
    });

    it("parses file URLs with percent encoding", () => {
      expect(parseDroppedPathsLine("file:///tmp/a%20b.png")).toEqual({
        ok: true,
        paths: ["/tmp/a b.png"],
      });
    });

    it("parses Windows quoted paths with spaces", () => {
      expect(parseDroppedPathsLine('"C:\\path with spaces\\a.jpg"')).toEqual({
        ok: true,
        paths: ["C:\\path with spaces\\a.jpg"],
      });
    });

    it("strips trailing carriage returns", () => {
      expect(parseDroppedPathsLine("/tmp/a.png\r")).toEqual({
        ok: true,
        paths: ["/tmp/a.png"],
      });
    });

    it("parses backslash-escaped spaces in unquoted paths", () => {
      expect(parseDroppedPathsLine("/tmp/with\\ space.png")).toEqual({
        ok: true,
        paths: ["/tmp/with space.png"],
      });
    });
  });

  describe("classifyDroppedText", () => {
    it("parses file URLs and bare paths", () => {
      const result = classifyDroppedText("file:///tmp/a.png\n/Users/me/b.jpg");
      expect(result.paths).toEqual(["/tmp/a.png", "/Users/me/b.jpg"]);
      expect(result.allNonEmptyLinesArePaths).toBe(true);
    });

    it("marks prose when any line is not a path", () => {
      const result = classifyDroppedText("/tmp/a.png\nhello world");
      expect(result.paths).toEqual(["/tmp/a.png"]);
      expect(result.allNonEmptyLinesArePaths).toBe(false);
    });

    it("treats malformed file URLs as prose without throwing", () => {
      const result = classifyDroppedText("file://[invalid");
      expect(result.paths).toEqual([]);
      expect(result.allNonEmptyLinesArePaths).toBe(false);
    });

    it("accepts Windows drive paths", () => {
      const result = classifyDroppedText("C:\\Users\\me\\pic.png");
      expect(result.paths).toEqual(["C:\\Users\\me\\pic.png"]);
      expect(result.allNonEmptyLinesArePaths).toBe(true);
    });

    it("returns false when one line has path plus prose", () => {
      const result = classifyDroppedText("/tmp/a.png\n/tmp/b.jpg notes");
      expect(result.allNonEmptyLinesArePaths).toBe(false);
    });
  });
});

describe("normalizeDroppedPath", () => {
  it("expands tilde paths under the home directory", () => {
    expect(normalizeDroppedPath("~/x.png")).toBe(
      path.join(os.homedir(), "x.png"),
    );
  });
});
