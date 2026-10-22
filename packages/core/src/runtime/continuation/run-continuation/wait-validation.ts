import { normalizeShape } from "../../../authoring/shape/json-schema.js";
import type {
  CheckWaitHelpers,
  WaitCheckResult,
  WaitDefinition,
  WaitPhase,
} from "../../../authoring/step/continuation.types.js";
import type { PlainObject } from "../../../contracts/shapes/shape.types.js";
import { isPlainObject } from "../../../json/guards.js";

export async function resolveWaitDefinition(
  phase: WaitPhase,
  context: {
    readonly input: PlainObject;
    readonly output: PlainObject;
    readonly waits: Readonly<Record<string, PlainObject>>;
  },
): Promise<WaitDefinition> {
  if (typeof phase.wait !== "function") {
    return phase.wait;
  }

  const resolveInputWait = phase.wait as (context: {
    readonly input: PlainObject;
    readonly output: PlainObject;
    readonly waits: Readonly<Record<string, PlainObject>>;
  }) => WaitDefinition | Promise<WaitDefinition>;
  return await resolveInputWait(context);
}

export function createCheckWaitHelpers<
  TWaitOutput extends PlainObject,
>(): CheckWaitHelpers<TWaitOutput> {
  return {
    done(output) {
      return { status: "done", output };
    },
    pending(input) {
      return {
        status: "pending",
        id: input.id,
        message: input.message,
        ...(input.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: input.retryAfterSeconds }),
      };
    },
  };
}

export function validateCheckWaitResult(
  result: unknown,
  stepId: string,
  phaseIndex: number,
): asserts result is WaitCheckResult {
  const label = `step ${stepId} check wait phase ${phaseIndex}`;
  if (!isPlainObject(result)) {
    throw new TypeError(`${label} must return wait.done(...) or wait.pending(...).`);
  }

  if (result.status !== "done" && result.status !== "pending") {
    throw new TypeError(`${label} must return wait.done(...) or wait.pending(...).`);
  }

  if (result.status === "done" && !("output" in result)) {
    throw new TypeError(`${label} wait.done(...) requires output.`);
  }
}

export function validatePendingWait(
  pending: WaitCheckResult,
  stepId: string,
  phaseIndex: number,
): asserts pending is Extract<WaitCheckResult, { readonly status: "pending" }> {
  const label = `step ${stepId} check wait phase ${phaseIndex}`;
  if (pending.status !== "pending") {
    throw new TypeError(`${label} expected a pending result.`);
  }

  if (typeof pending.id !== "string" || pending.id.trim().length === 0) {
    throw new TypeError(`${label} pending result requires a non-empty string id.`);
  }

  if (
    pending.id === "." ||
    pending.id === ".." ||
    pending.id.includes("/") ||
    pending.id.includes("\\")
  ) {
    throw new TypeError(`${label} pending result id must be a single path-safe segment.`);
  }

  if (typeof pending.message !== "string" || pending.message.trim().length === 0) {
    throw new TypeError(`${label} pending result requires a non-empty string message.`);
  }

  if (
    pending.retryAfterSeconds !== undefined &&
    (!Number.isFinite(pending.retryAfterSeconds) || pending.retryAfterSeconds < 0)
  ) {
    throw new TypeError(`${label} pending retryAfterSeconds must be a non-negative number.`);
  }
}

export function validateWaitDefinition(
  wait: WaitDefinition,
  stepId: string,
  phaseIndex: number,
): void {
  const label = `step ${stepId} wait phase ${phaseIndex}`;
  if (!isPlainObject(wait)) {
    throw new TypeError(`${label} must resolve to a wait object.`);
  }

  if (typeof wait.id !== "string" || wait.id.trim().length === 0) {
    throw new TypeError(`${label} requires a non-empty string id.`);
  }

  if (wait.id === "." || wait.id === ".." || wait.id.includes("/") || wait.id.includes("\\")) {
    throw new TypeError(`${label} id must be a single path-safe segment.`);
  }

  if (wait.kind !== "input") {
    throw new TypeError(`${label} kind must be "input".`);
  }

  if (typeof wait.message !== "string" || wait.message.trim().length === 0) {
    throw new TypeError(`${label} requires a non-empty string message.`);
  }

  if (!("output" in wait) || wait.output === undefined) {
    throw new TypeError(`${label} requires an output shape.`);
  }

  normalizeShape(wait.output);
}
