import {
  getAgentsMdSection,
  getCoreIdentitySection,
  getResponseFormattingSection,
  getToolUtilizationSection,
} from "./systemPromptSections.js";

function hashContent(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    hash = (hash * 31 + content.charCodeAt(i)) | 0;
  }
  return String(hash);
}

export class SystemPromptSectionRegistry {
  private coreIdentityCache = new Map<string, string>();
  private agentsMdCache = new Map<string, string>();
  private toolUtilizationCache: string | null = null;
  private responseFormattingCache: string | null = null;
  private lastRuntimeEnvironment: string | null = null;

  getCoreIdentity(baseRules: string): string {
    const cached = this.coreIdentityCache.get(baseRules);
    if (cached) {
      return cached;
    }
    const section = getCoreIdentitySection(baseRules);
    this.coreIdentityCache.set(baseRules, section);
    return section;
  }

  getAgentsMd(content: string): string {
    const key = hashContent(content);
    const cached = this.agentsMdCache.get(key);
    if (cached) {
      return cached;
    }
    const section = getAgentsMdSection(content);
    this.agentsMdCache.set(key, section);
    return section;
  }

  getToolUtilization(): string {
    if (this.toolUtilizationCache) {
      return this.toolUtilizationCache;
    }
    this.toolUtilizationCache = getToolUtilizationSection();
    return this.toolUtilizationCache;
  }

  getResponseFormatting(): string {
    if (this.responseFormattingCache) {
      return this.responseFormattingCache;
    }
    this.responseFormattingCache = getResponseFormattingSection();
    return this.responseFormattingCache;
  }

  setRuntimeEnvironment(section: string): void {
    this.lastRuntimeEnvironment = section;
  }

  getLastRuntimeEnvironment(): string | null {
    return this.lastRuntimeEnvironment;
  }

  invalidateCoreIdentity(): void {
    this.coreIdentityCache.clear();
  }
}
