/**
 * Characters that can change what a terminal shows rather than being shown:
 * C0 and C1 controls and DEL (escape sequences, carriage returns, backspace),
 * and invisible or direction-changing formatting characters.
 */
const HIDDEN_CHARACTER =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/gu;

const NAMED_ESCAPES: Readonly<Record<string, string>> = {
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

/**
 * Render untrusted text so the operator sees every character: a hidden one
 * becomes a visible escape such as `\x1b` or `\u202e`. Backslashes are
 * doubled first, so text that already reads `\x1b` cannot pass for one.
 */
export function visibleText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(HIDDEN_CHARACTER, (character) => {
    const named = NAMED_ESCAPES[character];
    if (named) return named;
    const code = character.charCodeAt(0);
    return code <= 0xff
      ? `\\x${code.toString(16).padStart(2, "0")}`
      : `\\u${code.toString(16).padStart(4, "0")}`;
  });
}
