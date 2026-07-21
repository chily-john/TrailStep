import type { AgentPrompt } from "../../contracts/agents/agent-adapter.types.js";
import type { Failure } from "../../contracts/failures/failure.js";
import type { PlainObject } from "../../contracts/shapes/shape.types.js";
import type {
  ContinuationStepConfig,
  DoneNode,
  FailNode,
  PromptTemplateSource,
  StepConfig,
  StepContinuation,
  StepErrorContinuation,
  StepFactory,
  StepNode,
} from "../step/continuation.types.js";

/**
 * The only step-authoring primitive. `.prompt(...)` is optional; when present,
 * the step dispatches to an agent and `.next(...)` receives its structured
 * output. When absent, nothing is dispatched — `.next(...)` receives the
 * step's input directly and is responsible for the work and the continuation
 * in one function. Either way, `.next(...)` produces a reusable `StepFactory`
 * — call it with a live input value (`stepA(input)`) to get a `StepNode`.
 * When the inferred input type has no required keys, the argument is
 * optional (`stepA()`) and defaults to `{}`.
 */
export function step<TOutput extends PlainObject = PlainObject>(
  config: StepConfig<TOutput>,
): {
  prompt<TInput extends PlainObject = PlainObject>(
    source: AgentPrompt<TInput> | PromptTemplateSource,
  ): {
    next(onOutput: StepContinuation<TOutput>): StepFactory<TInput, TOutput>;
  };
  next<TInput extends PlainObject = PlainObject>(
    onOutput: StepContinuation<TInput>,
  ): StepFactory<TInput, TInput>;
} {
  const buildFactory = <TInput extends PlainObject, TStepOutput extends PlainObject>(
    prompt: AgentPrompt<TInput> | PromptTemplateSource | undefined,
    onOutput: StepContinuation<TStepOutput>,
    onError?: StepErrorContinuation,
  ): StepFactory<TInput, TStepOutput> => {
    const factory = ((input?: TInput): StepNode<TInput, TStepOutput> => ({
      kind: "step",
      config: {
        ...config,
        prompt,
        input: input ?? ({} as TInput),
      } as ContinuationStepConfig<TInput, TStepOutput>,
      onOutput,
      onError,
    })) as StepFactory<TInput, TStepOutput>;

    factory.catch = (nextOnError: StepErrorContinuation) =>
      buildFactory(prompt, onOutput, nextOnError);

    return factory;
  };

  return {
    prompt(source) {
      return {
        next: (onOutput) => buildFactory(source, onOutput),
      };
    },
    next(onOutput) {
      return buildFactory(undefined, onOutput);
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
