import type { TrailStepAgentTarget } from "../../../agent-targeting/targeting.types.js";
import { TrailStepFailureError } from "../../../contracts/failures/failure.js";

export interface WorkingAgentAttemptFailure {
  readonly target: string;
  readonly model?: string;
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}

export function summarizeWorkingAgentAttemptFailure(
  target: TrailStepAgentTarget,
  error: unknown,
): WorkingAgentAttemptFailure {
  if (error instanceof TrailStepFailureError) {
    return {
      target: target.provider,
      ...(target.model === undefined ? {} : { model: target.model }),
      code: error.failure.code,
      message: error.failure.message,
      ...(error.failure.details === undefined ? {} : { details: error.failure.details }),
    };
  }

  return {
    target: target.provider,
    ...(target.model === undefined ? {} : { model: target.model }),
    code: "agent_target_failed",
    message: error instanceof Error ? error.message : "Working agent target failed.",
  };
}
