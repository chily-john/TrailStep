import type { AgentPrompt, PlainObject } from "@stepkit/core";

export function readInlinePromptSource<TInput extends PlainObject = PlainObject>(
  prompt: AgentPrompt<TInput>,
): AgentPrompt<TInput> {
  return prompt;
}
