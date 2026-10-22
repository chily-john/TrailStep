/**
 * Shared workflow-registry vocabulary (scope, context and package metadata).
 *
 * This module is a leaf: it declares types only and imports nothing. Both the
 * registry implementation (`workflow-registry.ts`) and the workflow resolution
 * implementation (`workflow-resolution.ts`) depend on it, so neither has to
 * import the other.
 */

export type WorkflowRegistryScope = "local" | "project" | "global";

export interface WorkflowRegistryContext {
  readonly cwd: string;
  readonly homeDir?: string;
}

export type WorkflowPackageSourceType = "npm" | "github";
export type WorkflowPackageInstallOwnership = "trailstep-installed" | "reused-existing" | "unknown";

export interface WorkflowPackageRegistryMetadata {
  readonly kind: "package";
  readonly sourceType: WorkflowPackageSourceType;
  readonly packageName: string;
  readonly requestedSpec: string;
  readonly requestedRange: string;
  readonly installScope: WorkflowRegistryScope;
  readonly targetRef: string;
  readonly workflowName: string;
  readonly exportName: string;
  readonly resolvedVersion?: string;
  readonly githubRef?: string;
  readonly installOwnership?: WorkflowPackageInstallOwnership;
}
