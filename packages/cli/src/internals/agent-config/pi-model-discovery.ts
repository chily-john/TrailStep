import { resolveCliCommandForSpawn } from "@trailstep/core";

import type {
  PackageCommandResult,
  PackageCommandRunner,
} from "../command-framework/command.types.js";
import { defaultPackageCommandRunner } from "../package-manager/package-manager.js";

/**
 * Pi model discovery runs the `pi` CLI and parses its model table.
 *
 * This lives in the CLI on purpose: `@trailstep/provider-pi` is a
 * dependency-free manifest package that only describes *how* the pi CLI is
 * invoked (the `pi --list-models` discovery spec now lives in its manifest),
 * while the discovery *implementation* needs the CLI's package-command runner
 * seam and the core spawn resolver. Moving it into the provider package would
 * require the CLI to depend on a provider package (the CLI deliberately
 * depends on none, so official providers stay optional) or would give the
 * provider packages a runtime dependency on the CLI/core for a helper that
 * only the CLI's interactive wizard calls.
 */
const DEFAULT_PI_MODEL_DISCOVERY_TIMEOUT_MS = 5_000;
const PI_MODEL_LIST_COMMAND = "pi";
const PI_MODEL_LIST_ARGS = ["--list-models"] as const;

export interface DiscoverPiModelOverridesOptions {
  readonly cwd: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly packageCommandRunner?: PackageCommandRunner;
  readonly timeoutMs?: number;
}

export async function discoverPiModelOverrides({
  cwd,
  command = PI_MODEL_LIST_COMMAND,
  args = PI_MODEL_LIST_ARGS,
  packageCommandRunner = defaultPackageCommandRunner,
  timeoutMs = DEFAULT_PI_MODEL_DISCOVERY_TIMEOUT_MS,
}: DiscoverPiModelOverridesOptions): Promise<readonly string[]> {
  let result: PackageCommandResult;
  try {
    // `pi` is an npm .cmd shim on Windows and cannot be spawned by bare name
    // with shell:false; resolve to the Node entrypoint (no-op elsewhere).
    const executable = await resolveCliCommandForSpawn({ command, args });
    result = await withTimeout(
      packageCommandRunner({ command: executable.command, args: executable.args, cwd }),
      timeoutMs,
      `Timed out after ${timeoutMs}ms.`,
    );
  } catch (error) {
    throw new Error(
      `Pi model discovery failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (result.exitCode !== 0) {
    throw new Error(`Pi model discovery exited with code ${result.exitCode}.`);
  }

  const models = parsePiModelDiscoveryOutput(result.stdout ?? "");
  if (models.length === 0) {
    throw new Error("Pi model discovery returned no models.");
  }
  return models;
}

export function parsePiModelDiscoveryOutput(output: string): readonly string[] {
  const rows: string[] = [];
  let providerColumn: number | undefined;
  let modelColumn: number | undefined;

  for (const line of output.split(/\r?\n/u)) {
    const cells = parseTableCells(line);
    if (cells.length === 0) {
      continue;
    }

    if (providerColumn === undefined || modelColumn === undefined) {
      const normalizedCells = cells.map((cell) => cell.toLowerCase());
      const nextProviderColumn = normalizedCells.indexOf("provider");
      const nextModelColumn = normalizedCells.indexOf("model");
      if (nextProviderColumn !== -1 && nextModelColumn !== -1) {
        providerColumn = nextProviderColumn;
        modelColumn = nextModelColumn;
      }
      continue;
    }

    const provider = cells[providerColumn]?.trim() ?? "";
    const model = cells[modelColumn]?.trim() ?? "";
    if (!isTableValue(provider) || !isTableValue(model)) {
      continue;
    }
    rows.push(`${provider}/${model}`);
  }

  return [...new Set(rows)];
}

function parseTableCells(line: string): readonly string[] {
  const trimmed = line.trim();
  if (trimmed.length === 0 || isTableBorder(trimmed)) {
    return [];
  }

  if (trimmed.includes("│") || trimmed.includes("|")) {
    return trimmed
      .split(/[│|]/u)
      .map((cell) => cell.trim())
      .filter((cell) => cell.length > 0 && !isTableBorder(cell));
  }

  return trimmed.split(/\s+/u).map((cell) => cell.trim());
}

function isTableBorder(value: string): boolean {
  return /^[\s┌┬┐├┼┤└┴┘─+\-|:]+$/u.test(value);
}

function isTableValue(value: string): boolean {
  return value.length > 0 && !isTableBorder(value);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}
