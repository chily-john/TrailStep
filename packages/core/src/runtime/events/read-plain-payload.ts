import type { PlainObject } from "../../contracts/shapes/shape.types.js";
import { isPlainObject } from "../../json/guards.js";
import type { Event } from "../run-workflow/run-workflow.types.js";

/**
 * Reads a payload field off a run event, returning it when present and shaped
 * like a plain object; undefined when the field is missing or not a plain object.
 *
 * Lives in the runtime events layer because it is an event-payload reader; the
 * canonical plain-object guard itself stays in the json guards module.
 */
export function readPlainPayload(event: Event, key: string): PlainObject | undefined {
  const value = event.payload[key];
  return isPlainObject(value) ? value : undefined;
}
