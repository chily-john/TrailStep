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
  /**
   * Automatic retry policy for this step's attempts. Resolution order is
   * step > workflow > global (`settings.retry`) with a built-in default of
   * `maxAttempts: 2`. When an attempt fails and another attempt is allowed,
   * the runtime emits `step.attemptFailed` and re-runs the step; the final
   * failed attempt emits `step.failed` exactly once. Attempt counts are
   * derived from the persisted event trail, so retries survive crash/resume.
   *
   * `retryOn` selects WHICH failures may be retried: `"transient"` (default)
   * retries only transient failures (timeouts, provider unavailability /
   * failure / spawn errors); every other failure is permanent and fails on
   * the first attempt. `"always"` opts into retrying every failure.
   */
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

/**
 * Options for the `do(...)` phase builder.
 */
export interface DoOptions {
  /**
   * Idempotency contract for the do phase. Defaults to `true`.
   *
   * A do phase is assumed idempotent by default: replaying it on resume or
   * retry re-executes its continuation safely. When a do phase is explicitly
   * marked non-idempotent (`{ idempotent: false }`), the runtime will not
   * silently re-execute it: automatic step retry skips such steps, and
   * resume/retry replay refuses with an actionable error when the event trail
   * does not record enough to skip the phase safely.
   */
  readonly idempotent?: boolean;
}

export interface DoPhase<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
> {
  readonly kind: "do";
  readonly onOutput: StepContinuation<TInput, TOutput>;
  /**
   * Idempotency contract for this phase; `undefined` means `true` (the
   * default). A do phase is assumed idempotent by default, so replaying it on
   * resume/retry re-executes its continuation safely. When explicitly
   * `false`, the runtime must not silently re-execute the phase on
   * resume/retry: it refuses instead when the trail cannot prove skipping is
   * safe, and automatic step retry will not re-run the step's attempts.
   */
  readonly idempotent?: boolean;
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
  readonly options?: StepInvocationOptions;
}

/**
 * Returned by `step(...).prompt(...)?.do(...)`: a reusable step definition,
 * called with a live input value to produce an actual `StepNode`
 * (`stepA(input)`). Chain `.catch(...)` to add an error continuation before
 * calling it. When `TInput` has no required keys (e.g. a step that ignores
 * its input), the call is `stepA()` -- the input argument is optional.
 */
export interface StepInvocationOptions extends Partial<Omit<StepConfig, "id">> {
  readonly branchId?: string;
}

export type StepFactory<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
  // biome-ignore lint/complexity/noBannedTypes: `{}` here is the standard conditional-type idiom for "TInput has no required keys", not a stand-in for "any value".
> = ({} extends TInput
  ? (input?: TInput, options?: StepInvocationOptions) => StepNode<TInput, TOutput>
  : (input: TInput, options?: StepInvocationOptions) => StepNode<TInput, TOutput>) & {
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

export interface WorkflowInvocationOptions {
  readonly branchId?: string;
}

export type PostContinuation<TOutput extends PlainObject = PlainObject> = {
  bivarianceHack(output: TOutput): ContinuationResult | Promise<ContinuationResult>;
}["bivarianceHack"];

export interface WorkflowInvocationNode<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
> {
  readonly kind: "workflowInvocation";
  readonly workflow: Workflow<TInput, TOutput>;
  readonly input: TInput;
  readonly options?: WorkflowInvocationOptions;
  post(continuation: PostContinuation<TOutput>): WorkflowInvocationNode<TInput, TOutput>;
  readonly postContinuation?: PostContinuation<TOutput>;
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
  readonly postContinuation?: PostContinuation;
}

export type RunnableContinuationNode =
  | StepNode<PlainObject, PlainObject>
  | RunnableWorkflowInvocationNode;

export type ContinuationArray = readonly RunnableContinuationNode[];

export type ParallelFailurePolicy = "fail-fast" | "all-settled";

export interface ParallelOptions {
  readonly concurrency?: number;
  readonly failurePolicy?: ParallelFailurePolicy;
}

export interface ParallelNode<TOutput extends PlainObject = PlainObject> {
  readonly kind: "parallel";
  readonly nodes: ContinuationArray;
  readonly options?: ParallelOptions;
  post(continuation: PostContinuation<TOutput>): ParallelNode<TOutput>;
  readonly postContinuation?: PostContinuation<TOutput>;
}

export type ContinuationResult<TOutput extends PlainObject = PlainObject> =
  | StepNode<PlainObject, PlainObject>
  | DoneNode<TOutput>
  | FailNode
  | RunnableWorkflowInvocationNode
  | AbsoluteDoneNode<TOutput>
  | AbsoluteFailNode
  | ContinuationArray
  | ParallelNode<TOutput>;
