import type { RunContextEvent } from "../../contracts/run-context/run-context.types.js";
import type { PlainObject } from "../../contracts/shapes/shape.types.js";
import { isPlainObject } from "../../json/guards.js";

interface CompletedSubPromptEventPayload extends PlainObject {
  readonly parentStepId: string;
  readonly ordinal: number;
  readonly fingerprint: string;
  readonly output: PlainObject;
}

export function findCompletedSubPromptEvent(
  events: readonly RunContextEvent[],
  parentStepId: string,
  ordinal: number,
  fingerprint: string,
): RunContextEvent<CompletedSubPromptEventPayload> | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "subPrompt.completed") {
      continue;
    }

    const payload = event.payload;
    if (
      payload.parentStepId === parentStepId &&
      payload.ordinal === ordinal &&
      payload.fingerprint === fingerprint &&
      isPlainObject(payload.output)
    ) {
      return event as RunContextEvent<CompletedSubPromptEventPayload>;
    }
  }

  return undefined;
}
