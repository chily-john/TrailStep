import type { WorkflowReference } from "../../workflow-reference/workflow-reference.types.js";

export type InputSource = { kind: "inline"; json: string } | { kind: "file"; path: string };

export interface InputOverride {
  readonly kind: "flag" | "set";
  readonly path: string;
  readonly rawValue: string;
  readonly source: string;
}

export interface ParsedRunOptions {
  readonly input?: InputSource;
  readonly inputOverrides?: readonly InputOverride[];
}

export interface RunCommandArgs {
  workflowId: string;
  workflowRunName?: string;
  workflow?: WorkflowReference;
  input?: InputSource;
  inputOverrides?: readonly InputOverride[];
}
