import type { PlainObject } from "../shapes/shape.types.js";

/**
 * Durable run event emitted by the runtime and persisted to the run's event
 * trail.
 *
 * Lives under `contracts/` so that run-artifact storage and the run-workflow
 * runtime can both depend on it without importing each other. This module is
 * a leaf: it declares types only and imports nothing but the shape contract.
 */
export interface Event<TPayload extends PlainObject = PlainObject> {
  readonly id: string;
  readonly runId: string;
  readonly workflowId: string;
  readonly stepId?: string;
  readonly type:
    | "workflow.started"
    | "workflow.resumed"
    | "workflow.retryStarted"
    | "workflow.cancelRequested"
    | "workflow.failed"
    | "workflow.cancelled"
    | "step.started"
    | "step.completed"
    /** A step attempt failed but another automatic attempt will follow; payload carries the failed `attempt`, the `failure`, and the resolved `maxAttempts` so attempt trails reconstruct durably from the event log. */
    | "step.attemptFailed"
    | "step.failed"
    | "step.cancelled"
    | "step.display"
    | "step.progress"
    | "step.warning"
    | "step.artifact"
    | "wait.started"
    | "wait.satisfied"
    | "wait.failed"
    | "subPrompt.started"
    | "subPrompt.completed"
    | "subPrompt.failed"
    | "interactive.sessionStarted"
    | "interactive.sessionCompleted"
    | "agent.toolCall"
    | "agent.spawned"
    | "agent.promptSent"
    | "agent.outputRequested"
    | "agent.outputReceived"
    | "agent.sessionResumed"
    | "agent.targetSelected"
    | "agent.attemptFailed"
    | "workflow.completed";
  readonly timestamp: string;
  readonly schemaVersion: "v0";
  readonly payload: TPayload;
}
