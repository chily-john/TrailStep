import { isRecord } from "@trailstep/core";

const AGENT_TARGETS_UNAVAILABLE_CODE = "agent_targets_unavailable";

/**
 * True when `error` is an agent-target resolution failure
 * (`agent_targets_unavailable`).
 *
 * The CLI uses this to degrade gracefully when no agent target is configured
 * for a workflow role instead of surfacing the raw failure. Both the `add` and
 * `agents` commands share this single implementation so the two command paths
 * cannot drift apart.
 */
export function isAgentTargetsUnavailableError(error: unknown): boolean {
  return (
    isRecord(error) &&
    isRecord(error.failure) &&
    error.failure.code === AGENT_TARGETS_UNAVAILABLE_CODE
  );
}
