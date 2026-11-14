import type { ToolMetadata } from "../policy/capabilities.js";
import { ChatTool } from "@propio-ai/providers";
import { PresentedTool } from "./interface.js";
import { genericDisplay, type ToolDisplay } from "./display.js";
import type { ToolExecutionResult } from "./types.js";

export interface SkillToolInvoker {
  invokeSkill(
    name: string,
    argumentsText?: string,
    options?: {
      readonly source?: "model";
    },
  ): Promise<string>;
}

function skillTitle(args: Readonly<Record<string, unknown>>): string {
  const name = args.name;
  return typeof name === "string" && name.length > 0
    ? `Invoking skill ${name}`
    : "Invoking skill";
}

export class SkillTool implements PresentedTool {
  readonly name = "skill";
  readonly metadata: ToolMetadata = {
    capabilities: ["read"],
    readOnly: true,
    concurrencySafe: false,
  };
  readonly description = "Activate a loaded inline skill.";

  constructor(private readonly invoker: SkillToolInvoker) {}

  describeCall(args: Readonly<Record<string, unknown>>): ToolDisplay {
    return genericDisplay(skillTitle(args), args);
  }

  describeResult(
    args: Readonly<Record<string, unknown>>,
    result: Readonly<ToolExecutionResult>,
  ): ToolDisplay {
    return genericDisplay(skillTitle(args), args, {
      content: result.content,
      failed: result.status !== "success",
    });
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
