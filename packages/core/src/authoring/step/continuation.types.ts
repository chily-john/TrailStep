import type {
  AgentAdapterSelection,
  AgentPrompt,
} from "../../contracts/agents/agent-adapter.types.js";
import type { Failure } from "../../contracts/failures/failure.js";
import type { PlainObject, ShapeInput } from "../../contracts/shapes/shape.types.js";
import type { RetryPolicyInput } from "../../runtime/retry/retry-policy.js";
import type { TimeoutPolicyInput } from "../../runtime/timeout/timeout-policy.js";

/** A local text file to load a prompt's content from, resolved relative to the workflow's `cwd` at dispatch time. */
export interface PromptTemplateSource {
  readonly kind: "promptTemplate";
  readonly path: string;
}

/** The object passed to `step(...)`. Always relevant, regardless of whether `.prompt(...)` is called. */
export interface StepConfig {
  readonly id: string;
  readonly retry?: RetryPolicyInput;
  readonly timeout?: TimeoutPolicyInput;
}

/**
 * The object passed as `.prompt(...)`'s second argument -- config that only
 * matters when a step dispatches to an agent, so it lives here instead of
 * on `StepConfig` where a no-prompt step could set it and have it silently
 * ignored. `output` constrains the agent's structured-output tool.
 */
export interface PromptOptions<TOutput extends PlainObject = PlainObject> {
  readonly output?: ShapeInput<TOutput>;
  readonly agent?: string;
  readonly mode?: "working" | "interactive";
  readonly adapter?: AgentAdapterSelection<PlainObject, TOutput>;
  readonly maxSubPrompts?: number;
}

export interface SubPromptOptions<TOutput extends PlainObject = PlainObject> {
  readonly output?: ShapeInput<TOutput>;
  readonly agent?: string;
  readonly adapter?: AgentAdapterSelection<PlainObject, TOutput>;
  readonly maxSubPrompts?: number;
}

/** The runtime shape stored in `StepNode.config` -- `StepConfig` plus `PromptOptions` (when a prompt was given) plus the resolved `input` and `prompt` source. */
export interface ContinuationStepConfig<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
> {
  readonly id: string;
  readonly input: TInput;
  readonly output?: ShapeInput<TOutput>;
  readonly prompt?: AgentPrompt<TInput> | PromptTemplateSource;
  readonly agent?: string;
  readonly mode?: "working" | "interactive";
  readonly adapter?: AgentAdapterSelection<TInput, TOutput>;
  readonly maxSubPrompts?: number;
  readonly retry?: RetryPolicyInput;
  readonly timeout?: TimeoutPolicyInput;
}

export type StepContinuation<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
> = {
  bivarianceHack(output: TOutput, input: TInput): ContinuationResult | Promise<ContinuationResult>;
}["bivarianceHack"];

export type StepErrorContinuation = {
  bivarianceHack(error: Failure): ContinuationResult;
}["bivarianceHack"];

export interface StepNode<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
> {
  readonly kind: "step";
  readonly config: ContinuationStepConfig<TInput, TOutput>;
  /** Receives the step's own input as the second argument, alongside its output as the first. */
  readonly onOutput: StepContinuation<TInput, TOutput>;
  readonly onError?: StepErrorContinuation;
}

/**
 * Returned by `step(...).prompt(...)?.do(...)`: a reusable step definition,
 * called with a live input value to produce an actual `StepNode`
 * (`stepA(input)`). Chain `.catch(...)` to add an error continuation before
 * calling it. When `TInput` has no required keys (e.g. a step that ignores
 * its input), the call is `stepA()` -- the input argument is optional.
 */
export type StepFactory<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
  // biome-ignore lint/complexity/noBannedTypes: `{}` here is the standard conditional-type idiom for "TInput has no required keys", not a stand-in for "any value".
> = ({} extends TInput
  ? (input?: TInput) => StepNode<TInput, TOutput>
  : (input: TInput) => StepNode<TInput, TOutput>) & {
  catch(onError: StepErrorContinuation): StepFactory<TInput, TOutput>;
};

export type SubPromptFactory<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
  // biome-ignore lint/complexity/noBannedTypes: `{}` here is the standard conditional-type idiom for "TInput has no required keys", not a stand-in for "any value".
> = {} extends TInput ? (input?: TInput) => Promise<TOutput> : (input: TInput) => Promise<TOutput>;

export interface DoneNode<TOutput extends PlainObject = PlainObject> {
  readonly kind: "done";
  readonly output: TOutput;
}

/** Terminates the workflow as a failure without dispatching a step -- no step.* events, just workflow.failed. */
export interface FailNode {
  readonly kind: "fail";
  readonly failure: Failure;
}

export type ContinuationResult<TOutput extends PlainObject = PlainObject> =
  | StepNode<PlainObject, PlainObject>
  | DoneNode<TOutput>
  | FailNode;
