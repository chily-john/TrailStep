import { randomBytes } from "node:crypto";

import type { WorkflowReference } from "../../workflow-reference/workflow-reference.types.js";

export interface GenerateRunNameOptions {
  workflowRef: WorkflowReference;
  now?: () => Date;
  randomSuffix?: () => string;
}

export function generateRunName(options: GenerateRunNameOptions): string {
  const date = options.now?.() ?? new Date();
  const timestamp = date
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}Z$/u, "")
    .replace("T", "-");
  const readableName = slugify(options.workflowRef.exportName);
  const suffix = slugify(options.randomSuffix?.() ?? randomBytes(4).toString("hex"));
  return `${readableName}-${timestamp}-${suffix}`;
}

function slugify(value: string): string {
  const slug = value
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
  return slug === "" ? "workflow" : slug;
}
