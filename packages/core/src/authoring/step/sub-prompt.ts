import type { AgentPrompt } from "../../contracts/agents/agent-adapter.types.js";
import type { PlainObject } from "../../contracts/shapes/shape.types.js";
import { runSubPrompt } from "../../runtime/sub-prompts/run-sub-prompt.js";
import type {
  PromptTemplateSource,
  SubPromptFactory,
  SubPromptOptions,
} from "./continuation.types.js";

export function subPrompt<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
>(
  source: AgentPrompt<TInput> | PromptTemplateSource,
  options: SubPromptOptions<TOutput>,
): SubPromptFactory<TInput, TOutput> {
  const run = (input?: TInput): Promise<TOutput> => runSubPrompt(source, options, input);

  return run as SubPromptFactory<TInput, TOutput>;
}
