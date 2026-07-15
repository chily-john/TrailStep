import type { AgentPrompt, PlainObject } from "@stepkit/core";
import type { PromptDeclarationInput } from "./prompt.types.js";
import { readInlinePromptSource } from "./sources/inline-prompt-source.js";
import { readLocalMarkdownPromptUrl } from "./sources/local-markdown-prompt-source.js";

export type { PromptDeclaration } from "./prompt.types.js";

export function resolvePromptDeclaration<TInput extends PlainObject = PlainObject>(
  declaration: PromptDeclarationInput<TInput>,
  stepId: string,
): AgentPrompt<TInput> {
  const hasInlinePrompt = declaration.prompt !== undefined;
  const hasPromptUrl = declaration.promptUrl !== undefined;
  if (hasInlinePrompt === hasPromptUrl) {
    throw new TypeError(`Step ${stepId} must declare exactly one of prompt or promptUrl.`);
  }
  if (hasInlinePrompt) {
    return readInlinePromptSource(declaration.prompt as AgentPrompt<TInput>);
  }
  return readLocalMarkdownPromptUrl(declaration.promptUrl, stepId);
}
