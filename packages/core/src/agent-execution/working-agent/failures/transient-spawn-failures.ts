import { TrailStepFailureError } from "../../../contracts/failures/failure.js";

/**
 * Working-agent spawn failures that are safe (and worthwhile) to retry with
 * backoff instead of burning the remaining agent targets:
 *
 * - Process-level deaths: the child exited with an NTSTATUS code (the Windows
 *   `0xC0000000+` family, e.g. `0xC0000142` `STATUS_DLL_INIT_FAILED` /
 *   `3221225794`), meaning the process died abnormally and produced no valid
 *   output.
 * - Resource-exhausted spawn errors: the child could not be created at all
 *   (`EAGAIN`, `EMFILE`, `ENFILE`, `ENOMEM`), which is transient by nature.
 *
 * Everything else (the agent ran and failed, timeouts, provider misconfig) is
 * a real failure and must surface immediately.
 */

const NTSTATUS_RANGE_START = 0xc000_0000;
const NTSTATUS_RANGE_END = 0xffff_ffff;
const RESOURCE_SPAWN_ERROR_PATTERN = /\b(EAGAIN|EMFILE|ENFILE|ENOMEM)\b/;

export function isTransientSpawnExitCode(exitCode: number): boolean {
  return (
    Number.isInteger(exitCode) && exitCode >= NTSTATUS_RANGE_START && exitCode <= NTSTATUS_RANGE_END
  );
}

export function isTransientSpawnErrorCode(errorCode: unknown): boolean {
  return typeof errorCode === "string" && RESOURCE_SPAWN_ERROR_PATTERN.test(errorCode);
}

/** Whether a thrown working-agent failure is a transient spawn failure. */
export function isTransientWorkingAgentFailure(error: unknown): boolean {
  if (!(error instanceof TrailStepFailureError)) {
    return false;
  }

  const failure = error.failure;
  if (failure.code === "agent_provider_failed") {
    return isTransientSpawnExitCode(exitCodeFromDetails(failure.details));
  }
  if (failure.code === "agent_provider_spawn_error") {
    return isTransientSpawnErrorCode(spawnErrorCodeFromDetails(failure.details));
  }
  return false;
}

export function exitCodeFromDetails(details: unknown): number {
  return readNumberField(details, "exitCode") ?? -1;
}

export function stderrTailFromDetails(details: unknown): string | undefined {
  return readStringField(details, "stderrTail");
}

function spawnErrorCodeFromDetails(details: unknown): unknown {
  return readStringField(details, "spawnErrorCode");
}

function readRecord(details: unknown): Record<string, unknown> | undefined {
  return typeof details === "object" && details !== null
    ? (details as Record<string, unknown>)
    : undefined;
}

function readNumberField(details: unknown, field: string): number | undefined {
  const value = readRecord(details)?.[field];
  return typeof value === "number" ? value : undefined;
}

function readStringField(details: unknown, field: string): string | undefined {
  const value = readRecord(details)?.[field];
  return typeof value === "string" ? value : undefined;
}
