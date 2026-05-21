import {
  DEFAULT_CORE_IDENTITY,
  formatRuntimeEnvironmentSection,
  formatRuntimeOverflowBlock,
} from "./systemPromptSections.js";
import {
  SYSTEM_PROMPT_ENV_MAX_CHARS,
  type SystemPromptContext,
} from "./systemPromptContext.js";
import { SystemPromptSectionRegistry } from "./systemPromptSectionRegistry.js";

export type SystemPromptSectionId =
  | "coreIdentity"
  | "agentsMd"
  | "toolUtilization"
  | "responseFormatting"
  | "runtimeEnvironment";

export interface CompiledSystemPrompt {
  readonly sections: ReadonlyArray<{
    id: SystemPromptSectionId;
    content: string;
  }>;
}

export interface CompileSystemPromptOptions {
  agentsMdContent?: string;
  baseRules?: string;
}

export interface CompileSystemPromptResult {
  readonly compiled: CompiledSystemPrompt;
  readonly runtimeContextOverflowBlock?: string;
}

export { DEFAULT_CORE_IDENTITY };

const SECTION_ORDER: readonly SystemPromptSectionId[] = [
  "coreIdentity",
  "agentsMd",
  "toolUtilization",
  "responseFormatting",
  "runtimeEnvironment",
];

const OVERFLOW_POINTER =
  "\n\nDetailed runtime context follows in the overflow block below.";

function resolveRuntimeSection(ctx: SystemPromptContext): {
  section: string;
  overflowBlock?: string;
} {
  const full = formatRuntimeEnvironmentSection(ctx, {
    includeGitDetails: true,
    toolListMode: "full",
  });
  if (full.length <= SYSTEM_PROMPT_ENV_MAX_CHARS) {
    return { section: full };
  }

  const overflowBlock = formatRuntimeOverflowBlock(ctx);

  const withoutGit = formatRuntimeEnvironmentSection(ctx, {
    includeGitDetails: false,
    toolListMode: "full",
  });
  const withGitPointer = withoutGit + OVERFLOW_POINTER;
  if (withGitPointer.length <= SYSTEM_PROMPT_ENV_MAX_CHARS) {
    return { section: withGitPointer, overflowBlock };
  }

  const summarizedTools = formatRuntimeEnvironmentSection(ctx, {
    includeGitDetails: false,
    toolListMode: "summary",
  });
  const withToolPointer = summarizedTools + OVERFLOW_POINTER;
  if (withToolPointer.length <= SYSTEM_PROMPT_ENV_MAX_CHARS) {
    return { section: withToolPointer, overflowBlock };
  }

  const minimal = formatRuntimeEnvironmentSection(ctx, {
    includeGitDetails: false,
    toolListMode: "omit",
  });
  const section =
    (minimal + OVERFLOW_POINTER).length <= SYSTEM_PROMPT_ENV_MAX_CHARS
      ? minimal + OVERFLOW_POINTER
      : minimal.slice(
          0,
          Math.max(0, SYSTEM_PROMPT_ENV_MAX_CHARS - OVERFLOW_POINTER.length),
        ) + OVERFLOW_POINTER;

  return { section, overflowBlock };
}

export function compileSystemPrompt(
  ctx: SystemPromptContext,
  options: CompileSystemPromptOptions = {},
  registry: SystemPromptSectionRegistry = new SystemPromptSectionRegistry(),
): CompileSystemPromptResult {
  const baseRules = options.baseRules ?? DEFAULT_CORE_IDENTITY;
  const agentsMdContent = options.agentsMdContent ?? "";

  const coreIdentity = registry.getCoreIdentity(baseRules);
  const agentsMd =
    agentsMdContent.trim().length > 0
      ? registry.getAgentsMd(agentsMdContent)
      : undefined;
  const toolUtilization = registry.getToolUtilization();
  const responseFormatting = registry.getResponseFormatting();
  const { section: runtimeEnvironment, overflowBlock } =
    resolveRuntimeSection(ctx);
  registry.setRuntimeEnvironment(runtimeEnvironment);

  const sectionMap = new Map<SystemPromptSectionId, string>([
    ["coreIdentity", coreIdentity],
    ["toolUtilization", toolUtilization],
    ["responseFormatting", responseFormatting],
    ["runtimeEnvironment", runtimeEnvironment],
  ]);
  if (agentsMd) {
    sectionMap.set("agentsMd", agentsMd);
  }

  const sections = SECTION_ORDER.filter((id) => sectionMap.has(id)).map(
    (id) => ({
      id,
      content: sectionMap.get(id)!,
    }),
  );

  return {
    compiled: { sections },
    runtimeContextOverflowBlock: overflowBlock,
  };
}

export function joinSections(compiled: CompiledSystemPrompt): string {
  return compiled.sections.map((s) => s.content).join("\n\n");
}
