import {
  createPlainSubmission,
  HISTORY_INLINE_MAX,
  isImageOnlySubmission,
  isSubmissionEmpty,
  shouldPersistPromptHistory,
  stripAttachedImageMarkers,
} from "../promptSubmission.js";

describe("isSubmissionEmpty", () => {
  it("returns true when text and images are empty", () => {
    expect(isSubmissionEmpty(createPlainSubmission("   \n\t", "prompt"))).toBe(
      true,
    );
  });

  it("returns false when text has content", () => {
    expect(isSubmissionEmpty(createPlainSubmission("hello", "prompt"))).toBe(
      false,
    );
  });

  it("returns false for image-only submissions", () => {
    expect(
      isSubmissionEmpty({
        text: "   ",
        displayText: "[Image #1]",
        inputMode: "prompt",
        images: [new Uint8Array([1, 2, 3])],
      }),
    ).toBe(false);
  });
});

describe("isImageOnlySubmission", () => {
  it("returns true when images are present and text is empty", () => {
    expect(
      isImageOnlySubmission({
        text: "  ",
        displayText: "[Image #1]",
        inputMode: "prompt",
        images: [new Uint8Array([1])],
      }),
    ).toBe(true);
  });

  it("returns true when expanded text is only attachment markers", () => {
    expect(
      isImageOnlySubmission({
        text: "[Attached image: photo.png]",
        displayText: "[Image #1]",
        inputMode: "prompt",
        images: [new Uint8Array([1])],
      }),
    ).toBe(true);
  });

  it("returns false when images accompany user-authored text", () => {
    expect(
      isImageOnlySubmission({
        text: "check this [Attached image: photo.png]",
        displayText: "check this [Image #1]",
        inputMode: "prompt",
        images: [new Uint8Array([1])],
      }),
    ).toBe(false);
  });
});

describe("stripAttachedImageMarkers", () => {
  it("removes attachment markers and surrounding whitespace", () => {
    expect(
      stripAttachedImageMarkers(
        "  [Attached image: a.png] \n [Attached image: b.png]  ",
      ),
    ).toBe("");
  });
});

describe("shouldPersistPromptHistory", () => {
  it("skips image-only submissions even when marker text is under the inline cap", () => {
    expect(
      shouldPersistPromptHistory(
        {
          text: "[Attached image: photo.png]",
          displayText: "[Image #1]",
          inputMode: "prompt",
          images: [new Uint8Array([1])],
        },
        "chat",
      ),
    ).toBe(false);
  });

  it("persists chat submissions at HISTORY_INLINE_MAX", () => {
    const text = "x".repeat(HISTORY_INLINE_MAX);
    expect(
      shouldPersistPromptHistory(
        { text, displayText: text, inputMode: "prompt" },
        "chat",
      ),
    ).toBe(true);
  });

  it("skips chat submissions longer than HISTORY_INLINE_MAX", () => {
    const text = "x".repeat(HISTORY_INLINE_MAX + 1);
    expect(
      shouldPersistPromptHistory(
        { text, displayText: text, inputMode: "prompt" },
        "chat",
      ),
    ).toBe(false);
  });
});
