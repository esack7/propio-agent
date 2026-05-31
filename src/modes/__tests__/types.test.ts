import { describe, expect, it } from "@jest/globals";
import {
  getApprovedPlanPersistenceFields,
  resolveImportedPlanState,
} from "../types.js";

describe("agent mode persistence helpers", () => {
  it("returns plan fields only when save is approved", () => {
    expect(
      getApprovedPlanPersistenceFields({
        planFilePath: "/tmp/plan.md",
        planSaveApproved: true,
      }),
    ).toEqual({
      planFilePath: "/tmp/plan.md",
      planSaveApproved: true,
    });

    expect(
      getApprovedPlanPersistenceFields({
        planFilePath: "/tmp/plan.md",
        planSaveApproved: false,
      }),
    ).toBeUndefined();

    expect(getApprovedPlanPersistenceFields({})).toBeUndefined();
  });

  it("restores approved plan state from session metadata", () => {
    expect(
      resolveImportedPlanState({
        planFilePath: "/tmp/plan.md",
        planSaveApproved: true,
      }),
    ).toEqual({
      planFilePath: "/tmp/plan.md",
      planSaveApproved: true,
    });

    expect(
      resolveImportedPlanState({
        planFilePath: "/tmp/plan.md",
      }),
    ).toEqual({
      planFilePath: "/tmp/plan.md",
      planSaveApproved: true,
    });

    expect(
      resolveImportedPlanState({
        agentMode: "plan",
      } as { planFilePath?: string; planSaveApproved?: boolean }),
    ).toEqual({});
  });
});
