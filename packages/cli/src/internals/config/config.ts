import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { parseTrailStepConfig, type TrailStepConfig } from "@trailstep/core";

export class CliConfigError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CliConfigError";
  }
}

export interface TrailStepProjectConfig {
  readonly trailstepConfig: TrailStepConfig | undefined;
  readonly workflowRegistry: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/**
 * Loads optional project configuration for workflow runs.
 *
 * A missing `.trailstep/config.json` is allowed so code-only workflows and commands that do not
 * need agent configuration can still run; core reports a workflow failure if a later agent step
 * requires configuration that was not provided.
 */
export async function loadTrailStepConfig(
  cwd = process.cwd(),
  options: LoadTrailStepProjectConfigOptions = {},
): Promise<TrailStepConfig | undefined> {
  return (await loadTrailStepProjectConfig(cwd, options)).trailstepConfig;
}

export interface LoadTrailStepProjectConfigOptions {
  readonly homeDir?: string;
}

export async function loadTrailStepProjectConfig(
  cwd = process.cwd(),
  options: LoadTrailStepProjectConfigOptions = {},
): Promise<TrailStepProjectConfig> {
  const homeDir = options.homeDir ?? homedir();
  const [user, project, projectLocal] = await Promise.all([
    readRawScopeConfig(join(homeDir, ".trailstep", "config.json"), {
      description: "~/.trailstep/config.json",
    }),
    readRawScopeConfig(join(cwd, ".trailstep", "config.json"), {
      description: ".trailstep/config.json",
    }),
    readRawScopeConfig(join(cwd, ".trailstep", "config-local.json"), {
      description: ".trailstep/config-local.json",
    }),
  ]);

  if (user === undefined && project === undefined && projectLocal === undefined) {
    return { trailstepConfig: undefined, workflowRegistry: {} };
  }

  const mergedRunConfig = mergeEffectiveRunConfig(user, project, projectLocal);
  const mergedProjectRegistryConfig = mergeRawTrailStepConfig(project, projectLocal);

  try {
    return {
      trailstepConfig: parseTrailStepConfig(toCoreTrailStepConfigValue(mergedRunConfig)),
      workflowRegistry: parseWorkflowRegistry(mergedProjectRegistryConfig),
    };
  } catch (error) {
    const detail = formatConfigValidationDetail(error);
    throw new CliConfigError(`Invalid .trailstep/config.json.${detail}`, { cause: error });
  }
}

/**
 * Merges `.trailstep/config-local.json` over `.trailstep/config.json`.
 *
 * The merge is shallow at the top level: a key present in the local override (e.g.
 * `customProviders`) replaces the shared value for that key wholesale rather than being
 * deep-merged, keeping precedence easy to reason about.
 *
 * `workflows` is the one exception: it merges one level deeper, per namespace bucket,
 * because `project` and `local` scope registrations are meant to coexist. A
 * shallow replace here would make every project-scope registration disappear the moment
 * a local registration exists, since both configs share the same `workflows` key.
 */
function mergeRawTrailStepConfig(base: unknown, local: unknown): unknown {
  if (!isRecord(base)) {
    return local ?? base;
  }
  if (!isRecord(local)) {
    return base;
  }

  return { ...base, ...local, workflows: mergeWorkflowsRecord(base.workflows, local.workflows) };
}

function mergeEffectiveRunConfig(...configs: readonly unknown[]): unknown {
  return configs.reduce<unknown>(
    (merged, next) => mergeEffectiveRunConfigPair(merged, next),
    undefined,
  );
}

function mergeEffectiveRunConfigPair(base: unknown, override: unknown): unknown {
  if (!isRecord(base)) {
    return override ?? base;
  }
  if (!isRecord(override)) {
    return base;
  }

  return {
    ...base,
    ...override,
    agents: mergeAgentsRecord(base.agents, override.agents),
  };
}

function mergeAgentsRecord(base: unknown, override: unknown): unknown {
  if (override === undefined) {
    return base;
  }
  if (!isRecord(base)) {
    return override;
  }
  if (!isRecord(override)) {
    return override;
  }

  return { ...base, ...override };
}

function mergeWorkflowsRecord(base: unknown, local: unknown): unknown {
  if (!isRecord(base)) {
    return local;
  }
  if (!isRecord(local)) {
    return base;
  }

  const namespaces = new Set([...Object.keys(base), ...Object.keys(local)]);
  const merged: Record<string, unknown> = {};

  for (const namespace of namespaces) {
    const baseBucket = base[namespace];
    const localBucket = local[namespace];

    merged[namespace] =
      isRecord(baseBucket) && isRecord(localBucket)
        ? { ...baseBucket, ...localBucket }
        : (localBucket ?? baseBucket);
  }

  return merged;
}

export async function loadTrailStepUserWorkflowRegistry(
  homeDir = homedir(),
): Promise<Readonly<Record<string, Readonly<Record<string, string>>>>> {
  const parsed = await readRawScopeConfig(join(homeDir, ".trailstep", "config.json"), {
    description: "~/.trailstep/config.json",
  });

  return parsed === undefined ? {} : parseWorkflowRegistry(parsed);
}

async function readRawScopeConfig(
  configPath: string,
  options: { readonly description: string },
): Promise<unknown | undefined> {
  let fileContents: string;

  try {
    fileContents = await readFile(configPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }

    throw new CliConfigError(`Unable to read ${options.description}.`, { cause: error });
  }

  try {
    return JSON.parse(fileContents) as unknown;
  } catch (error) {
    throw new CliConfigError(`Invalid ${options.description}: expected valid JSON.`, {
      cause: error,
    });
  }
}

function parseWorkflowRegistry(
  value: unknown,
): Readonly<Record<string, Readonly<Record<string, string>>>> {
  if (!isRecord(value) || !isRecord(value.workflows)) {
    return {};
  }

  const registry: Record<string, Record<string, string>> = {};

  for (const [namespace, entries] of Object.entries(value.workflows)) {
    if (!isRecord(entries)) {
      continue;
    }

    const registeredWorkflows = Object.fromEntries(
      Object.entries(entries).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );

    if (Object.keys(registeredWorkflows).length > 0) {
      registry[namespace] = registeredWorkflows;
    }
  }

  return registry;
}

function toCoreTrailStepConfigValue(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }

  return {
    ...value,
    version: value.version ?? 1,
    customProviders: value.customProviders ?? {},
    agents: value.agents ?? {},
    ...(value.workflows === undefined ? {} : { workflows: stripWorkflowRegistry(value.workflows) }),
  };
}

function stripWorkflowRegistry(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([workflowId, workflowConfig]) => {
      if (!isRecord(workflowConfig)) {
        return [workflowId, workflowConfig];
      }

      return [
        workflowId,
        Object.fromEntries(
          Object.entries(workflowConfig).filter((entry) => typeof entry[1] !== "string"),
        ),
      ];
    }),
  );
}

function formatConfigValidationDetail(error: unknown): string {
  const diagnostics = extractDiagnostics(error);
  if (diagnostics.length > 0) {
    return ` ${diagnostics.join(" ")}`;
  }

  if (error instanceof Error && error.message !== "Invalid .trailstep/config.json.") {
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
