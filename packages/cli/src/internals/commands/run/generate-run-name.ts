import { generateRunName as generateCoreRunName } from "@trailstep/core";

import type { WorkflowReference } from "../../workflow-reference/workflow-reference.types.js";

export interface GenerateRunNameOptions {
  workflowRef: WorkflowReference;
  now?: () => Date;
  randomSuffix?: () => string;
}

/**
 * Generate a run name from the parsed workflow reference.
 *
 * The canonical generator lives in `@trailstep/core`
 * (`packages/core/src/runs/generate-run-name.ts`) so the CLI and the MCP
 * produce the same run name for the same workflow. The CLI derives the
 * readable name from the parsed workflow export name.
 */
export function generateRunName(options: GenerateRunNameOptions): string {
  return generateCoreRunName({
    exportName: options.workflowRef.exportName,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.randomSuffix === undefined ? {} : { randomSuffix: options.randomSuffix }),
  });
}
