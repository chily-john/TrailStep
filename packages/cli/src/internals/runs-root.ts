import {
  resolveConfiguredRunsRoot as resolveConfiguredRunsRootCore,
  resolveRunsRoot as resolveRunsRootCore,
  TRAILSTEP_RUNS_ROOT_ENV,
} from "@trailstep/core";

import type { CliCommandContext } from "./command-framework/command.types.js";

export { TRAILSTEP_RUNS_ROOT_ENV };

export function resolveConfiguredRunsRoot(
  context: Pick<CliCommandContext, "cwd" | "env">,
): string | undefined {
  return resolveConfiguredRunsRootCore({ cwd: context.cwd, env: context.env });
}

export function resolveRunsRoot(context: Pick<CliCommandContext, "cwd" | "env">): string {
  return resolveRunsRootCore({ cwd: context.cwd, env: context.env });
}
