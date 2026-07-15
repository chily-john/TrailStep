import type { AgentStep, PlainObject } from "@stepkit/core";
import { type PromptDeclaration, resolvePromptDeclaration } from "../../prompt/prompt.js";

export type AgentStepBuilderOptions<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
> = Omit<AgentStep<TInput, TOutput>, "prompt"> & PromptDeclaration<TInput>;

export function buildAgentStep<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
>(options: AgentStepBuilderOptions<TInput, TOutput>): AgentStep<TInput, TOutput> {
  const { prompt, promptUrl, ...step } = options;
  return { ...step, prompt: resolvePromptDeclaration({ prompt, promptUrl }, options.id) };
}
