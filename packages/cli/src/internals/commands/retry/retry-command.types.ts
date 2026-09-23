export type RetryCommandTrackFilter =
  | { readonly mode: "default" }
  | { readonly mode: "failed-only" }
  | { readonly mode: "branch"; readonly branchId: string };

export type RetryCommandArgs =
  | {
      readonly mode: "interactive";
    }
  | {
      readonly mode: "explicit";
      readonly workflowId: string;
      readonly workflowRunName: string;
      readonly filter: RetryCommandTrackFilter;
      readonly fresh: boolean;
    };
