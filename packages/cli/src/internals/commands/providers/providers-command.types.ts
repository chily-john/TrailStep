import type { TrailStepProviderManifest } from "@trailstep/core";
import type { LoadedProviderPackageDefinition } from "../../providers/provider-package-loader.js";
import type { WorkflowRegistryScope } from "../../workflow-registry/workflow-registry.js";

export type ProviderManifestWithStoredMetadata = TrailStepProviderManifest & {
  readonly environment?: {
    readonly required?: readonly string[];
    readonly optional?: readonly string[];
  };
  readonly hooks?: Record<string, unknown>;
};

export interface TrailStepProviderRegistration {
  readonly source:
    | { readonly type: "local-manifest"; readonly path: string }
    | { readonly type: "legacy-custom-provider" }
    | {
        readonly type: "npm" | "github" | "local-package";
        readonly packageName: string;
        readonly spec: string;
        readonly resolvedVersion?: string;
      };
  readonly manifest: ProviderManifestWithStoredMetadata;
}

export type LoadedProviderDefinition = Omit<LoadedProviderPackageDefinition, "manifest"> & {
  readonly manifest: ProviderManifestWithStoredMetadata;
};

export type ProviderCommandArgs =
  | { readonly action: "inspect"; readonly path: string }
  | { readonly action: "add"; readonly path: string; readonly scope?: WorkflowRegistryScope }
  | { readonly action: "list"; readonly scope?: WorkflowRegistryScope }
  | { readonly action: "show"; readonly provider?: string; readonly scope?: WorkflowRegistryScope }
  | { readonly action: "test"; readonly provider: string; readonly scope?: WorkflowRegistryScope }
  | { readonly action: "migrate"; readonly scope?: WorkflowRegistryScope }
  | {
      readonly action: "remove";
      readonly provider: string;
      readonly scope?: WorkflowRegistryScope;
    };

export interface ProviderReferrer {
  readonly scope: WorkflowRegistryScope;
  readonly path: string;
}
