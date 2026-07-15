import type { PlainObject, Step } from "@stepkit/core";
import { assertBuilderObject } from "../shared/assert-builder-object.js";
import { buildAgentStep } from "./kinds/build-agent-step.js";
import { buildCodeStep } from "./kinds/build-code-step.js";
import { buildInteractiveStep } from "./kinds/build-interactive-step.js";
import type { StepBuilderOptions } from "./step-builder.types.js";

/** @deprecated Compatibility scaffolding for old object-form step tests. Prefer the unified `step(...)` primitive. */
export function defineStep<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
>(options: StepBuilderOptions<TInput, TOutput>): Step<TInput, TOutput> {
  assertBuilderObject(options, "defineStep");
  if (options.kind === "code") return buildCodeStep(options);
  if (options.kind === "agent") return buildAgentStep(options);
  if (options.kind === "interactive") return buildInteractiveStep(options);
  throw new TypeError(
    'defineStep supports object-form steps with kind "code", "agent", or "interactive".',
  );
}
