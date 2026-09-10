/** Provider-ready input. UI buffer state and input modes belong to the consumer. */
export type PromptImage = Uint8Array | string;
export interface PromptSubmission {
  readonly text: string;
  readonly images?: PromptImage[];
}
