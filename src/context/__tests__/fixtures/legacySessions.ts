/** Hand-authored supported wire formats, independent of the current encoder. */
export function legacySessionFixture(version: number) {
  return {
    version,
    savedAt: "2026-01-01T00:00:00Z",
    metadata: {
      providerName: "fixture",
      modelKey: "model",
      systemPrompt: "System",
      contextWindowTokens: 32000,
      promptBudgetPolicy: {},
      summaryPolicy: {},
      ...(version === 4
        ? {
            agentMode: "plan",
            planFilePath: "/caller/plan.md",
            planSaveApproved: true,
            planDraftSearchStartTurnIndex: 0,
          }
        : {}),
    },
    context: {
      preamble: [],
      artifacts: [],
      turns: [
        {
          id: "turn",
          startedAt: "2026-01-01T00:00:00Z",
          importance: "normal",
          userMessage: {
            role: "user",
            content: "Image",
            images: [{ data: "AID/", encoding: "base64" }],
          },
          entries: [
            {
              kind: "assistant",
              createdAt: "2026-01-01T00:00:01Z",
              message: {
                role: "assistant",
                content: "Answer",
                reasoningContent: '{"opaque":"continuation"}',
              },
            },
          ],
        },
      ],
      ...(version >= 2
        ? {
            pinnedMemory: [
              {
                id: "memory",
                kind: "fact",
                scope: "session",
                content: "Remember",
                source: { origin: "user" },
                createdAt: "2026-01-01",
                updatedAt: "2026-01-01",
                lifecycle: "active",
              },
            ],
          }
        : {}),
      ...(version >= 3
        ? {
            invokedSkills: [
              {
                name: "review",
                source: "project",
                skillRoot: "/skills/review",
                skillFile: "/skills/review/SKILL.md",
                arguments: "file.ts",
                content: "Review carefully",
                invokedAt: "2026-01-01",
                scope: {
                  invocationSource: "user",
                  skillName: "review",
                  skillRoot: "/skills/review",
                  skillFile: "/skills/review/SKILL.md",
                  allowedTools: ["read"],
                  warnings: ["fixture"],
                },
              },
            ],
          }
        : {}),
    },
  };
}
