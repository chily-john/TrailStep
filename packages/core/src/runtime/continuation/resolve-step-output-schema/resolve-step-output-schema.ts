import { normalizeShape } from "../../../authoring/shape/json-schema.js";
import type { PlainObject, Schema, ShapeInput } from "../../../contracts/shapes/shape.types.js";
import { DEFAULT_INTERACTIVE_OUTPUT_SHAPE } from "../../interactive-session/default-interactive-output-shape.js";

/**
 * A prompt step's effective output schema: its own `output`, or -- for an
 * interactive step with none given -- the default interactive output shape.
 * Shared by dispatch (`runContinuation`) and both resume paths
 * (`reattachInProgressStep`, `replayCompletedSteps`), which must all resolve
 * the identical schema a step was originally dispatched with.
 */
export function resolveStepOutputSchema(config: {
  readonly output?: ShapeInput<PlainObject>;
  readonly mode?: "working" | "interactive";
}): Schema<PlainObject> | undefined {
  const effectiveOutput =
    config.output ?? (config.mode === "interactive" ? DEFAULT_INTERACTIVE_OUTPUT_SHAPE : undefined);

  return effectiveOutput ? normalizeShape(effectiveOutput) : undefined;
}
