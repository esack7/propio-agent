import {
  compileSystemPrompt,
  joinSections,
} from "./prompt/compileSystemPrompt.js";
import { buildEmptySystemPromptContext } from "./prompt/systemPromptContext.js";

const defaultCompiled = compileSystemPrompt(buildEmptySystemPromptContext());

/** Full default system prompt core (blocks 1–5) for CLI and backward compatibility. */
export const defaultSystemPrompt = joinSections(defaultCompiled.compiled);
