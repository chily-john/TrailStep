import { join, resolve } from "node:path";
import type { CliCommandContext } from "./command.types.js";

export const STEPKIT_RUNS_ROOT_ENV = "STEPKIT_RUNS_ROOT";

export function resolveConfiguredRunsRoot(
  context: Pick<CliCommandContext, "cwd" | "env">,
): string | undefined {
  const configured = context.env?.[STEPKIT_RUNS_ROOT_ENV]?.trim();
  if (!configured) {
    return undefined;
  }

  return resolve(context.cwd, configured);
}

export function resolveRunsRoot(context: Pick<CliCommandContext, "cwd" | "env">): string {
  return resolveConfiguredRunsRoot(context) ?? join(context.cwd, ".trailstep", "runs");
}
