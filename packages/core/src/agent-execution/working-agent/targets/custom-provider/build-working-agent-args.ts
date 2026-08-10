import { TrailStepFailureError } from "../../../../contracts/failures/failure.js";

export function buildWorkingAgentArgs(options: {
  readonly argv: readonly string[] | undefined;
  readonly promptFile: string;
  readonly outputFile: string;
  readonly model?: string;
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

  return options.argv.map((arg) => {
    switch (arg) {
      case "{{promptFile}}":
        return options.promptFile;
      case "{{outputFile}}":
        return options.outputFile;
      case "{{model}}":
        return options.model ?? "";
      default:
        if (
          arg.includes("{{promptFile}}") ||
          arg.includes("{{outputFile}}") ||
          arg.includes("{{model}}")
        ) {
          throw new TrailStepFailureError({
            code: "agent_provider_invalid",
            message: "Working agent command placeholders must be whole argv values.",
          });
        }
        return arg;
    }
  });
}
