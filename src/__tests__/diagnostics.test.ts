import { messageChars } from "../diagnostics.js";
import { TEST_PNG_DATA_URL } from "./testHelpers.js";
import type { ChatMessage } from "../providers/types.js";

function dataUrlPayloadChars(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.length - comma - 1 : dataUrl.length;
}

describe("diagnostics", () => {
  describe("messageChars", () => {
    it("should count only the base64 payload after the comma for data URL images", () => {
      const content = "See this image";
      const withImages: ChatMessage = {
        role: "user",
        content,
        images: [TEST_PNG_DATA_URL],
      };
      const payloadChars = dataUrlPayloadChars(TEST_PNG_DATA_URL);

      expect(messageChars(withImages)).toBe(content.length + payloadChars);
      expect(messageChars(withImages)).toBeLessThan(
        content.length + TEST_PNG_DATA_URL.length,
      );
      expect(payloadChars).toBeLessThan(TEST_PNG_DATA_URL.length);
    });

    it("should count Uint8Array image bytes", () => {
      const bytes = new Uint8Array([1, 2, 3, 4, 5]);
      const msg: ChatMessage = {
        role: "user",
        content: "x",
        images: [bytes],
      };

      expect(messageChars(msg)).toBe(1 + bytes.byteLength);
    });
  });
});
