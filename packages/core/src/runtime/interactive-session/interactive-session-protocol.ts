import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import { StepKitFailureError } from "../../contracts/failures/failure.js";
import type { PlainObject, Schema } from "../../contracts/shapes/shape.types.js";

export async function waitForInteractiveCompletion(
  interactiveFile: string,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    if (await isInteractiveCompleted(interactiveFile)) {
      return;
    }

    await delay(100, undefined, { signal }).catch(() => undefined);
  }
}

export async function isInteractiveCompleted(interactiveFile: string): Promise<boolean> {
  try {
    const protocol = await readPlainJsonFile(interactiveFile, {
      readCode: "interactive_session_invalid",
      invalidCode: "interactive_session_invalid",
      message: "Interactive session protocol file is invalid.",
    });
    return protocol.status === "completed" || protocol.status === "cancelled";
  } catch {
    // The process-exit path reports authoritative protocol validation errors.
    // The watcher is intentionally best-effort and only needs to notice completion.
    return false;
  }
}

export async function readCompletedInteractiveOutput(options: {
  readonly stepId: string;
  readonly interactiveFile: string;
  readonly outputSchema: Schema;
}): Promise<PlainObject> {
  const protocol = await readPlainJsonFile(options.interactiveFile, {
    readCode: "interactive_session_invalid",
    invalidCode: "interactive_session_invalid",
    message: `Interactive agent step ${options.stepId} has an invalid interactive.json file.`,
  });

  if (protocol.status === "cancelled") {
    throw new StepKitFailureError({
      code: "interactive_session_cancelled",
      message: `Interactive agent step ${options.stepId} was cancelled.`,
      details: {
        status: protocol.status,
        ...(typeof protocol.reason === "string" ? { reason: protocol.reason } : {}),
      },
    });
  }

  if (protocol.status !== "completed") {
    throw new StepKitFailureError({
      code: "interactive_session_incomplete",
      message: `Interactive agent step ${options.stepId} did not complete the file-based protocol.`,
      details: { status: protocol.status },
    });
  }

  const outputFile = requireProtocolString(protocol.outputFile, "outputFile", options.stepId);
  const output = await readPlainJsonFile(outputFile, {
    readCode: "interactive_output_missing",
    invalidCode: "interactive_output_invalid",
    message: `Interactive agent step ${options.stepId} completed without a valid output.json file.`,
  });

  const diagnostics = options.outputSchema.diagnostics(output);
  if (diagnostics.length > 0) {
    throw new StepKitFailureError({
      code: "interactive_output_invalid",
      message: `Interactive agent step ${options.stepId} output.json failed schema validation: ${formatDiagnostics(diagnostics)}`,
      details: { diagnostics },
    });
  }

  return output;
}

async function readPlainJsonFile(
  path: string,
  failure: {
    readonly readCode: string;
    readonly invalidCode: string;
    readonly message: string;
  },
): Promise<PlainObject> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    throw new StepKitFailureError({
      code: failure.readCode,
      message: failure.message,
      details: { path, cause: error instanceof Error ? error.message : String(error) },
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new StepKitFailureError({
      code: failure.invalidCode,
      message: failure.message,
      details: { path, cause: error instanceof Error ? error.message : String(error) },
    });
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new StepKitFailureError({
      code: failure.invalidCode,
      message: `${failure.message} Expected a plain JSON object.`,
      details: { path },
    });
  }

  return parsed as PlainObject;
}

function requireProtocolString(value: unknown, field: string, stepId: string): string {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  throw new StepKitFailureError({
    code: "interactive_session_invalid",
    message: `Interactive agent step ${stepId} interactive.json is missing ${field}.`,
  });
}

function formatDiagnostics(
  diagnostics: readonly { readonly path: string; readonly message: string }[],
): string {
  return diagnostics.map((diagnostic) => `${diagnostic.path} ${diagnostic.message}`).join("; ");
}
