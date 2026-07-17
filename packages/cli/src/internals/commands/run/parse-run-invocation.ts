import { CliUsageError } from "../../command.types.js";
import {
  parseBundleWorkflowId,
  parseWorkflowId,
} from "../../workflow-reference/workflow-reference.js";
import { isDirectWorkflowFileReference } from "../../workflow-resolution/workflow-resolution.js";
import { parseRunArgs } from "./parse-run-args.js";
import type { RunCommandArgs } from "./run-command.types.js";

export function parseRunInvocation(argv: readonly string[]): RunCommandArgs {
  const [workflowId, maybeRunName, ...restAfterMaybeRunName] = argv;
  if (!workflowId) {
    throw new CliUsageError("Expected a command or workflow id.");
  }

  const hasExplicitRunName = maybeRunName !== undefined && !maybeRunName.startsWith("--");
  const workflowRunName = hasExplicitRunName ? maybeRunName : undefined;
  const rest = hasExplicitRunName ? restAfterMaybeRunName : argv.slice(1);
  const workflow =
    parseBundleWorkflowId(workflowId) ??
    (isDirectWorkflowFileReference(workflowId) || !workflowId.includes(":")
      ? undefined
      : parseWorkflowId(workflowId));
  const parsedOptions = parseRunArgs(rest);

  if (parsedOptions?.resume === true && workflowRunName === undefined) {
    throw new CliUsageError("Expected an explicit workflow run name when using --resume.");
  }

  return {
    workflowId,
    ...(workflowRunName === undefined ? {} : { workflowRunName }),
    ...(workflow === undefined ? {} : { workflow }),
    ...(parsedOptions?.input !== undefined ? { input: parsedOptions.input } : {}),
    ...(parsedOptions?.resume === true ? { resume: true } : {}),
  };
}
