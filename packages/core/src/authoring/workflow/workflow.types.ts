import type { WorkflowAgentRole } from "../../contracts/agents/agent-role.types.js";
import type { PlainObject, Schema, ShapeInput } from "../../contracts/shapes/shape.types.js";
import type { RetryPolicyInput } from "../../runtime/retry/retry-policy.js";
import type { TimeoutPolicyInput } from "../../runtime/timeout/timeout-policy.js";
import type { ContinuationResult } from "../step/continuation.types.js";

export interface Workflow<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
> {
  readonly id: string;
  readonly input?: Schema<TInput>;
  readonly output?: Schema<TOutput>;
  readonly inputShape?: ShapeInput<TInput>;
  readonly outputShape?: ShapeInput<TOutput>;
  readonly agents?: Readonly<Record<string, WorkflowAgentRole>>;
  readonly retry?: RetryPolicyInput;
  readonly timeout?: TimeoutPolicyInput;
  readonly start: (input: TInput) => ContinuationResult<TOutput>;
}
