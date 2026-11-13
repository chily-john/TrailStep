import { join, resolve } from "node:path";

import type { TrailStepProviderRegistration, TrailStepProviderSource } from "@trailstep/core";
import type { CliCommandContext } from "../command-framework/command.types.js";
import type { WorkflowRegistryScope } from "../workflow-registry/workflow-registry.js";

/** Sources that can resolve to an installed package with executable exports. */
export type RegisteredPackageProviderSource = Extract<
  TrailStepProviderSource,
  { readonly type: "npm" | "github" | "local-package" }
>;

export function isRegisteredPackageProviderSource(
  source: TrailStepProviderSource,
): source is RegisteredPackageProviderSource {
  return source.type === "npm" || source.type === "github" || source.type === "local-package";
}

/**
 * Resolve the package root for an already-registered package provider,
 * preserving the existing scope-sensitive rules:
 * - `local-package` specs resolve against the invoking cwd;
 * - npm/github installs live under the global packages root for global
 *   registrations, otherwise under the project cwd.
 */
export function resolveRegisteredProviderPackageRoot(
  source: RegisteredPackageProviderSource,
  scope: WorkflowRegistryScope,
  context: CliCommandContext,
): string {
  if (source.type === "local-package") {
    return resolve(context.cwd, source.spec);
  }

  const installRoot =
    scope === "global"
      ? join(context.homeDir ?? context.cwd, ".trailstep", "packages")
      : context.cwd;
  return join(installRoot, "node_modules", ...source.packageName.split("/"));
}

/** Narrow a raw registration source without accepting local manifests/custom providers. */
export function registeredPackageSource(
  registration: TrailStepProviderRegistration,
): RegisteredPackageProviderSource | undefined {
  return isRegisteredPackageProviderSource(registration.source) ? registration.source : undefined;
}
