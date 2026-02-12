import * as fs from "fs";
import * as path from "path";

/**
 * Discover AGENTS.md files by walking up the directory hierarchy.
 *
 * Searches for AGENTS.md files starting from the given directory and walking up
 * through parent directories to the filesystem root.
 *
 * @param startDir - Directory to start searching from (defaults to process.cwd())
 * @returns Array of absolute paths to AGENTS.md files, ordered from root-most to deepest
 */
export function discoverAgentsMdFiles(startDir?: string): string[] {
  const start = startDir || process.cwd();
  const found: string[] = [];
  let currentDir = path.resolve(start);

  // Walk up the directory tree until we reach the filesystem root
  while (true) {
    const agentsMdPath = path.join(currentDir, "AGENTS.md");

    if (fs.existsSync(agentsMdPath)) {
      found.push(agentsMdPath);
    }

    // Check if we've reached the filesystem root
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      // We're at the root (dirname of root is itself)
      break;
    }

    currentDir = parentDir;
  }

  // Reverse to get root-most to deepest order
  return found.reverse();
}

/**
 * Load and merge AGENTS.md file contents.
 *
 * Reads an ordered list of AGENTS.md file paths and returns their merged content
 * as a single string. Each file's content is preceded by a source attribution heading.
 *
 * @param filePaths - Array of absolute paths to AGENTS.md files, ordered root-to-leaf
 * @returns Concatenated content with source headings, or empty string if no files provided
 */
export function loadAgentsMdContent(filePaths: string[]): string {
  if (filePaths.length === 0) {
    return "";
  }

  const sections: string[] = [];

  for (const filePath of filePaths) {
    const content = fs.readFileSync(filePath, "utf-8");
    const heading = `## Project Instructions (from ${filePath})`;
    sections.push(`${heading}\n\n${content}`);
  }

  return sections.join("\n\n");
}

/**
 * Compose system prompt with AGENTS.md content.
 *
 * Combines AGENTS.md content with the default system prompt. If AGENTS.md content
 * is provided, it is prepended to the default prompt separated by two newlines.
 *
 * @param agentsMdContent - Content from AGENTS.md files (may be empty)
 * @param defaultPrompt - Default system prompt
 * @returns Composed system prompt
 */
export function composeSystemPrompt(
  agentsMdContent: string,
  defaultPrompt: string,
): string {
  if (!agentsMdContent) {
    return defaultPrompt;
  }

  return `${agentsMdContent}\n\n${defaultPrompt}`;
}
