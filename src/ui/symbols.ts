// Unicode symbols for supported terminals
const unicodeSymbols = {
  prompt: "❯",
  bullet: "◆",
  success: "✔",
  error: "✖",
  ellipsis: "…",
};

// ASCII fallback symbols for limited terminals
const asciiSymbols = {
  prompt: ">",
  bullet: "*",
  success: "√",
  error: "x",
  ellipsis: "...",
};

// Detect if terminal supports Unicode symbols
const supportsUnicode = (): boolean => {
  // Windows doesn't support Unicode well by default
  if (process.platform === "win32") {
    return false;
  }

  // Dumb terminal doesn't support Unicode
  if (process.env.TERM === "dumb") {
    return false;
  }

  // All other platforms (macOS, Linux) with proper TERM support Unicode
  return true;
};

// Export the appropriate symbol set based on terminal capabilities
export const symbols = supportsUnicode() ? unicodeSymbols : asciiSymbols;
