import { randomUUID } from "node:crypto";

import type { PlainObject } from "../../contracts/shapes/shape.types.js";
import type { Event } from "../../runtime/run-workflow/run-workflow.types.js";

export function createEvent(options: {
  readonly runId: string;
  readonly workflowId: string;
  readonly stepId?: string;
  readonly type: Event["type"];
  readonly payload?: PlainObject;
}): Event {
  return {
    id: `evt_${randomUUID()}`,
    runId: options.runId,
    workflowId: options.workflowId,
    stepId: options.stepId,
    type: options.type,
    timestamp: new Date().toISOString(),
    schemaVersion: "v0",
    payload: options.payload ?? {},
  };
}
