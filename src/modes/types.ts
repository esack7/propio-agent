export type AgentMode = "execute" | "plan" | "discover";

export interface AgentModeState {
  readonly mode: AgentMode;
  readonly planFilePath?: string;
  readonly planSaveApproved?: boolean;
  readonly previousMode?: AgentMode;
}

export const AGENT_MODE_CYCLE: readonly AgentMode[] = [
  "execute",
  "plan",
  "discover",
];

export type ApprovedPlanPersistenceFields = {
  readonly planFilePath: string;
  readonly planSaveApproved: true;
};

export function getApprovedPlanPersistenceFields(
  state: Pick<AgentModeState, "planFilePath" | "planSaveApproved">,
): ApprovedPlanPersistenceFields | undefined {
  if (state.planSaveApproved && state.planFilePath) {
    return {
      planFilePath: state.planFilePath,
      planSaveApproved: true,
    };
  }
  return undefined;
}

export function resolveImportedPlanState(metadata: {
  readonly planFilePath?: string;
  readonly planSaveApproved?: boolean;
}): Pick<AgentModeState, "planFilePath" | "planSaveApproved"> {
  const approved = metadata.planSaveApproved ?? Boolean(metadata.planFilePath);
  if (approved && metadata.planFilePath) {
    return {
      planFilePath: metadata.planFilePath,
      planSaveApproved: true,
    };
  }
  return {};
}
