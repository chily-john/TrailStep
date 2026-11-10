/**
 * Run-start provenance recorded on the original `workflow.started` event.
 *
 * Captures only what the runtime already resolved cheaply and reliably before
 * emitting the start event: the project root, the default execution cwd, and a
 * provenance schema version. Deliberately absent (see A2a slice notes):
 * - git/source revision: no shell metadata pipeline; the runtime has no workflow
 *   revision field to read it from.
 * - explicit project key/identity: no config field exists, and inferring
 *   equivalence from remote, global config, or basename is forbidden.
 * - config digest: the config may carry secret-bearing values.
 * - runs root: derivable from the run directory.
 *
 * This helper is pure and infallible: metadata capture must never fail a
 * productive run. It returns `undefined` when there is nothing meaningful to
 * record, so the emit site can omit the field entirely (legacy shape).
 */
export interface WorkflowStartedProvenance {
  readonly schemaVersion: 1;
  /** Project root used for workflow/config-relative resolution and artifacts. */
  readonly projectCwd: string;
  /** Default execution cwd for steps and agent processes. */
  readonly executionCwd: string;
}

export function createWorkflowStartedProvenance(cwds: {
  readonly projectCwd: string;
  readonly cwd: string;
}): WorkflowStartedProvenance | undefined {
  const projectCwd = cwds.projectCwd.trim();
  const executionCwd = cwds.cwd.trim();
  if (projectCwd.length === 0) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    projectCwd,
    executionCwd: executionCwd.length > 0 ? executionCwd : projectCwd,
  };
}
