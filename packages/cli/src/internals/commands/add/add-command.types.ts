import type { Workflow } from "@trailstep/core";
import type { InstalledNpmWorkflowPackage } from "../../workflow-packages/npm-package-installer.js";
import type { WorkflowPackageInstallSnapshot } from "../../workflow-packages/package-install-rollback.js";
import type {
  WorkflowPackageRegistryMetadata,
  WorkflowRegistryScope,
} from "../../workflow-registry/workflow-registry.js";
import type { BundleWorkflowSpecifier } from "../../workflow-resolution/bundle-resolver.js";

export interface AddCommandArgs {
  readonly source: string;
  readonly scope?: WorkflowRegistryScope;
  readonly namespace?: string;
  readonly name?: string;
  readonly workflow?: string;
  readonly force: boolean;
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
}

export interface AddRegistration {
  readonly registryTarget: AddRegistryTarget;
  readonly name: string;
}

export interface AddRegistryTarget {
  readonly targetRef: string;
  readonly workflow?: Workflow;
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
    }
  | { readonly status: "cancelled" };
