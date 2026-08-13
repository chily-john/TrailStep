import type { WorkflowAgentThinking } from "../../../../contracts/agents/agent-role.types.js";
import { renderCustomProviderArgs } from "../../../custom-provider/render-custom-provider-args.js";

export function buildWorkingAgentArgs(options: {
  readonly argv: readonly string[] | undefined;
  readonly promptFile: string;
  readonly outputFile: string;
  readonly model?: string;
  readonly thinking?: WorkflowAgentThinking;
}): string[] {
  if (!options.argv) {
    return [
      "--prompt-file",
      options.promptFile,
      "--output-file",
      options.outputFile,
      ...(options.model ? ["--model", options.model] : []),
    ];
  }

  return renderCustomProviderArgs({
    argv: options.argv,
    values: {
      promptFile: options.promptFile,
      outputFile: options.outputFile,
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.thinking === undefined ? {} : { thinking: options.thinking }),
    },
    errorCode: "agent_provider_invalid",
    commandDescription: "Working agent command",
  });
}
