import type { WorkflowAgentRole } from "../../contracts/agents/agent-role.types.js";
import type { PlainObject, Schema, ShapeInput } from "../../contracts/shapes/shape.types.js";
import type { RetryPolicyInput } from "../../runtime/retry/retry-policy.js";
import type { TimeoutPolicyInput } from "../../runtime/timeout/timeout-policy.js";
import type {
  ContinuationResult,
  PostContinuation,
  WorkflowInvocationOptions,
} from "../step/continuation.types.js";

export interface WorkflowSkillOptions {
  readonly description?: string;
  readonly instructions?: string;
  readonly markdown?: string;
}

export interface Workflow<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
> {
  readonly id: string;
  readonly description?: string;
  readonly skill?: string | WorkflowSkillOptions;
  readonly input?: Schema<TInput>;
  readonly output?: Schema<TOutput>;
  readonly inputShape?: ShapeInput<TInput>;
  readonly outputShape?: ShapeInput<TOutput>;
  readonly agents?: Readonly<Record<string, WorkflowAgentRole>>;
  /**
   * Workflow-level automatic retry policy applied to this workflow's steps
   * when a step does not configure its own `retry`. Resolution order across
   * the runtime is step > workflow > global (`settings.retry`) with a built-in
   * default of `maxAttempts: 2`.
   *
   * `retryOn` selects WHICH failures may be retried: `"transient"` (default)
   * retries only transient failures; `"always"` retries every failure.
   */
  readonly retry?: RetryPolicyInput;
  readonly timeout?: TimeoutPolicyInput;
  readonly start: (input: TInput) => ContinuationResult<TOutput>;
}

export type WorkflowBuilderOptions<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
> = Workflow<TInput, TOutput>;

export type DefinedWorkflow<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
> = Workflow<TInput, TOutput> &
  ((input: TInput, options?: WorkflowInvocationOptions) => WorkflowInvocationNode<TInput, TOutput>);

/**
 * A node that invokes another workflow.
 *
 * Declared here (rather than in `authoring/step/continuation.types.ts`)
 * because it is mutually recursive with `Workflow`: the workflow's `start`
 * returns a continuation result, and a continuation result can invoke a
 * workflow. Keeping both declarations in one module keeps the authoring
 * import graph acyclic.
 */
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
