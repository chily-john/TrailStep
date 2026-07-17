import type { WorkflowAgentRole } from "../shared/agent-role.types.js";
import type { PlainObject, Schema, ShapeInput } from "../shared/shape.types.js";
import type { ContinuationResult } from "./continuation.types.js";

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
  readonly start: (input: TInput) => ContinuationResult<TOutput>;
}
