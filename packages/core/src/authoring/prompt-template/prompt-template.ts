import type { PromptTemplateSource } from "../step/continuation.types.js";

/** Loads a step's prompt from a local text file, resolved relative to the workflow's `cwd` at dispatch time. */
export function promptTemplate(path: string): PromptTemplateSource {
  return { kind: "promptTemplate", path };
}
