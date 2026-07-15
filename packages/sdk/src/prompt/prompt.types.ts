import type { AgentPrompt, PlainObject } from "@stepkit/core";

export type PromptDeclaration<TInput extends PlainObject = PlainObject> =
  | { readonly prompt: AgentPrompt<TInput>; readonly promptUrl?: never }
  | { readonly prompt?: never; readonly promptUrl: string | URL };

export interface PromptDeclarationInput<TInput extends PlainObject = PlainObject> {
  readonly prompt?: AgentPrompt<TInput>;
  readonly promptUrl?: string | URL;
}
