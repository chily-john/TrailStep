import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { isRecord, parseTrailStepConfig, type TrailStepConfig } from "@trailstep/core";

export class CliConfigError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CliConfigError";
  }
}

/** A scope config file that could not be read or parsed. */
export interface ConfigScopeError {
  readonly scope: "global" | "project" | "local";
  readonly path: string;
  readonly message: string;
}

export type WorkflowRegistryConfig = Readonly<Record<string, Readonly<Record<string, string>>>>;

export interface TrailStepProjectConfig {
  readonly trailstepConfig: TrailStepConfig | undefined;
  readonly workflowRegistry: WorkflowRegistryConfig;
  /** Registry declared in `~/.trailstep/config.json` only, never merged with project scopes. */
  readonly globalWorkflowRegistry: WorkflowRegistryConfig;
  /** Config files that could not be read or parsed. Empty when everything loaded. */
  readonly configErrors: readonly ConfigScopeError[];
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
  const reads = await readScopeConfigs(cwd, homeDir);
  const configErrors = collectConfigScopeErrors(reads);

  const user = reads.user.value;
  const project = reads.project.value;
  const projectLocal = reads.local.value;

  if (user === undefined && project === undefined && projectLocal === undefined) {
    return {
      trailstepConfig: undefined,
      workflowRegistry: {},
      globalWorkflowRegistry: {},
      configErrors,
    };
  }

  const mergedRunConfig = mergeConfigScopes([user, project, projectLocal]);
  const mergedProjectRegistryConfig = mergeConfigScopes([project, projectLocal]);

  try {
    return {
      trailstepConfig: parseTrailStepConfig(toCoreTrailStepConfigValue(mergedRunConfig)),
      workflowRegistry: parseWorkflowRegistry(mergedProjectRegistryConfig),
      globalWorkflowRegistry: parseWorkflowRegistry(user),
      configErrors,
    };
  } catch (error) {
    const detail = formatConfigValidationDetail(error);
    throw new CliConfigError(`Invalid .trailstep/config.json.${detail}`, { cause: error });
  }
}

/**
 * Deep-merges TrailStep config scopes, lowest precedence first.
 *
 * Every scope config is a partial view of one effective config, so a lower scope's key must
 * never erase an unrelated key declared higher up. The previous implementation reversed that
 * for every key except `agents`: a project-level `settings.timeout` deleted a global
 * `settings.retry`, and a local `workflows.<id>.agents.<role>` deleted every other role for that
 * workflow in every other scope.
 *
 * Merge rules:
 * - plain objects merge recursively;
 * - arrays are replaced wholesale (an agent target list is a unit, never spliced);
 * - `undefined` never overrides a defined value;
 * - anything else replaces.
 *
 * `null` is a value, not an absence, and replaces. Use it to deliberately clear a lower key.
 */
export function mergeConfigScopes(
  scopes: readonly (unknown | undefined)[],
): Record<string, unknown> {
  let merged: Record<string, unknown> = {};
  for (const scope of scopes) {
    if (!isRecord(scope)) {
      continue;
    }
    merged = mergeRecords(merged, scope);
  }
  return merged;
}

function mergeRecords(
  base: Record<string, unknown>,
  override: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, overrideValue] of Object.entries(override)) {
    if (overrideValue === undefined) {
      continue;
    }
    const baseValue = result[key];
    result[key] =
      isRecord(baseValue) && isRecord(overrideValue)
        ? mergeRecords(baseValue, overrideValue)
        : overrideValue;
  }
  return result;
}

/**
 * Formats one unreadable scope as the stderr line commands print for it.
 */
export function formatConfigScopeError(error: ConfigScopeError): string {
  return `trailstep: ignoring ${error.scope} config at ${error.path}: ${error.message}`;
}

/**
 * Surfaces unreadable scope configs once per command invocation.
 *
 * A malformed config file is no longer fatal: the remaining scopes still apply. Reporting it
 * keeps the failure discoverable, because the missing keys show up much later as an unclear
 * workflow failure.
 */
export function writeConfigScopeErrors(
  io: { writeError: (line: string) => void },
  errors: readonly ConfigScopeError[],
): void {
  for (const error of errors) {
    io.writeError(formatConfigScopeError(error));
  }
}

/**
 * @deprecated Use `loadTrailStepProjectConfig().globalWorkflowRegistry` instead.
 */
export async function loadTrailStepUserWorkflowRegistry(
  homeDir = homedir(),
): Promise<WorkflowRegistryConfig> {
  const user = await readScopeConfig(join(homeDir, ".trailstep", "config.json"));
  return user.value === undefined ? {} : parseWorkflowRegistry(user.value);
}

interface ScopeRead {
  readonly value: unknown | undefined;
  readonly error?: { readonly path: string; readonly message: string };
}

interface ScopeReads {
  readonly user: ScopeRead;
  readonly project: ScopeRead;
  readonly local: ScopeRead;
}

/**
 * Reads every scope independently, recording failures instead of throwing.
 *
 * `Promise.all` over throwing reads meant one typo in `~/.trailstep/config.json` broke every
 * trailstep command in every project, with no escape hatch.
 */
async function readScopeConfigs(cwd: string, homeDir: string): Promise<ScopeReads> {
  const [user, project, local] = await Promise.all([
    readScopeConfig(join(homeDir, ".trailstep", "config.json")),
    readScopeConfig(join(cwd, ".trailstep", "config.json")),
    readScopeConfig(join(cwd, ".trailstep", "config-local.json")),
  ]);

  return { user, project, local };
}

function collectConfigScopeErrors(reads: ScopeReads): readonly ConfigScopeError[] {
  const errors: ConfigScopeError[] = [];
  const append = (scope: ConfigScopeError["scope"], read: ScopeRead): void => {
    if (read.error !== undefined) {
      errors.push({ scope, path: read.error.path, message: read.error.message });
    }
  };

  append("global", reads.user);
  append("project", reads.project);
  append("local", reads.local);

  return errors;
}

async function readScopeConfig(configPath: string): Promise<ScopeRead> {
  let fileContents: string;

  try {
    fileContents = await readFile(configPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { value: undefined };
    }

    return { value: undefined, error: { path: configPath, message: formatReadFailure(error) } };
  }

  try {
    return { value: JSON.parse(fileContents) as unknown };
  } catch (error) {
    const message =
      error instanceof Error ? `expected valid JSON (${error.message})` : "expected valid JSON";
    return { value: undefined, error: { path: configPath, message } };
  }
}

function formatReadFailure(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return `unable to read file (${error.message})`;
  }

  return "unable to read file";
}

/**
 * Parses a registry out of one scope config.
 *
 * `workflowRegistry` is the canonical key. For one release we also read the legacy
 * `workflows` string leaves that `trailstep add` still writes (story 10 moves the writer onto
 * `workflowRegistry`); that fallback is what keeps `add`/`agents` and the resolver agreeing
 * while both keys exist.
 */
function parseWorkflowRegistry(value: unknown): WorkflowRegistryConfig {
  if (!isRecord(value)) {
    return {};
  }

  if (isRecord(value.workflowRegistry)) {
    return parseRegistryBuckets(value.workflowRegistry);
  }

  return isRecord(value.workflows) ? parseRegistryBuckets(value.workflows) : {};
}

function parseRegistryBuckets(value: Readonly<Record<string, unknown>>): WorkflowRegistryConfig {
  const registry: Record<string, Record<string, string>> = {};

  for (const [namespace, entries] of Object.entries(value)) {
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

  const coreConfig = { ...value };
  delete coreConfig.workflowRegistry;

  return {
    ...coreConfig,
    version: value.version ?? 1,
    customProviders: value.customProviders ?? {},
    agents: value.agents ?? {},
  };
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
