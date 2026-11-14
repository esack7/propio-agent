import type { DisplayState } from "./toolDisplay/render.js";
type LiveLine = NonNullable<DisplayState["liveOutput"]>[number];
/** A bounded tail in arrival order, including unfinished lines. */
export function appendLiveOutput(
  previous: readonly LiveLine[],
  stream: "stdout" | "stderr",
  text: string,
): LiveLine[] {
  const lines = [...previous];
  const parts = text.split("\n");
  for (let i = 0; i < parts.length; i++) {
    if (i === parts.length - 1 && parts[i] === "") break;
    const last = lines[lines.length - 1];
    const prefix =
      last?.open && last.stream === stream ? lines.pop()!.text : "";
    const combined = (prefix + parts[i]).slice(-4096);
    const safe = /^[\uDC00-\uDFFF]/.test(combined)
      ? combined.slice(1)
      : combined;
    lines.push({ stream, text: safe, open: i === parts.length - 1 });
    if (lines.length > 5) lines.shift();
  }
  return lines;
}
