import { utf8Tail } from "../tools/display.js";
import type { DisplayState } from "./toolDisplay/render.js";
type LiveLine = NonNullable<DisplayState["liveOutput"]>[number];
/** Five recent lines, with an unfinished line tracked independently per stream. */
export function appendLiveOutput(
  previous: readonly LiveLine[],
  stream: "stdout" | "stderr",
  text: string,
): LiveLine[] {
  const all = text.split("\n");
  const parts = all.slice(-6);
  // Skipped parts already ended this stream's partial line. The retained
  // suffix starts a new line, so it must not join the old fragment.
  const lines = previous.filter(
    (line) =>
      all.length === parts.length || line.stream !== stream || !line.open,
  );
  for (let i = 0; i < parts.length; i++) {
    const closed = i < parts.length - 1;
    const part = parts[i]!;
    if (!closed && !part) break;
    const index = lines.findIndex(
      (line) => line.stream === stream && line.open,
    );
    const earlier = index < 0 ? undefined : lines[index];
    const current = progressLine(earlier, part, closed);
    if (index >= 0) lines[index] = { stream, ...current };
    else lines.push({ stream, ...current });
    if (lines.length > 5) lines.shift();
  }
  return lines;
}
function progressLine(
  earlier: LiveLine | undefined,
  part: string,
  closed: boolean,
) {
  // A trailing CR waits: LF closes the existing line; text replaces it.
  const trailingCR = part.endsWith("\r");
  const content = trailingCR ? part.slice(0, -1) : part;
  const cr = content.lastIndexOf("\r");
  const prefix =
    earlier?.replacePending && content ? "" : (earlier?.text ?? "");
  const text = cr >= 0 ? content.slice(cr + 1) : prefix + content;
  return {
    text: utf8Tail(text, 4096),
    open: !closed,
    replacePending: !closed && trailingCR,
  };
}
