import { ChatTool } from "@propio-ai/providers";
import { ExecutableTool } from "./interface.js";
import type { ToolDisplayAdapter } from "./displayAdapter.js";

export interface SkillToolInvoker {
  invokeSkill(
    name: string,
    argumentsText?: string,
    options?: {
      readonly source?: "model";
    },
  ): Promise<string>;
}

export class SkillTool implements ExecutableTool {
  readonly name = "skill";
  readonly description = "Activate a loaded inline skill.";

  constructor(private readonly invoker: SkillToolInvoker) {}

  getDisplayAdapter(): ToolDisplayAdapter {
    return {
      renderUse(input) {
        const name = input.name;
        return typeof name === "string" && name.length > 0 ? name : null;
      },
      renderResult(result) {
        return result;
      },
    };
  }

  getInvocationLabel(args: Record<string, unknown>): string | undefined {
    const name = args.name;
    return typeof name === "string" && name.length > 0
      ? `Invoking skill ${name}`
      : "Invoking skill";
  }

  getSchema(): ChatTool {
    return {
      type: "function",
      function: {
        name: "skill",
        description:
          "Expands a loaded skill into the conversation. The skill becomes active immediately and can apply allowed-tools restrictions while it runs.",
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Loaded skill name",
            },
            arguments: {
              type: "string",
              description: "Optional raw arguments passed to the skill",
            },
          },
          required: ["name"],
        },
      },
    };
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!name) {
      throw new Error('Missing required argument "name"');
    }

    const argumentsText =
      typeof args.arguments === "string" ? args.arguments : undefined;

    await this.invoker.invokeSkill(name, argumentsText, {
      source: "model",
    });

    return argumentsText
      ? `Activated skill ${name} with arguments.`
      : `Activated skill ${name}.`;
  }
}
