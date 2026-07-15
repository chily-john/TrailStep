import type { PlainObject } from "@stepkit/core";
import type { AgentStepBuilderOptions } from "./kinds/build-agent-step.js";
import type { CodeStepBuilderOptions } from "./kinds/build-code-step.js";
import type { InteractiveStepBuilderOptions } from "./kinds/build-interactive-step.js";

export type StepBuilderOptions<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
> =
  | CodeStepBuilderOptions<TInput, TOutput>
  | AgentStepBuilderOptions<TInput, TOutput>
  | InteractiveStepBuilderOptions<TOutput>;
