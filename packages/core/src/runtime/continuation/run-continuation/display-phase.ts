import type { DisplayPhase, StepDisplayValue } from "../../../authoring/step/continuation.types.js";
import type { PlainObject } from "../../../contracts/shapes/shape.types.js";
import { isPlainObject } from "../../../json/guards.js";

export async function resolveDisplayPayload(options: {
  readonly phase: DisplayPhase;
  readonly input: PlainObject;
  readonly output: PlainObject;
  readonly phaseIndex: number;
  readonly stepId: string;
}): Promise<PlainObject> {
  const { phase, input, output, phaseIndex, stepId } = options;
  const rawValue =
    typeof phase.content === "function" ? await phase.content({ input, output }) : phase.content;

  const display = normalizeDisplayValue(rawValue, { stepId, phaseIndex });
  if (typeof display === "string") {
    return { message: display, level: "info", phaseIndex };
  }

  return {
    message: display.message,
    level: display.level ?? "info",
    ...("data" in display ? { data: display.data } : {}),
    phaseIndex,
  };
}

function normalizeDisplayValue(
  value: unknown,
  context: { readonly stepId: string; readonly phaseIndex: number },
): StepDisplayValue {
  const label = `step ${context.stepId} display phase ${context.phaseIndex}`;

  if (typeof value === "string") {
    return value;
  }

  if (!isPlainObject(value) || typeof value.message !== "string") {
    throw new TypeError(`${label} must resolve to a string or an object with a string message.`);
  }

  const level = value.level ?? "info";
  if (!isDisplayLevel(level)) {
    throw new TypeError(`${label} level must be one of: info, warning, error, debug.`);
  }

  return {
    message: value.message,
    level,
    ...("data" in value ? { data: value.data } : {}),
  };
}

function isDisplayLevel(value: unknown): value is "info" | "warning" | "error" | "debug" {
  return value === "info" || value === "warning" || value === "error" || value === "debug";
}
