export type WorkflowReference =
  | LegacyPackageWorkflowReference
  | BundleWorkflowReference
  | DirectWorkflowReference;

export interface LegacyPackageWorkflowReference {
  readonly kind: "legacy-package-export";
  readonly packageName: string;
  readonly exportName: string;
}

export interface BundleWorkflowReference {
  readonly kind: "bundle";
  readonly packageName: string;
  readonly workflowName: string;
  readonly exportName: string;
}

export interface DirectWorkflowReference {
  readonly kind: "direct-file";
  readonly packageName: string;
  readonly exportName: string;
}
