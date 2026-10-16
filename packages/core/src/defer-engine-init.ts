/**
 * Deferred engine-init hook.
 * Defers workflow-runtime setup until first run_workflow call or first resource request.
 * Boundary undefined — only deferred trigger, not init contract restructuring.
 */
export function deferEngineInit(): void {
  // Lazy-load trigger: no full engine initialization occurs at subcommand startup.
  // Actual initialization deferred until first required call.
}
