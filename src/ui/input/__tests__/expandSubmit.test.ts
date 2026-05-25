import { expandPastedRefs } from "../expandSubmit.js";
import type { PastedContent } from "../pastedContent.js";
import {
  isImageOnlySubmission,
  shouldPersistPromptHistory,
} from "../promptSubmission.js";

function textEntry(id: number, content: string): PastedContent {
  return { id, type: "text", content };
}

function imageEntry(
  id: number,
  filename: string,
  data: Uint8Array = new Uint8Array([1]),
): PastedContent {
  return {
    id,
    type: "image",
    data,
    mediaType: "image/png",
    filename,
  };
}

describe("expandPastedRefs", () => {
  it("expands inline text pills", () => {
    const registry = new Map<number, PastedContent>([
      [1, textEntry(1, "full paste body")],
    ]);

    const submission = expandPastedRefs(
      "fix [Pasted text #1] please",
      registry,
      "prompt",
    );

    expect(submission.text).toBe("fix full paste body please");
    expect(submission.displayText).toBe("fix [Pasted text #1] please");
  });

  it("expands every identical text pill independently", () => {
    const registry = new Map<number, PastedContent>([
      [1, textEntry(1, "body")],
    ]);

    const submission = expandPastedRefs(
      "[Pasted text #1] and [Pasted text #1]",
      registry,
      "prompt",
    );

    expect(submission.text).toBe("body and body");
  });

  it("leaves unknown ids literal", () => {
    const submission = expandPastedRefs(
      "manual [Pasted text #99]",
      new Map(),
      "prompt",
    );

    expect(submission.text).toBe("manual [Pasted text #99]");
  });

  it("does not treat image pills with a line suffix as image tokens", () => {
    const registry = new Map<number, PastedContent>([
      [1, imageEntry(1, "photo.png")],
    ]);

    const submission = expandPastedRefs(
      "[Image #1 +2 lines]",
      registry,
      "prompt",
    );

    expect(submission.text).toBe("[Image #1 +2 lines]");
    expect(submission.images).toBeUndefined();
  });

  it("orders images by left-to-right token order", () => {
    const registry = new Map<number, PastedContent>([
      [1, imageEntry(1, "one.png", new Uint8Array([1]))],
      [2, imageEntry(2, "two.png", new Uint8Array([2]))],
    ]);

    const submission = expandPastedRefs(
      "[Image #2] then [Image #1]",
      registry,
      "prompt",
    );

    expect(submission.images).toEqual([
      new Uint8Array([2]),
      new Uint8Array([1]),
    ]);
    expect(submission.text).toBe(
      "[Attached image: two.png] then [Attached image: one.png]",
    );
  });

  it("marks a lone expanded image pill as image-only for history policy", () => {
    const registry = new Map<number, PastedContent>([
      [1, imageEntry(1, "photo.png")],
    ]);

    const submission = expandPastedRefs("[Image #1]", registry, "prompt");

    expect(submission.text).toBe("[Attached image: photo.png]");
    expect(isImageOnlySubmission(submission)).toBe(true);
    expect(shouldPersistPromptHistory(submission, "chat")).toBe(false);
  });
});
