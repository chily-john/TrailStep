import { CliUsageError } from "../../command.types.js";
import type { RetryCommandArgs } from "./retry-command.types.js";

const retryUsage = "Expected trailstep retry <workflow-ref> <runName>.";

export function parseRetryInvocation(argv: readonly string[]): RetryCommandArgs {
  const [, workflowId, workflowRunName, ...rest] = argv;
  const unsupportedStepFlag = argv.find((arg) => arg === "--step" || arg.startsWith("--step="));

  if (unsupportedStepFlag) {
    throw new CliUsageError(
      `${unsupportedStepFlag} is not supported by retry V1; retry targets the latest unresolved failure for an explicit workflow run. ${retryUsage}`,
    );
  }

  const unknownFlag = argv.slice(1).find((arg) => arg.startsWith("--"));
  if (unknownFlag) {
    throw new CliUsageError(`Unknown option: ${unknownFlag}. ${retryUsage}`);
  }

  if (!workflowId && !workflowRunName && rest.length === 0) {
    return { mode: "interactive" };
  }

  if (!workflowId || !workflowRunName || rest.length > 0) {
    throw new CliUsageError(retryUsage);
  }

  return { mode: "explicit", workflowId, workflowRunName };
}
