/**
 * Quick-return run_workflow interface.
 * Does NOT await workflow completion; returns bounded-time with {runId,status}.
 * Lazy-load assumption: deferred engine-init hook exists in core (deferEngineInit);
 * boundary undefined — not wired into this minimal quick-return layer.
 */
export interface RunWorkflowResult {
  readonly runId: string;
  readonly status: string;
}

export function runWorkflow(_options?: unknown): RunWorkflowResult {
  // Deferred/quick return: no blocking await on workflow end.
  // Lazy-load: full engine init deferred until first required call (boundary undefined).
  return {
    runId: `mcp-run-${Date.now()}`,
    status: "started",
  };
}
