import type { PromptImage } from "./promptSubmission.js";

export type PastedContent =
  | { id: number; type: "text"; content: string }
  | {
      id: number;
      type: "image";
      data: PromptImage;
      mediaType: string;
      filename: string;
      path?: string;
    };
