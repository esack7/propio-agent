import { describe, expect, it } from "@jest/globals";
import {
  composeExtraUserInstruction,
  getModeReminder,
  getModeSystemSection,
  getExecuteSwitchReminder,
  shouldUseFullModeReminder,
} from "../prompts.js";

describe("mode prompts", () => {
  it("omits execute mode system section", () => {
    expect(getModeSystemSection({ mode: "execute" })).toBeUndefined();
  });

  it("includes discover section", () => {
    expect(getModeSystemSection({ mode: "discover" })).toContain(
      "Discover mode",
    );
  });

  it("includes pre-save plan workflow text", () => {
    expect(getModeSystemSection({ mode: "plan" })).toContain(
      "Draft the plan in chat",
    );
    expect(getModeSystemSection({ mode: "plan" })).toContain(
      "create or edit a plan file",
    );
    expect(getModeSystemSection({ mode: "plan" })).toContain(
      "run `/plan save` to save the latest plan",
    );
    expect(getModeSystemSection({ mode: "plan" })).toContain(
      "do not repeat equivalent searches",
    );
  });

  it("includes post-save plan workflow text", () => {
    expect(
      getModeSystemSection({
        mode: "plan",
        planFilePath: "/tmp/plan.md",
        planSaveApproved: true,
      }),
    ).toContain("/tmp/plan.md");
    expect(
      getModeSystemSection({
        mode: "plan",
        planFilePath: "/tmp/plan.md",
        planSaveApproved: true,
      }),
    ).toContain("approved plan file");
  });

  it("throttles full mode reminders", () => {
    expect(shouldUseFullModeReminder(1)).toBe(true);
    expect(shouldUseFullModeReminder(2)).toBe(false);
    expect(shouldUseFullModeReminder(6)).toBe(true);
  });

  it("composes extra user instructions without overwriting caller text", () => {
    expect(
      composeExtraUserInstruction("retry hint", "mode reminder"),
    ).toContain("retry hint");
    expect(
      composeExtraUserInstruction("retry hint", "mode reminder"),
    ).toContain("mode reminder");
  });

  it("returns pre-save plan reminder text", () => {
    expect(getModeReminder({ mode: "plan" }, 1)).toContain(
      "do not create a file yet",
    );
  });

  it("returns post-save execute switch reminder", () => {
    expect(getExecuteSwitchReminder("/tmp/plan.md")).toContain(
      "If an approved plan file exists at /tmp/plan.md",
    );
  });
});
