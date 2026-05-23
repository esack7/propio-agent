import { classifyDroppedText, isImagePath } from "../parseDroppedPaths.js";

describe("parseDroppedPaths", () => {
  describe("isImagePath", () => {
    it("recognizes common image extensions", () => {
      expect(isImagePath("/tmp/photo.PNG")).toBe(true);
      expect(isImagePath("/tmp/photo.jpg")).toBe(true);
      expect(isImagePath("/tmp/doc.txt")).toBe(false);
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
  });
});
