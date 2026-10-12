import type { ProviderConfig } from "@propio-ai/providers";
import { subscriptionAccountId } from "../auth/openai/runtime.js";

/** Every UI path asks before clearing or transferring an account-bound transcript. */
export async function chooseTranscriptTransfer(
  ask: (prompt: string) => Promise<string | null>,
  info: (message: string) => void,
  previousAccountId: string | undefined,
  destination: ProviderConfig,
): Promise<boolean | null> {
  const nextAccountId = subscriptionAccountId(destination);
  if (previousAccountId === nextAccountId) return false;
  info(
    `Changing access to ${destination.name} starts a new conversation. Transfer sends readable history to this destination and removes incompatible provider continuation.`,
  );
  while (true) {
    const choice = (
      await ask("1: New conversation, 2: Transfer transcript, blank: cancel: ")
    )?.trim();
    if (!choice) return null;
    if (choice === "1") return false;
    if (choice === "2") return true;
    info("Choose 1 or 2, or cancel.");
  }
}
