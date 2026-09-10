import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const CANCELLATION_MARKER_FILE = "cancel.json";

export interface CancellationMarker {
  readonly requestedAt?: string;
  readonly reason?: string;
  readonly source?: string;
}

export class WorkflowCancellationError extends Error {
  readonly cancellation: CancellationMarker;

  constructor(cancellation: CancellationMarker = {}) {
    super("Workflow cancellation requested.");
    this.name = "WorkflowCancellationError";
    this.cancellation = cancellation;
  }
}

export function cancellationMarkerPath(runDir: string): string {
  return join(runDir, CANCELLATION_MARKER_FILE);
}

export async function readCancellationMarker(
  runDir: string,
): Promise<CancellationMarker | undefined> {
  let contents: string;
  try {
    contents = await readFile(cancellationMarkerPath(runDir), "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  try {
    return normalizeCancellationMarker(JSON.parse(contents));
  } catch {
    return {};
  }
}

export async function writeCancellationMarker(options: {
  readonly runDir: string;
  readonly reason?: string;
  readonly source?: string;
  readonly requestedAt?: Date;
}): Promise<{ readonly marker: CancellationMarker; readonly alreadyExisted: boolean }> {
  const marker: CancellationMarker = {
    requestedAt: (options.requestedAt ?? new Date()).toISOString(),
    ...(options.reason === undefined ? {} : { reason: options.reason }),
    ...(options.source === undefined ? {} : { source: options.source }),
  };
  const path = cancellationMarkerPath(options.runDir);

  try {
    await mkdir(options.runDir, { recursive: true });
    await writeFile(path, `${JSON.stringify(marker, null, 2)}\n`, { flag: "wx" });
    return { marker, alreadyExisted: false };
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      return { marker: (await readCancellationMarker(options.runDir)) ?? {}, alreadyExisted: true };
    }
    throw error;
  }
}

export function cancellationPayload(cancellation: CancellationMarker): Record<string, unknown> {
  return {
    ...(cancellation.requestedAt === undefined ? {} : { requestedAt: cancellation.requestedAt }),
    ...(cancellation.reason === undefined ? {} : { reason: cancellation.reason }),
    ...(cancellation.source === undefined ? {} : { source: cancellation.source }),
  };
}

export function isWorkflowCancellationError(error: unknown): error is WorkflowCancellationError {
  return error instanceof WorkflowCancellationError;
}

export function throwIfCancellationRequested(cancellation: CancellationMarker | undefined): void {
  if (cancellation !== undefined) {
    throw new WorkflowCancellationError(cancellation);
  }
}

function normalizeCancellationMarker(value: unknown): CancellationMarker {
  if (!isPlainObject(value)) {
    return {};
  }

  return {
    ...(typeof value.requestedAt === "string" ? { requestedAt: value.requestedAt } : {}),
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
    ...(typeof value.source === "string" ? { source: value.source } : {}),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
