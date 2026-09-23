import { CliUsageError } from "../../command.types.js";
import type { RetryCommandArgs, RetryCommandTrackFilter } from "./retry-command.types.js";

const retryUsage = "Expected trailstep retry <workflow-ref> <runName>.";

export function parseRetryInvocation(argv: readonly string[]): RetryCommandArgs {
  const [, workflowId, workflowRunName, ...rest] = argv;
  const unsupportedStepFlag = argv.find((arg) => arg === "--step" || arg.startsWith("--step="));

  if (unsupportedStepFlag) {
    throw new CliUsageError(
      `${unsupportedStepFlag} is not supported by retry V1; retry targets the latest unresolved failure for an explicit workflow run. ${retryUsage}`,
    );
  }

  if (!workflowId && !workflowRunName && rest.length === 0) {
    return { mode: "interactive" };
  }

  if (!workflowId || !workflowRunName) {
    throw new CliUsageError(retryUsage);
  }

  const parsed = parseRetryOptions(rest);
  return {
    mode: "explicit",
    workflowId,
    workflowRunName,
    filter: parsed.filter,
    fresh: parsed.fresh,
  };
}

function parseRetryOptions(args: readonly string[]): {
  readonly filter: RetryCommandTrackFilter;
  readonly fresh: boolean;
} {
  let filter: RetryCommandTrackFilter = { mode: "default" };
  let fresh = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--failed") {
      if (filter.mode !== "default") {
        throw new CliUsageError(`Cannot combine --failed with --branch. ${retryUsage}`);
      }
      filter = { mode: "failed-only" };
      continue;
    }

    if (arg === "--branch") {
      if (filter.mode !== "default") {
        throw new CliUsageError(`Cannot combine --branch with --failed. ${retryUsage}`);
      }
      const branchId = args[index + 1];
      if (!branchId || branchId.startsWith("--")) {
        throw new CliUsageError(`Expected branch id after --branch. ${retryUsage}`);
      }
      filter = { mode: "branch", branchId };
      index += 1;
      continue;
    }

    if (arg?.startsWith("--branch=")) {
      if (filter.mode !== "default") {
        throw new CliUsageError(`Cannot combine --branch with --failed. ${retryUsage}`);
      }
      const branchId = arg.slice("--branch=".length);
      if (!branchId) {
        throw new CliUsageError(`Expected branch id after --branch. ${retryUsage}`);
      }
      filter = { mode: "branch", branchId };
      continue;
    }

    if (arg === "--fresh") {
      fresh = true;
      continue;
    }

    if (arg?.startsWith("--")) {
      throw new CliUsageError(`Unknown option: ${arg}. ${retryUsage}`);
    }

    throw new CliUsageError(retryUsage);
  }

  if (fresh && filter.mode !== "default") {
    throw new CliUsageError("--fresh cannot be combined with --failed or --branch.");
  }

  return { filter, fresh };
}
