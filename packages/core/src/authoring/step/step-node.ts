import type { AgentPrompt } from "../../contracts/agents/agent-adapter.types.js";
import type { Failure } from "../../contracts/failures/failure.js";
import type { PlainObject } from "../../contracts/shapes/shape.types.js";
import type {
  AbsoluteDoneNode,
  AbsoluteFailNode,
  CheckWaitCallback,
  ContinuationStepConfig,
  DisplayPhase,
  DoneNode,
  DoPhase,
  FailNode,
  PromptOptions,
  PromptPhase,
  PromptTemplateSource,
  StepConfig,
  StepContextContinuation,
  StepContinuation,
  StepDisplayContent,
  StepErrorContinuation,
  StepFactory,
  StepNode,
  StepPhase,
  TerminalMessageOptions,
  WaitInput,
  WaitOptions,
  WaitPhase,
  WorkflowInvocationNode,
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
interface StepBuilder {
  display(
    content?: StepDisplayContent<PlainObject, PlainObject>,
    options?: PlainObject,
  ): StepBuilder;
  wait(wait: WaitInput<PlainObject, PlainObject>): StepBuilder;
  wait<TWaitOutput extends PlainObject = PlainObject>(
    wait: CheckWaitCallback<PlainObject, PlainObject, TWaitOutput>,
    options: WaitOptions<TWaitOutput>,
  ): StepBuilder;
  prompt<TInput extends PlainObject = PlainObject, TOutput extends PlainObject = PlainObject>(
    source: AgentPrompt<TInput> | PromptTemplateSource,
    options?: PromptOptions<TOutput>,
  ): PromptedStepBuilder<TInput, TOutput>;
  do<TInput extends PlainObject = PlainObject>(
    onOutput: StepContextContinuation<TInput, TInput>,
  ): FluentStepFactory<TInput, TInput>;
  do<TInput extends PlainObject = PlainObject>(
    onOutput: StepContinuation<TInput, TInput>,
  ): FluentStepFactory<TInput, TInput>;
}

interface PromptedStepBuilder<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
> {
  display(
    content?: StepDisplayContent<TInput, TOutput>,
    options?: PlainObject,
  ): PromptedStepBuilder<TInput, TOutput>;
  wait(wait: WaitInput<TInput, TOutput>): PromptedStepBuilder<TInput, TOutput>;
  wait<TWaitOutput extends PlainObject = PlainObject>(
    wait: CheckWaitCallback<TInput, TOutput, TWaitOutput>,
    options: WaitOptions<TWaitOutput>,
  ): PromptedStepBuilder<TInput, TOutput>;
  do(onOutput: StepContextContinuation<TInput, TOutput>): FluentStepFactory<TInput, TOutput>;
  do(onOutput: StepContinuation<TInput, TOutput>): FluentStepFactory<TInput, TOutput>;
}

type FluentStepFactory<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
> = StepFactory<TInput, TOutput> & {
  catch(onError: StepErrorContinuation): FluentStepFactory<TInput, TOutput>;
  display(
    content?: StepDisplayContent<TInput, TOutput>,
    options?: PlainObject,
  ): FluentStepFactory<TInput, TOutput>;
  wait(wait: WaitInput<TInput, TOutput>): FluentStepFactory<TInput, TOutput>;
  wait<TWaitOutput extends PlainObject = PlainObject>(
    wait: CheckWaitCallback<TInput, TOutput, TWaitOutput>,
    options: WaitOptions<TWaitOutput>,
  ): FluentStepFactory<TInput, TOutput>;
};

export function step(config: StepConfig): StepBuilder {
  const makeBuilder = (phaseTemplates: readonly StepPhase[] = []): StepBuilder => ({
    display(content, options) {
      return makeBuilder([...phaseTemplates, displayPhase(content, options)]);
    },
    wait(
      wait: WaitInput<PlainObject, PlainObject> | CheckWaitCallback<PlainObject, PlainObject>,
      options?: WaitOptions,
    ) {
      return makeBuilder([...phaseTemplates, waitPhase(wait, options)]);
    },
    prompt<TInput extends PlainObject = PlainObject, TStepOutput extends PlainObject = PlainObject>(
      source: AgentPrompt<TInput> | PromptTemplateSource,
      options?: PromptOptions<TStepOutput>,
    ) {
      assertPromptOptions(options);
      return makePromptedBuilder<TInput, TStepOutput>([
        ...(phaseTemplates as readonly StepPhase<TInput, TStepOutput>[]),
        promptPhase(source, options),
      ]);
    },
    do<TInput extends PlainObject = PlainObject>(onOutput: StepContinuation<TInput, TInput>) {
      return buildFactory<TInput, TInput>(
        [...(phaseTemplates as readonly StepPhase<TInput, TInput>[]), doPhase(onOutput)],
        onOutput,
      );
    },
  });

  const makePromptedBuilder = <TInput extends PlainObject, TStepOutput extends PlainObject>(
    phaseTemplates: readonly StepPhase<TInput, TStepOutput>[],
  ): PromptedStepBuilder<TInput, TStepOutput> => ({
    display(content, options) {
      return makePromptedBuilder([...phaseTemplates, displayPhase(content, options)]);
    },
    wait(
      wait: WaitInput<TInput, TStepOutput> | CheckWaitCallback<TInput, TStepOutput>,
      options?: WaitOptions,
    ) {
      return makePromptedBuilder([...phaseTemplates, waitPhase(wait, options)]);
    },
    do(onOutput) {
      return buildFactory([...phaseTemplates, doPhase(onOutput)], onOutput);
    },
  });

  const buildFactory = <TInput extends PlainObject, TStepOutput extends PlainObject>(
    phaseTemplates: readonly StepPhase<TInput, TStepOutput>[],
    onOutput: StepContinuation<TInput, TStepOutput> | StepContextContinuation<TInput, TStepOutput>,
    onError?: StepErrorContinuation,
  ): FluentStepFactory<TInput, TStepOutput> => {
    const factory = ((input?: TInput): StepNode<TInput, TStepOutput> => {
      const phases = phaseTemplates.slice();
      const prompt = firstPromptPhase(phases);

      return {
        kind: "step",
        config: {
          ...config,
          ...(prompt ? promptOptionsForConfig(prompt) : {}),
          input: input ?? ({} as TInput),
        } as ContinuationStepConfig<TInput, TStepOutput>,
        phases,
        onOutput: onOutput as StepContinuation<TInput, TStepOutput>,
        onError,
      };
    }) as FluentStepFactory<TInput, TStepOutput>;

    factory.catch = (nextOnError: StepErrorContinuation) =>
      buildFactory(phaseTemplates, onOutput, nextOnError);
    factory.display = (content?: StepDisplayContent<TInput, TStepOutput>, options?: PlainObject) =>
      buildFactory([...phaseTemplates, displayPhase(content, options)], onOutput, onError);
    factory.wait = (
      wait: WaitInput<TInput, TStepOutput> | CheckWaitCallback<TInput, TStepOutput>,
      options?: WaitOptions,
    ) => buildFactory([...phaseTemplates, waitPhase(wait, options)], onOutput, onError);

    return factory;
  };

  return makeBuilder();
}

export function done<TOutput extends PlainObject = PlainObject>(
  output?: TOutput,
  options?: TerminalMessageOptions,
): DoneNode<TOutput> {
  return {
    kind: "done",
    output: output ?? ({} as TOutput),
    ...(options?.message === undefined ? {} : { message: options.message }),
  };
}

export function fail(failure: Failure, options?: TerminalMessageOptions): FailNode {
  return {
    kind: "fail",
    failure,
    ...(options?.message === undefined ? {} : { message: options.message }),
  };
}

export function absoluteDone<TOutput extends PlainObject = PlainObject>(
  output?: TOutput,
  options?: TerminalMessageOptions,
): AbsoluteDoneNode<TOutput> {
  return {
    kind: "absoluteDone",
    output: output ?? ({} as TOutput),
    ...(options?.message === undefined ? {} : { message: options.message }),
  };
}

export function absoluteFail(failure: Failure, options?: TerminalMessageOptions): AbsoluteFailNode {
  return {
    kind: "absoluteFail",
    failure,
    ...(options?.message === undefined ? {} : { message: options.message }),
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

export function isWorkflowInvocationNode(value: unknown): value is WorkflowInvocationNode {
  return isPlainObject(value) && value.kind === "workflowInvocation";
}

export function isAbsoluteDoneNode(value: unknown): value is AbsoluteDoneNode {
  return isPlainObject(value) && value.kind === "absoluteDone";
}

export function isAbsoluteFailNode(value: unknown): value is AbsoluteFailNode {
  return isPlainObject(value) && value.kind === "absoluteFail";
}

/** Returns a step's ordered phases, synthesizing phases for legacy StepNode-shaped objects. */
export function getStepPhases<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
>(node: StepNode<TInput, TOutput>): readonly StepPhase<TInput, TOutput>[] {
  if (Array.isArray(node.phases)) {
    return node.phases;
  }

  const phases: StepPhase<TInput, TOutput>[] = [];
  if (node.config.prompt !== undefined) {
    phases.push(
      promptPhase(node.config.prompt, {
        ...(node.config.output === undefined ? {} : { output: node.config.output }),
        ...(node.config.agent === undefined ? {} : { agent: node.config.agent }),
        ...(node.config.mode === undefined ? {} : { mode: node.config.mode }),
        ...(node.config.adapter === undefined ? {} : { adapter: node.config.adapter }),
        ...(node.config.maxSubPrompts === undefined
          ? {}
          : { maxSubPrompts: node.config.maxSubPrompts }),
      }),
    );
  }
  phases.push(doPhase(node.onOutput));
  return phases;
}

export function hasPromptPhase(node: StepNode): boolean {
  return getStepPhases(node).some((phase) => phase.kind === "prompt");
}

export function firstPromptPhase(phases: readonly StepPhase[]): PromptPhase | undefined {
  return phases.find((phase): phase is PromptPhase => phase.kind === "prompt");
}

function displayPhase<TInput extends PlainObject, TOutput extends PlainObject>(
  content?: StepDisplayContent<TInput, TOutput>,
  options?: PlainObject,
): DisplayPhase<TInput, TOutput> {
  return {
    kind: "display",
    ...(content === undefined ? {} : { content }),
    ...(options === undefined ? {} : { options }),
  };
}

function waitPhase<TInput extends PlainObject, TOutput extends PlainObject>(
  wait: WaitInput<TInput, TOutput> | CheckWaitCallback<TInput, TOutput>,
  options?: WaitOptions,
): WaitPhase<TInput, TOutput> {
  return {
    kind: "wait",
    wait,
    ...(options === undefined ? {} : { options }),
  };
}

function promptPhase<TInput extends PlainObject, TOutput extends PlainObject>(
  prompt: AgentPrompt<TInput> | PromptTemplateSource,
  options?: PromptOptions<TOutput>,
): PromptPhase<TInput, TOutput> {
  return {
    kind: "prompt",
    ...options,
    prompt,
  };
}

function doPhase<TInput extends PlainObject, TOutput extends PlainObject>(
  onOutput: StepContinuation<TInput, TOutput> | StepContextContinuation<TInput, TOutput>,
): DoPhase<TInput, TOutput> {
  return { kind: "do", onOutput: onOutput as StepContinuation<TInput, TOutput> };
}

function promptOptionsForConfig<TInput extends PlainObject, TOutput extends PlainObject>(
  phase: PromptPhase<TInput, TOutput>,
): Omit<PromptPhase<TInput, TOutput>, "kind"> {
  const { kind: _kind, ...options } = phase;
  return options;
}

function assertPromptOptions(value: unknown): void {
  if (hasRetryOption(value)) {
    throw new TypeError("Retry config belongs on step(...), not .prompt(...) options.");
  }

  if (hasTimeoutOption(value)) {
    throw new TypeError("Timeout config belongs on step(...), not .prompt(...) options.");
  }
}

function hasRetryOption(value: unknown): boolean {
  return isPlainObject(value) && "retry" in value;
}

function hasTimeoutOption(value: unknown): boolean {
  return isPlainObject(value) && "timeout" in value;
}

function isPlainObject(value: unknown): value is PlainObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
