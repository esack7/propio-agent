export function findLastAssistantEntryIndex(
  entries: ReadonlyArray<{ readonly kind: string }>,
): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index].kind === "assistant") {
      return index;
    }
  }

  return -1;
}
