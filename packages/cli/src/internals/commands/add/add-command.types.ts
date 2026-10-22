import type { InstalledNpmWorkflowPackage } from "../../workflow-packages/npm-package-installer.js";
import type { WorkflowPackageInstallSnapshot } from "../../workflow-packages/package-install-rollback.js";
import type {
  WorkflowPackageRegistryMetadata,
  WorkflowRegistryScope,
  WorkflowSkillInstallTarget,
} from "../../workflow-registry/workflow-registry.js";
import type { BundleWorkflowSpecifier } from "../../workflow-resolution/bundle-resolver.js";
import type { WorkflowSkillMetadata } from "../../workflow-skills/workflow-skill-content.js";

export interface AddCommandArgs {
  readonly source: string;
  readonly scope?: WorkflowRegistryScope;
  readonly namespace?: string;
  readonly name?: string;
  readonly workflow?: string;
  readonly force: boolean;
  readonly projectSkill: boolean;
  readonly userSkill: boolean;
  readonly projectSkillExplicit: boolean;
  readonly userSkillExplicit: boolean;
  readonly yes: boolean;
  readonly dryRun: boolean;
}

export interface ResolvedAddCommandArgs {
  readonly source: string;
  readonly scope: WorkflowRegistryScope;
  readonly namespace: string;
  readonly name: string;
  readonly workflow?: string;
  readonly force: boolean;
  readonly projectSkill: boolean;
  readonly userSkill: boolean;
}

export interface AddRegistration {
  readonly registryTarget: AddRegistryTarget;
  readonly name: string;
}

export interface AddRegistryTarget {
  readonly targetRef: string;
  readonly workflow?: WorkflowSkillMetadata;
  readonly bundleSpecifier?: BundleWorkflowSpecifier;
  readonly bundleExportName?: string;
  readonly metadata?: WorkflowPackageRegistryMetadata;
}

export interface AddWorkflowCandidate extends AddRegistryTarget {
  readonly selectionName: string;
  readonly sourceKind: "bundle" | "direct";
}

export type AddWorkflowSelectionPolicy = "prompt" | "all";

export interface SourceResolutionArgs {
  readonly source: string;
  readonly workflow?: string;
  readonly selectionPolicy: AddWorkflowSelectionPolicy;
}

export type PreparedAddSource =
  | {
      readonly status: "ready";
      readonly source: string;
      readonly cwd: string;
      readonly installedPackage?: InstalledNpmWorkflowPackage;
      readonly installSnapshot?: WorkflowPackageInstallSnapshot;
    }
  | { readonly status: "cancelled" };

export interface ResolvedSkillArgs {
  readonly projectSkill: boolean;
  readonly userSkill: boolean;
  /**
   * Skill targets the user actually chose (explicit flags or interactive prompts),
   * including an empty array for "no skills". Undefined when no choice was made
   * (e.g. headless `--yes` without skill flags), leaving the registration unmarked.
   */
  readonly skillTargets?: readonly WorkflowSkillInstallTarget[];
}

export interface RegistrationConflict {
  readonly namespace: string;
  readonly registration: AddRegistration;
  readonly existingScope: WorkflowRegistryScope;
}

export type AddRegistrationPlan =
  | {
      readonly status: "ready";
      readonly namespace: string;
      readonly registrations: readonly AddRegistration[];
      readonly registrationConflicts: readonly RegistrationConflict[];
      readonly successfulRegistrations: readonly AddRegistration[];
      readonly skippedConflicts: number;
      readonly resolvedArgs: ResolvedSkillArgs;
    }
  | { readonly status: "cancelled" };
