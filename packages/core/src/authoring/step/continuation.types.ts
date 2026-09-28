import type {
  AgentAdapterSelection,
  AgentPrompt,
} from "../../contracts/agents/agent-adapter.types.js";
import type { Failure } from "../../contracts/failures/failure.js";
import type { RunContextState } from "../../contracts/run-context/run-context.types.js";
import type { PlainObject, ShapeInput } from "../../contracts/shapes/shape.types.js";
import type { RetryPolicyInput } from "../../runtime/retry/retry-policy.js";
import type { TimeoutPolicyInput } from "../../runtime/timeout/timeout-policy.js";
import type { Workflow } from "../workflow/workflow.types.js";

/** A local text file to load a prompt's content from, resolved relative to the workflow/project `cwd` at dispatch time. */
export interface PromptTemplateSource {
  readonly kind: "promptTemplate";
  readonly path: string;
}

export interface StepCwdContext<TInput extends PlainObject = PlainObject> {
  readonly input: TInput;
  readonly state: RunContextState;
  readonly workflow: {
    readonly id: string;
  };
}

export type StepCwdCallback<TInput extends PlainObject = PlainObject> = {
  bivarianceHack(context: StepCwdContext<TInput>): unknown | Promise<unknown>;
}["bivarianceHack"];

export type StepCwdInput<TInput extends PlainObject = PlainObject> =
  | string
  | StepCwdCallback<TInput>;

/** The object passed to `step(...)`. Always relevant, regardless of whether `.prompt(...)` is called. */
export interface StepConfig {
  readonly id: string;
  readonly title?: string;
  readonly description?: string;
  readonly cwd?: StepCwdInput;
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

export type StepDisplayLevel = "info" | "warning" | "error" | "debug";

export interface StepDisplayObject {
  readonly message: string;
  readonly level?: StepDisplayLevel;
  readonly data?: unknown;
}

export type StepDisplayValue = string | StepDisplayObject;

export interface StepDisplayContext<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
> {
  readonly input: TInput;
  readonly output: TOutput;
}

export type StepDisplayCallback<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
> = {
  bivarianceHack(
    context: StepDisplayContext<TInput, TOutput>,
  ): StepDisplayValue | Promise<StepDisplayValue>;
}["bivarianceHack"];

export type StepDisplayContent<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
> = StepDisplayValue | StepDisplayCallback<TInput, TOutput>;

/** Ordered phase for durable progress display events. */
export interface DisplayPhase<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
> {
  readonly kind: "display";
  readonly content?: StepDisplayContent<TInput, TOutput>;
  readonly options?: PlainObject;
}

export interface WaitDefinition<TWaitOutput extends PlainObject = PlainObject> {
  readonly id: string;
  readonly kind: "input";
  readonly message: string;
  readonly output: ShapeInput<TWaitOutput>;
}

export interface WaitOptions<TWaitOutput extends PlainObject = PlainObject> {
  readonly output: ShapeInput<TWaitOutput>;
}

export interface WaitPendingInput {
  readonly id: string;
  readonly message: string;
  readonly retryAfterSeconds?: number;
}

export interface WaitPendingResult {
  readonly status: "pending";
  readonly id: string;
  readonly message: string;
  readonly retryAfterSeconds?: number;
}

export interface WaitDoneResult<TWaitOutput extends PlainObject = PlainObject> {
  readonly status: "done";
  readonly output: TWaitOutput;
}

export type WaitCheckResult<TWaitOutput extends PlainObject = PlainObject> =
  | WaitDoneResult<TWaitOutput>
  | WaitPendingResult;

export interface CheckWaitHelpers<TWaitOutput extends PlainObject = PlainObject> {
  done(output: TWaitOutput): WaitDoneResult<TWaitOutput>;
  pending(input: WaitPendingInput): WaitPendingResult;
}

export interface StepWaitContext<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
> {
  readonly input: TInput;
  readonly output: TOutput;
  readonly waits: Readonly<Record<string, PlainObject>>;
}

export interface CheckWaitContext<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
  TWaitOutput extends PlainObject = PlainObject,
> extends StepWaitContext<TInput, TOutput> {
  readonly wait: CheckWaitHelpers<TWaitOutput>;
}

export type WaitCallback<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
  TWaitOutput extends PlainObject = PlainObject,
> = {
  bivarianceHack(
    context: StepWaitContext<TInput, TOutput>,
  ): WaitDefinition<TWaitOutput> | Promise<WaitDefinition<TWaitOutput>>;
}["bivarianceHack"];

export type CheckWaitCallback<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
  TWaitOutput extends PlainObject = PlainObject,
> = {
  bivarianceHack(
    context: CheckWaitContext<TInput, TOutput, TWaitOutput>,
  ): WaitCheckResult<TWaitOutput> | Promise<WaitCheckResult<TWaitOutput>>;
}["bivarianceHack"];

export type WaitInput<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
  TWaitOutput extends PlainObject = PlainObject,
> = WaitDefinition<TWaitOutput> | WaitCallback<TInput, TOutput, TWaitOutput>;

/** Ordered durable pause phase for human/external input/check waits. */
export interface WaitPhase<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
> {
  readonly kind: "wait";
  readonly wait: WaitInput<TInput, TOutput> | CheckWaitCallback<TInput, TOutput>;
  readonly options?: WaitOptions;
}

export interface PromptPhase<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
> extends PromptOptions<TOutput> {
  readonly kind: "prompt";
  readonly prompt: AgentPrompt<TInput> | PromptTemplateSource;
}

export type StepContinuationOutput<TOutput extends PlainObject = PlainObject> = TOutput & {
  readonly output: TOutput;
  readonly waits: Readonly<Record<string, PlainObject>>;
};

export type StepContinuation<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
> = {
  bivarianceHack(output: TOutput, input: TInput): ContinuationResult | Promise<ContinuationResult>;
}["bivarianceHack"];

export type StepContextContinuation<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
> = {
  bivarianceHack(
    output: StepContinuationOutput<TOutput>,
    input: TInput,
  ): ContinuationResult | Promise<ContinuationResult>;
}["bivarianceHack"];

export interface DoPhase<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
> {
  readonly kind: "do";
  readonly onOutput: StepContinuation<TInput, TOutput>;
}

export type StepPhase<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
> =
  | DisplayPhase<TInput, TOutput>
  | WaitPhase<TInput, TOutput>
  | PromptPhase<TInput, TOutput>
  | DoPhase<TInput, TOutput>;

/** The runtime shape stored in `StepNode.config` -- `StepConfig` plus the resolved `input`. Legacy prompt fields are retained for compatibility; ordered `StepNode.phases` is the canonical execution model. */
export interface ContinuationStepConfig<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
> {
  readonly id: string;
  readonly title?: string;
  readonly description?: string;
  readonly input: TInput;
  /** @deprecated Prefer the ordered prompt phase in `StepNode.phases`. */
  readonly output?: ShapeInput<TOutput>;
  /** @deprecated Prefer the ordered prompt phase in `StepNode.phases`. */
  readonly prompt?: AgentPrompt<TInput> | PromptTemplateSource;
  /** @deprecated Prefer the ordered prompt phase in `StepNode.phases`. */
  readonly agent?: string;
  /** @deprecated Prefer the ordered prompt phase in `StepNode.phases`. */
  readonly mode?: "working" | "interactive";
  /** @deprecated Prefer the ordered prompt phase in `StepNode.phases`. */
  readonly adapter?: AgentAdapterSelection<TInput, TOutput>;
  /** @deprecated Prefer the ordered prompt phase in `StepNode.phases`. */
  readonly maxSubPrompts?: number;
  readonly cwd?: StepCwdInput<TInput>;
  readonly retry?: RetryPolicyInput;
  readonly timeout?: TimeoutPolicyInput;
}

export type StepErrorContinuation = {
  bivarianceHack(error: Failure): ContinuationResult;
}["bivarianceHack"];

export interface StepNode<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
> {
  readonly kind: "step";
  readonly config: ContinuationStepConfig<TInput, TOutput>;
  /** Ordered phase pipeline. This is the canonical runtime representation for authored nodes. Optional only so legacy StepNode-shaped objects can still be translated at runtime. */
  readonly phases?: readonly StepPhase<TInput, TOutput>[];
  /** @deprecated Prefer the `do` phase in `StepNode.phases`. Retained for compatibility with existing callers. */
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

export interface TerminalMessageOptions {
  readonly message?: string;
}

export interface DoneNode<TOutput extends PlainObject = PlainObject> {
  readonly kind: "done";
  readonly output: TOutput;
  readonly message?: string;
}

/** Terminates the workflow as a failure without dispatching a step -- no step.* events, just workflow.failed. */
export interface FailNode {
  readonly kind: "fail";
  readonly failure: Failure;
  readonly message?: string;
}

export interface WorkflowInvocationOptions<TOutput extends PlainObject = PlainObject> {
  readonly branch?: string;
  readonly onDone?: (output: TOutput) => ContinuationResult | Promise<ContinuationResult>;
}

export interface WorkflowInvocationNode<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
> {
  readonly kind: "workflowInvocation";
  readonly workflow: Workflow<TInput, TOutput>;
  readonly input: TInput;
  readonly options?: WorkflowInvocationOptions<TOutput>;
}

export interface AbsoluteDoneNode<TOutput extends PlainObject = PlainObject> {
  readonly kind: "absoluteDone";
  readonly output: TOutput;
  readonly message?: string;
}

export interface AbsoluteFailNode {
  readonly kind: "absoluteFail";
  readonly failure: Failure;
  readonly message?: string;
}

export interface RunnableWorkflowInvocationNode {
  readonly kind: "workflowInvocation";
  readonly workflow: unknown;
  readonly input: PlainObject;
  readonly options?: unknown;
}

export type RunnableContinuationNode =
  | StepNode<PlainObject, PlainObject>
  | RunnableWorkflowInvocationNode;

export type ContinuationArray = readonly RunnableContinuationNode[];

export type ContinuationResult<TOutput extends PlainObject = PlainObject> =
  | StepNode<PlainObject, PlainObject>
  | DoneNode<TOutput>
  | FailNode
  | RunnableWorkflowInvocationNode
  | AbsoluteDoneNode<TOutput>
  | AbsoluteFailNode
  | ContinuationArray;
