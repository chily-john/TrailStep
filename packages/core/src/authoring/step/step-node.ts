import type { AgentPrompt } from "../../contracts/agents/agent-adapter.types.js";
import type { Failure } from "../../contracts/failures/failure.js";
import type { PlainObject } from "../../contracts/shapes/shape.types.js";
import type {
  ContinuationStepConfig,
  DoneNode,
  FailNode,
  PromptOptions,
  PromptTemplateSource,
  StepConfig,
  StepContinuation,
  StepErrorContinuation,
  StepFactory,
  StepNode,
} from "../step/continuation.types.js";

/**
 * The only step-authoring primitive. `.prompt(...)` is optional; when present,
 * the step dispatches to an agent and `.do(...)` receives its structured
 * output. When absent, nothing is dispatched -- `.do(...)` receives the
 * step's input directly and is responsible for the work and the continuation
 * in one function. Either way, `.do(...)` produces a reusable `StepFactory`
 * -- call it with a live input value (`stepA(input)`) to get a `StepNode`.
 * When the inferred input type has no required keys, the argument is
 * optional (`stepA()`) and defaults to `{}`.
 */
export function step(config: StepConfig): {
  prompt<TInput extends PlainObject = PlainObject, TOutput extends PlainObject = PlainObject>(
    source: AgentPrompt<TInput> | PromptTemplateSource,
    options?: PromptOptions<TOutput>,
  ): {
    do(onOutput: StepContinuation<TInput, TOutput>): StepFactory<TInput, TOutput>;
  };
  do<TInput extends PlainObject = PlainObject>(
    onOutput: StepContinuation<TInput, TInput>,
  ): StepFactory<TInput, TInput>;
} {
  const buildFactory = <TInput extends PlainObject, TStepOutput extends PlainObject>(
    prompt: AgentPrompt<TInput> | PromptTemplateSource | undefined,
    promptOptions: PromptOptions<TStepOutput> | undefined,
    onOutput: StepContinuation<TInput, TStepOutput>,
    onError?: StepErrorContinuation,
  ): StepFactory<TInput, TStepOutput> => {
    const factory = ((input?: TInput): StepNode<TInput, TStepOutput> => ({
      kind: "step",
      config: {
        ...config,
        ...promptOptions,
        prompt,
        input: input ?? ({} as TInput),
      } as ContinuationStepConfig<TInput, TStepOutput>,
      onOutput,
      onError,
    })) as StepFactory<TInput, TStepOutput>;

    factory.catch = (nextOnError: StepErrorContinuation) =>
      buildFactory(prompt, promptOptions, onOutput, nextOnError);

    return factory;
  };

  return {
    prompt(source, options) {
      return {
        do: (onOutput) => buildFactory(source, options, onOutput),
      };
    },
    do(onOutput) {
      return buildFactory(undefined, undefined, onOutput);
    },
  };
}

export function done<TOutput extends PlainObject = PlainObject>(
  output?: TOutput,
): DoneNode<TOutput> {
  return {
    kind: "done",
    output: output ?? ({} as TOutput),
  };
}

export function fail(failure: Failure): FailNode {
  return {
    kind: "fail",
    failure,
  };
}

export function isStepNode(value: unknown): value is StepNode {
  return isPlainObject(value) && value.kind === "step";
}

export function isDoneNode(value: unknown): value is DoneNode {
  return isPlainObject(value) && value.kind === "done";
}

export function isFailNode(value: unknown): value is FailNode {
  return isPlainObject(value) && value.kind === "fail";
}

function isPlainObject(value: unknown): value is PlainObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
