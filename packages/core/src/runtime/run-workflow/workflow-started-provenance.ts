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
 *
 * The recorded strings are the exact validated cwd strings: they are never
 * trimmed, normalized, resolved, or otherwise reinterpreted here. Trailing or
 * leading whitespace is legal in directory names, so the recorded value must
 * match the directory the runtime actually validated and uses. The only
 * question asked of the inputs mirrors the runtime's own presence test in
 * `validateDirectoryCwd` (blank-after-trim means absent), but the values
 * recorded are the original strings unchanged.
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
  if (cwds.projectCwd.trim().length === 0) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    projectCwd: cwds.projectCwd,
    executionCwd: cwds.cwd.trim().length > 0 ? cwds.cwd : cwds.projectCwd,
  };
}
