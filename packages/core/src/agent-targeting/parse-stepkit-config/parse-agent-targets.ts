import type {
  WorkflowAgentSize,
  WorkflowAgentThinking,
} from "../../contracts/agents/agent-role.types.js";
import type { StepKitAgentTarget } from "../targeting.types.js";
import { isRecord, parseOptionalStringArray } from "./parse-utils.js";

export const AGENT_SIZES = new Set<WorkflowAgentSize>([
  "default",
  "tiny",
  "small",
  "medium",
  "large",
  "xl",
]);

const THINKING_LEVELS = new Set<WorkflowAgentThinking>(["low", "medium", "high", "xhigh", "max"]);

export function parseTargetArray(
  path: string,
  value: unknown,
  diagnostics: string[],
): readonly StepKitAgentTarget[] {
  if (!Array.isArray(value)) {
    diagnostics.push(`${path} must be an array.`);
    return [];
  }

  return value.flatMap((target, index) => {
    const targetPath = `${path}[${index}]`;

    if (!isRecord(target)) {
      diagnostics.push(`${targetPath} must be an object.`);
      return [];
    }

    if (typeof target.provider !== "string" || target.provider.length === 0) {
      diagnostics.push(`${targetPath}.provider must be a non-empty string.`);
      return [];
    }

    if (target.model !== undefined && typeof target.model !== "string") {
      diagnostics.push(`${targetPath}.model must be a string when present.`);
    }

    if (
      target.thinking !== undefined &&
      !THINKING_LEVELS.has(target.thinking as WorkflowAgentThinking)
    ) {
      diagnostics.push(
        `${targetPath}.thinking must be one of low, medium, high, xhigh, or max when present.`,
      );
    }

    const args = parseOptionalStringArray(`${targetPath}.args`, target.args, diagnostics);

    return [
      {
        provider: target.provider,
        ...(typeof target.model === "string" ? { model: target.model } : {}),
        ...(typeof target.thinking === "string" &&
        THINKING_LEVELS.has(target.thinking as WorkflowAgentThinking)
          ? { thinking: target.thinking as WorkflowAgentThinking }
          : {}),
        ...(args === undefined ? {} : { args }),
      },
    ];
  });
}
