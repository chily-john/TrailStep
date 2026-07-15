import type { PlainObject } from "../shared/shape.types.js";
import type { Event } from "./engine.types.js";

let eventCounter = 0;

export function createEvent(options: {
  readonly runId: string;
  readonly workflowId: string;
  readonly stepId?: string;
  readonly type: Event["type"];
  readonly payload?: PlainObject;
}): Event {
  eventCounter += 1;

  return {
    id: `evt_${eventCounter}`,
    runId: options.runId,
    workflowId: options.workflowId,
    stepId: options.stepId,
    type: options.type,
    timestamp: new Date().toISOString(),
    schemaVersion: "v0",
    payload: options.payload ?? {},
  };
}
