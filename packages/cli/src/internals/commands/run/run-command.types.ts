import type { WorkflowReference } from "../../workflow-reference/workflow-reference.types.js";

export type InputSource = { kind: "inline"; json: string } | { kind: "file"; path: string };

export interface ParsedRunOptions {
  readonly input?: InputSource;
  readonly resume?: true;
}

export interface RunCommandArgs {
  workflowId: string;
  workflowRunName?: string;
  workflow?: WorkflowReference;
  input?: InputSource;
  resume?: true;
}
