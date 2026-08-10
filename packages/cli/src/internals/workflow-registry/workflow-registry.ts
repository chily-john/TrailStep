import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { CliUsageError } from "../command.types.js";
import { isDirectWorkflowFileReference } from "../workflow-resolution/workflow-resolution.js";

export type WorkflowRegistryScope = "local" | "project" | "global";

export interface WorkflowRegistryContext {
  readonly cwd: string;
  readonly homeDir?: string;
}

export function configPathForScope(
  scope: WorkflowRegistryScope,
  context: WorkflowRegistryContext,
): string {
  if (scope === "local") {
    return join(context.cwd, ".trailstep", "config-local.json");
  }
  const baseDir = scope === "project" ? context.cwd : (context.homeDir ?? homedir());
  return join(baseDir, ".trailstep", "config.json");
}

export async function readRawTrailStepConfigFile(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isRecord(parsed)) {
      throw new CliUsageError(`Invalid StepKit config at ${path}: expected a JSON object.`);
    }
    return parsed;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export async function writeRawTrailStepConfigFile(
  path: string,
  value: Record<string, unknown>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * Copies each namespace bucket verbatim, preserving any non-string sibling keys
 * (per-workflow agent config) that may live alongside registry entries under the same
 * namespace key. Do not replace this with config.ts's parseWorkflowRegistry — that
 * function filters to string-valued leaves only and would silently drop agent config
 * on the next write.
 */
export function toMutableWorkflowRegistry(value: unknown): Record<string, Record<string, unknown>> {
  if (!isRecord(value)) {
    return {};
  }

  const registry: Record<string, Record<string, unknown>> = {};
  for (const [namespace, entries] of Object.entries(value)) {
    if (isRecord(entries)) {
      registry[namespace] = { ...entries };
    }
  }
  return registry;
}

/**
 * Deletes workflows[namespace][name]. Removes the whole namespace bucket only if it has
 * zero remaining keys of any kind after the delete — never touches sibling keys or other
 * namespaces.
 */
export function deleteWorkflowRegistryEntry(
  workflows: Record<string, Record<string, unknown>>,
  namespace: string,
  name: string,
): Record<string, Record<string, unknown>> {
  const bucket = workflows[namespace];
  if (bucket === undefined || !(name in bucket)) {
    return workflows;
  }

  const remainingBucket = { ...bucket };
  delete remainingBucket[name];

  const result = { ...workflows };
  if (Object.keys(remainingBucket).length === 0) {
    delete result[namespace];
  } else {
    result[namespace] = remainingBucket;
  }

  return result;
}

export interface RegisteredWorkflowEntry {
  readonly scope: WorkflowRegistryScope;
  readonly namespace: string;
  readonly name: string;
  readonly targetRef: string;
}

/**
 * Reads all three scope config files raw and independently (never through config.ts's
 * merged loadTrailStepProjectConfig), so callers can tell which file an entry actually
 * came from and so a malformed agent-config block elsewhere in a file can't prevent
 * registrations from being enumerated.
 */
export async function listRegisteredWorkflowEntries(
  context: WorkflowRegistryContext,
): Promise<readonly RegisteredWorkflowEntry[]> {
  const scopes: readonly WorkflowRegistryScope[] = ["local", "project", "global"];
  const entries: RegisteredWorkflowEntry[] = [];

  for (const scope of scopes) {
    const path = configPathForScope(scope, context);
    const config = await readRawTrailStepConfigFile(path);
    const workflows = toMutableWorkflowRegistry(config.workflows);

    for (const [namespace, bucket] of Object.entries(workflows)) {
      for (const [name, targetRef] of Object.entries(bucket)) {
        if (typeof targetRef === "string") {
          entries.push({ scope, namespace, name, targetRef });
        }
      }
    }
  }

  return entries;
}

/**
 * Checks whether a namespace/name registration already exists among the scopes relevant
 * to `scope`: for "project"/"local" this checks BOTH project config files, since
 * they share the same merged registry at resolution time and a collision in either would
 * otherwise silently shadow the other once merged. For "global" scope only that file is
 * checked, since it is never merged with anything.
 */
export async function findExistingRegistrationScope(
  namespace: string,
  name: string,
  scope: WorkflowRegistryScope,
  context: WorkflowRegistryContext,
): Promise<WorkflowRegistryScope | undefined> {
  const candidateScopes: readonly WorkflowRegistryScope[] =
    scope === "global" ? ["global"] : ["project", "local"];

  for (const candidateScope of candidateScopes) {
    const path = configPathForScope(candidateScope, context);
    const config = await readRawTrailStepConfigFile(path);
    const bucket = toMutableWorkflowRegistry(config.workflows)[namespace];
    if (bucket?.[name] !== undefined) {
      return candidateScope;
    }
  }

  return undefined;
}

/**
 * "project" is only resolvable when registered under "project"/"local" scope, and
 * "global" only under "global" scope — registrySourceForNamespace in workflow-resolution.ts only
 * ever looks up "project" inside the project-merged registry and "global" inside the user-home
 * registry, so a mismatched pair would silently write an entry that can never be resolved back.
 */
export function assertNamespaceMatchesScope(namespace: string, scope: WorkflowRegistryScope): void {
  if (namespace === "project" && scope === "global") {
    throw new CliUsageError(
      'Namespace "project" is reserved for --scope project or --scope local; it would ' +
        "not be resolvable when registered under --scope global.",
    );
  }
  if (namespace === "global" && scope !== "global") {
    throw new CliUsageError(
      'Namespace "global" is reserved for --scope global; it would not be resolvable when registered ' +
        "under this scope.",
    );
  }
}

/**
 * `/`, `#`, and `:` are meaningful separators in the ref grammar (resolveWorkflowReferenceInternal
 * in workflow-resolution.ts bails on `:`/`#` and splits namespace/name on the first `/`), and a
 * path-like name would be captured by the direct-file-reference branch before the registry is
 * ever consulted. A name that trips any of these would be unreachable or ambiguous once registered.
 */
export function assertValidRegistrationName(name: string): void {
  if (/[/#:]/u.test(name)) {
    throw new CliUsageError(
      `"${name}" contains a reserved character (/, #, or :) and can't be used as a registration name.`,
    );
  }
  if (isDirectWorkflowFileReference(name)) {
    throw new CliUsageError(
      `"${name}" looks like a file path and can't be used as a registration name.`,
    );
  }
}

function isNodeError(error: unknown): error is { readonly code: string } {
  return isRecord(error) && typeof error.code === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
