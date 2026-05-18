import { ContextManager } from "../contextManager.js";
import type { ArtifactToolResult } from "../types.js";

export function toolResult(
  toolCallId: string,
  toolName: string,
  rawContent: string,
  status: "success" | "error" = "success",
): ArtifactToolResult {
  return { toolCallId, toolName, rawContent, status };
}

export class ContextManagerTestBuilder {
  private readonly manager: ContextManager;

  constructor(manager?: ContextManager) {
    this.manager = manager ?? new ContextManager();
  }

  createCompletedTurn(userMsg: string, assistantMsg: string): this {
    this.manager.beginUserTurn(userMsg);
    this.manager.commitAssistantResponse(assistantMsg);
    return this;
  }

  createToolCallTurn(
    userMsg: string,
    toolCallId: string,
    toolName: string,
    toolResultContent: string,
  ): this {
    this.manager.beginUserTurn(userMsg);
    this.manager.commitAssistantResponse("", [
      {
        id: toolCallId,
        function: { name: toolName, arguments: {} },
      },
    ]);
    this.manager.recordToolResults([
      toolResult(toolCallId, toolName, toolResultContent),
    ]);
    return this;
  }

  assertArtifactProperties(
    artifact: { type?: string; mediaType?: string; content?: string },
    expected: { type?: string; mediaType?: string; content?: string },
  ): void {
    if (expected.type !== undefined) {
      expect(artifact.type).toBe(expected.type);
    }
    if (expected.mediaType !== undefined) {
      expect(artifact.mediaType).toBe(expected.mediaType);
    }
    if (expected.content !== undefined) {
      expect(artifact.content).toBe(expected.content);
    }
  }

  getManager(): ContextManager {
    return this.manager;
  }
}
