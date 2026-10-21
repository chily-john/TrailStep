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
/**
 * Skill distribution target chosen at `trailstep add` time ("project" and/or "user").
 * Persisted per registration so `trailstep update` can honor the original choice for
 * generated skills of untracked workflows. Absent on legacy registrations.
 */
export type WorkflowSkillInstallTarget = "project" | "user";

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
  /**
   * Skill target(s) the user chose at add time. Present whenever a choice was made
   * (an empty array means the user explicitly chose no skills); absent on legacy
   * registrations where update falls back to inference.
   */
  readonly skillTargets?: readonly WorkflowSkillInstallTarget[];
}
