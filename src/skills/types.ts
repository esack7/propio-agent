export type SkillSource = "project" | "user" | "bundled" | "plugin" | "mcp";

export interface SkillContext {
  readonly cwd: string;
  readonly homeDir: string;
}

export interface SkillInvocation {
  readonly arguments?: string;
}

export type SkillInvocationSource = "user" | "model";

export interface SkillInvocationOptions {
  readonly source?: SkillInvocationSource;
  readonly queue?: boolean;
}

export interface SkillInvocationScope {
  readonly invocationSource: SkillInvocationSource;
  readonly skillName: string;
  readonly skillRoot: string;
  readonly skillFile: string;
  readonly allowedTools?: readonly string[];
  readonly model?: string;
  readonly effort?: string;
  readonly appliedModel?: string;
  readonly appliedEffort?: string;
  readonly warnings?: readonly string[];
}

export type SkillContextMode = "inline" | "fork";

export interface SkillMetadata {
  readonly name: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly arguments?: string[];
  readonly argumentHint?: string;
  readonly allowedTools?: string[];
  readonly model?: string;
  readonly effort?: string;
  readonly disableModelInvocation?: boolean;
  readonly userInvocable?: boolean;
  readonly context?: SkillContextMode;
  readonly agent?: string;
  readonly paths?: string[];
  readonly version?: string;
}

export interface Skill extends SkillMetadata {
  readonly source: SkillSource;
  readonly skillRoot: string;
  readonly skillFile: string;
}

export interface InvokedSkillRecord {
  readonly name: string;
  readonly source: SkillSource;
  readonly skillRoot: string;
  readonly skillFile: string;
  readonly arguments?: string;
  readonly content: string;
  readonly invokedAt: string;
  readonly scope: SkillInvocationScope;
}

export type SkillLoadDiagnosticSeverity = "info" | "warning" | "error";

export interface SkillLoadDiagnostic {
  readonly severity: SkillLoadDiagnosticSeverity;
  readonly code: string;
  readonly message: string;
  readonly skillPath?: string;
  readonly skillName?: string;
}

export interface LoadLocalSkillsResult {
  readonly registry: import("./registry.js").SkillRegistry;
  readonly diagnostics: SkillLoadDiagnostic[];
}
