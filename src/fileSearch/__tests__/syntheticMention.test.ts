import type { ChatMessage } from "@propio-ai/providers";
import { inlineSyntheticMentionPairs } from "../syntheticMention.js";

describe("inlineSyntheticMentionPairs", () => {
  const syntheticPair: ChatMessage[] = [
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "mention_1",
          function: {
            name: "read",
            arguments: {
              path: "src/info.txt",
              resolvedPath: "/workspace/src/info.txt",
            },
          },
        },
      ],
    },
    {
      role: "tool",
      content: "",
      toolResults: [
        {
          toolCallId: "mention_1",
          toolName: "read",
          content: "alpha\nbeta",
        },
      ],
    },
  ];

  it("converts synthetic mention assistant/tool pairs into inline user context", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "@src/info.txt summarize" },
      ...syntheticPair,
    ];

    const result = inlineSyntheticMentionPairs(messages);

    const mentionInline = result.find(
      (message) =>
        message.role === "user" &&
        message.content.includes('mention_id="mention_1"'),
    );
    expect(mentionInline).toBeDefined();
    expect(mentionInline?.content).toContain("alpha");
    expect(mentionInline?.content).toContain('path="src/info.txt"');
    expect(mentionInline?.content).toContain(
      'resolved_path="/workspace/src/info.txt"',
    );
    expect(
      result.some(
        (message) => message.role === "assistant" && message.toolCalls != null,
      ),
    ).toBe(false);
    expect(result.some((message) => message.role === "tool")).toBe(false);
  });

  it("removes unsigned mention tool calls from the history", () => {
    const result = inlineSyntheticMentionPairs([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "mention_1",
            function: {
              name: "ls",
              arguments: { path: "src", resolvedPath: "/workspace/src" },
            },
          },
        ],
      },
      {
        role: "tool",
        content: "",
        toolResults: [
          { toolCallId: "mention_1", toolName: "ls", content: "info.txt" },
        ],
      },
    ]);

    for (const message of result) {
      for (const toolCall of message.toolCalls ?? []) {
        expect(toolCall.id).not.toMatch(/^mention_/);
      }
    }
  });

  it("preserves signed tool calls with thought signatures", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_1",
            thoughtSignature: "sig-weather",
            function: {
              name: "get_weather",
              arguments: { location: "NYC" },
            },
          },
        ],
      },
      {
        role: "tool",
        content: "",
        toolResults: [
          { toolCallId: "call_1", toolName: "get_weather", content: "sunny" },
        ],
      },
    ];

    expect(inlineSyntheticMentionPairs(messages)).toEqual(messages);
  });

  it("preserves real tool-call rounds that are not mention pairs", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "run the tool" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_2",
            function: { name: "bash", arguments: { cmd: "ls" } },
          },
        ],
      },
      {
        role: "tool",
        content: "",
        toolResults: [
          { toolCallId: "call_2", toolName: "bash", content: "out" },
        ],
      },
      { role: "assistant", content: "done" },
    ];

    expect(inlineSyntheticMentionPairs(messages)).toEqual(messages);
  });
});
