export type RetryCommandArgs =
  | {
      readonly mode: "interactive";
    }
  | {
      readonly mode: "explicit";
      readonly workflowId: string;
      readonly workflowRunName: string;
    };
