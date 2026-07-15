import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parseStepKitConfig, type StepKitConfig } from "@stepkit/core";

export class CliConfigError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CliConfigError";
  }
}

/**
 * Loads optional project configuration for workflow runs.
 *
 * A missing `.stepkit/config.json` is allowed so code-only workflows and commands that do not
 * need agent configuration can still run; core reports a workflow failure if a later agent step
 * requires configuration that was not provided.
 */
export async function loadStepKitConfig(cwd = process.cwd()): Promise<StepKitConfig | undefined> {
  const configPath = join(cwd, ".stepkit", "config.json");
  let fileContents: string;

  try {
    fileContents = await readFile(configPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }

    throw new CliConfigError("Unable to read .stepkit/config.json.", { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fileContents) as unknown;
  } catch (error) {
    throw new CliConfigError("Invalid .stepkit/config.json: expected valid JSON.", {
      cause: error,
    });
  }

  try {
    return parseStepKitConfig(parsed);
  } catch (error) {
    const detail = formatConfigValidationDetail(error);
    throw new CliConfigError(`Invalid .stepkit/config.json.${detail}`, { cause: error });
  }
}

function formatConfigValidationDetail(error: unknown): string {
  const diagnostics = extractDiagnostics(error);
  if (diagnostics.length > 0) {
    return ` ${diagnostics.join(" ")}`;
  }

  if (error instanceof Error && error.message !== "Invalid .stepkit/config.json.") {
    return ` ${error.message}`;
  }

  return "";
}

function extractDiagnostics(error: unknown): string[] {
  if (!isRecord(error) || !isRecord(error.failure) || !isRecord(error.failure.details)) {
    return [];
  }

  const { diagnostics } = error.failure.details;
  return Array.isArray(diagnostics) &&
    diagnostics.every((diagnostic) => typeof diagnostic === "string")
    ? diagnostics
    : [];
}

function isNodeError(error: unknown): error is { readonly code: string } {
  return isRecord(error) && "code" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
