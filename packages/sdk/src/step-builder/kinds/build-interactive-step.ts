import type { InteractiveStep, PlainObject } from "@stepkit/core";
import { type PromptDeclaration, resolvePromptDeclaration } from "../../prompt/prompt.js";

export type InteractiveStepBuilderOptions<TOutput extends PlainObject = PlainObject> = Omit<
  InteractiveStep<TOutput>,
  "prompt"
> &
  PromptDeclaration;

export function buildInteractiveStep<TOutput extends PlainObject = PlainObject>(
  options: InteractiveStepBuilderOptions<TOutput>,
): InteractiveStep<TOutput> {
  const { prompt, promptUrl, ...step } = options;
  return {
    ...step,
    prompt: resolvePromptDeclaration({ prompt, promptUrl }, options.id),
  } as InteractiveStep<TOutput>;
}
