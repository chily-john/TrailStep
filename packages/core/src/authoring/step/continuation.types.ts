import type {
  AgentAdapterSelection,
  AgentPrompt,
} from "../../contracts/agents/agent-adapter.types.js";
import type { Failure } from "../../contracts/failures/failure.js";
import type { RunContext } from "../../contracts/run-context/run-context.types.js";
import type { PlainObject, ShapeInput } from "../../contracts/shapes/shape.types.js";

/** A local text file to load a prompt's content from, resolved relative to the workflow's `cwd` at dispatch time. */
export interface PromptTemplateSource {
  readonly kind: "promptTemplate";
  readonly path: string;
}

/**
 * The object passed to `step(...)`. No `input` (supplied when the resulting
 * `StepFactory` is called) and no `run` (there is no separate code runner —
 * omitting `.prompt(...)` means `.next(...)` receives the step's input
 * directly and does the work itself). `outputShape` only matters when
 * `.prompt(...)` is used — it constrains the agent's structured-output tool;
 * it's unused for a step with no prompt.
 */
export interface StepConfig<TOutput extends PlainObject = PlainObject> {
  readonly id: string;
  readonly outputShape?: ShapeInput<TOutput>;
  readonly agent?: string;
  readonly agentMode?: "working" | "interactive";
  readonly adapter?: AgentAdapterSelection<PlainObject, TOutput>;
}

/** The runtime shape stored in `StepNode.config` — `StepConfig` plus the resolved `input` and `prompt` source. */
export interface ContinuationStepConfig<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
> {
  readonly id: string;
  readonly input: TInput;
  readonly outputShape?: ShapeInput<TOutput>;
  readonly prompt?: AgentPrompt<TInput> | PromptTemplateSource;
  readonly agent?: string;
  readonly agentMode?: "working" | "interactive";
  readonly adapter?: AgentAdapterSelection<TInput, TOutput>;
}

export type StepContinuation<TOutput extends PlainObject = PlainObject> = {
  bivarianceHack(
    output: TOutput,
    ctx: RunContext,
  ): ContinuationResult | Promise<ContinuationResult>;
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
  readonly onOutput: StepContinuation<TOutput>;
  readonly onError?: StepErrorContinuation;
}

/**
 * Returned by `step(...).prompt(...)?.next(...)`: a reusable step definition,
 * called with a live input value to produce an actual `StepNode`
 * (`stepA(input)`). Chain `.catch(...)` to add an error continuation before
 * calling it. When `TInput` has no required keys (e.g. a step that ignores
 * its input), the call is `stepA()` — the input argument is optional.
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

export interface DoneNode<TOutput extends PlainObject = PlainObject> {
  readonly kind: "done";
  readonly output: TOutput;
}

/** Terminates the workflow as a failure without dispatching a step — no step.* events, just workflow.failed. */
export interface FailNode {
  readonly kind: "fail";
  readonly failure: Failure;
}

export type ContinuationResult<TOutput extends PlainObject = PlainObject> =
  | StepNode<PlainObject, PlainObject>
  | DoneNode<TOutput>
  | FailNode;
