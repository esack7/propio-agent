import { choosePromptBudget } from "../setup.js";
import { resolvePromptBudget } from "../budgets.js";
import { documentedModelCapacity } from "../modelCapacities.js";

describe("subscription working context budgets", () => {
  it.each(["gpt-6.1-sol", "gpt-5.6-luna", "gpt-5.5-2026-04-23"])(
    "reserves the documented output allowance for %s",
    (key) => {
      const budget = resolvePromptBudget(key)!;
      expect(budget.contextWindowTokens).toBe(922000);
      expect(budget.source).toBe("official-documentation");
      expect(
        budget.contextWindowTokens + budget.capacity!.maxOutputTokens,
      ).toBeLessThanOrEqual(budget.capacity!.contextWindowTokens);
      if (budget.capacity!.maxInputTokens)
        expect(budget.contextWindowTokens).toBeLessThanOrEqual(
          budget.capacity!.maxInputTokens,
        );
    },
  );

  it("preserves saved budgets for known and unknown models", () => {
    for (const key of ["gpt-6.1-sol", "future-model"])
      expect(resolvePromptBudget(key, 128000)).toMatchObject({
        contextWindowTokens: 128000,
        source: "saved-config",
      });
  });

  it("does not guess limits for unknown aliases or future snapshots", () => {
    expect(resolvePromptBudget("gpt-6.1-sol-2099-01-01")).toBeUndefined();
    expect(resolvePromptBudget("unknown-model")).toBeUndefined();
    expect(resolvePromptBudget("unknown-model", NaN)).toBeUndefined();
    expect(resolvePromptBudget("gpt-6.1-sol", -1)?.source).toBe(
      "official-documentation",
    );
  });

  it("protects documented limits from mutations by callers", () => {
    const capacity = documentedModelCapacity("gpt-6.1-sol")!;
    capacity.maxOutputTokens = 0;
    expect(resolvePromptBudget("gpt-6.1-sol")?.contextWindowTokens).toBe(
      922000,
    );
  });

  it("uses documented and saved selections without an extra question", async () => {
    const ui = { ask: jest.fn(), info: jest.fn() };
    expect(await choosePromptBudget(ui, "gpt-6.1-sol")).toMatchObject({
      contextWindowTokens: 922000,
    });
    expect(await choosePromptBudget(ui, "gpt-6.1-sol", 200000)).toMatchObject({
      contextWindowTokens: 200000,
    });
    expect(ui.ask).not.toHaveBeenCalled();
  });

  it("lets a saved conservative budget reset to documented limits", async () => {
    const ui = {
      ask: jest.fn().mockResolvedValue("documented"),
      info: jest.fn(),
    };
    expect(
      await choosePromptBudget(ui, "gpt-6.1-sol", 128000, true),
    ).toMatchObject({
      contextWindowTokens: 922000,
      source: "official-documentation",
    });
  });

  it("asks for unknown models and keeps conservative selection explicit", async () => {
    const ui = {
      ask: jest.fn().mockResolvedValue("conservative"),
      info: jest.fn(),
    };
    expect(await choosePromptBudget(ui, "unknown-model")).toMatchObject({
      contextWindowTokens: 128000,
      source: "user-selected-conservative",
    });
    expect(ui.info).toHaveBeenCalledWith(
      "Catalog capacity is unknown for this model.",
    );
    expect(ui.ask.mock.calls[0][0]).not.toContain("'documented'");
  });

  it.each([null, "", "   "])("cancels an adjustment on %p", async (answer) => {
    const ui = { ask: jest.fn().mockResolvedValue(answer), info: jest.fn() };
    expect(
      await choosePromptBudget(ui, "gpt-6.1-sol", 128000, true),
    ).toBeNull();
  });

  it.each(["0", "1.5", "Infinity", "invalid", "9007199254740992"])(
    "rejects unsafe capacity %s",
    async (answer) => {
      const ui = { ask: jest.fn().mockResolvedValue(answer), info: jest.fn() };
      await expect(choosePromptBudget(ui, "unknown-model")).rejects.toThrow(
        "integer of at least 1024",
      );
    },
  );
});
