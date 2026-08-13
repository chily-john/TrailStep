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
      throw new CliUsageError(`Invalid TrailStep config at ${path}: expected a JSON object.`);
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

export type WorkflowPackageSourceType = "npm" | "github";
export type WorkflowPackageInstallOwnership = "trailstep-installed" | "reused-existing" | "unknown";

export interface WorkflowPackageRegistryMetadata {
  readonly kind: "package";
  readonly sourceType: WorkflowPackageSourceType;
  readonly packageName: string;
  readonly requestedSpec: string;
  readonly requestedRange: string;
  readonly installScope: WorkflowRegistryScope;
  readonly targetRef: string;
  readonly workflowName: string;
  readonly exportName: string;
  readonly resolvedVersion?: string;
  readonly githubRef?: string;
  readonly installOwnership?: WorkflowPackageInstallOwnership;
}

export interface WorkflowRegistryWriteEntry {
  readonly namespace: string;
  readonly name: string;
  readonly targetRef: string;
  readonly metadata?: WorkflowPackageRegistryMetadata;
}

export interface RegisteredWorkflowEntry {
  readonly scope: WorkflowRegistryScope;
  readonly namespace: string;
  readonly name: string;
  readonly targetRef: string;
  readonly packageMetadata?: WorkflowPackageRegistryMetadata;
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
    const workflowMetadata = toMutableWorkflowMetadataRegistry(config.workflowMetadata);
    const hasWorkflowMetadata = isRecord(config.workflowMetadata);

    for (const [namespace, bucket] of Object.entries(workflows)) {
      for (const [name, targetRef] of Object.entries(bucket)) {
        if (typeof targetRef === "string") {
          const packageMetadata = readWorkflowPackageMetadata(workflowMetadata, namespace, name);
          entries.push(
            packageMetadata === undefined && !hasWorkflowMetadata
              ? { scope, namespace, name, targetRef }
              : { scope, namespace, name, targetRef, packageMetadata },
          );
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
export async function findRegisteredWorkflowEntryInScopes(
  namespace: string,
  name: string,
  scopes: readonly WorkflowRegistryScope[],
  context: WorkflowRegistryContext,
): Promise<RegisteredWorkflowEntry | undefined> {
  for (const scope of scopes) {
    const path = configPathForScope(scope, context);
    const config = await readRawTrailStepConfigFile(path);
    const targetRef = toMutableWorkflowRegistry(config.workflows)[namespace]?.[name];
    if (typeof targetRef !== "string") {
      continue;
    }

    const packageMetadata = readWorkflowPackageMetadata(
      toMutableWorkflowMetadataRegistry(config.workflowMetadata),
      namespace,
      name,
    );
    return packageMetadata === undefined
      ? { scope, namespace, name, targetRef }
      : { scope, namespace, name, targetRef, packageMetadata };
  }

  return undefined;
}

export async function writeWorkflowRegistryEntries(
  scope: WorkflowRegistryScope,
  entries: readonly WorkflowRegistryWriteEntry[],
  context: WorkflowRegistryContext,
): Promise<void> {
  const path = configPathForScope(scope, context);
  const config = await readRawTrailStepConfigFile(path);
  const workflows = toMutableWorkflowRegistry(config.workflows);
  let workflowMetadata = toMutableWorkflowMetadataRegistry(config.workflowMetadata);
  let shouldWriteMetadata = isRecord(config.workflowMetadata);

  for (const entry of entries) {
    workflows[entry.namespace] = {
      ...(workflows[entry.namespace] ?? {}),
      [entry.name]: entry.targetRef,
    };

    workflowMetadata = setWorkflowRegistryMetadataEntry(
      workflowMetadata,
      entry.namespace,
      entry.name,
      entry.metadata,
    );
    shouldWriteMetadata ||= entry.metadata !== undefined;
  }

  const nextConfig = withWorkflowMetadataRegistry(
    { ...config, workflows },
    workflowMetadata,
    shouldWriteMetadata,
  );

  await writeRawTrailStepConfigFile(path, nextConfig);
}

export function deleteWorkflowRegistryEntryFromConfig(
  config: Record<string, unknown>,
  namespace: string,
  name: string,
): Record<string, unknown> {
  const workflows = deleteWorkflowRegistryEntry(
    toMutableWorkflowRegistry(config.workflows),
    namespace,
    name,
  );
  const workflowMetadata = deleteWorkflowRegistryMetadataEntry(
    toMutableWorkflowMetadataRegistry(config.workflowMetadata),
    namespace,
    name,
  );

  return withWorkflowMetadataRegistry(
    { ...config, workflows },
    workflowMetadata,
    isRecord(config.workflowMetadata),
  );
}

export function moveWorkflowRegistryEntryInConfig(
  config: Record<string, unknown>,
  fromNamespace: string,
  fromName: string,
  toNamespace: string,
  toName: string,
  targetRef: string,
): Record<string, unknown> {
  let workflows = deleteWorkflowRegistryEntry(
    toMutableWorkflowRegistry(config.workflows),
    fromNamespace,
    fromName,
  );
  workflows = {
    ...workflows,
    [toNamespace]: { ...(workflows[toNamespace] ?? {}), [toName]: targetRef },
  };

  const workflowMetadata = moveWorkflowRegistryMetadataEntry(
    toMutableWorkflowMetadataRegistry(config.workflowMetadata),
    fromNamespace,
    fromName,
    toNamespace,
    toName,
  );

  return withWorkflowMetadataRegistry(
    { ...config, workflows },
    workflowMetadata,
    isRecord(config.workflowMetadata),
  );
}

type MutableWorkflowMetadataRegistry = Record<string, Record<string, unknown>>;

function toMutableWorkflowMetadataRegistry(value: unknown): MutableWorkflowMetadataRegistry {
  if (!isRecord(value)) {
    return {};
  }

  const registry: MutableWorkflowMetadataRegistry = {};
  for (const [namespace, entries] of Object.entries(value)) {
    if (isRecord(entries)) {
      registry[namespace] = { ...entries };
    }
  }
  return registry;
}

function readWorkflowPackageMetadata(
  registry: MutableWorkflowMetadataRegistry,
  namespace: string,
  name: string,
): WorkflowPackageRegistryMetadata | undefined {
  const metadata = registry[namespace]?.[name];
  return isWorkflowPackageRegistryMetadata(metadata) ? metadata : undefined;
}

function setWorkflowRegistryMetadataEntry(
  registry: MutableWorkflowMetadataRegistry,
  namespace: string,
  name: string,
  metadata: WorkflowPackageRegistryMetadata | undefined,
): MutableWorkflowMetadataRegistry {
  if (metadata === undefined) {
    return deleteWorkflowRegistryMetadataEntry(registry, namespace, name);
  }

  return {
    ...registry,
    [namespace]: { ...(registry[namespace] ?? {}), [name]: metadata },
  };
}

function moveWorkflowRegistryMetadataEntry(
  registry: MutableWorkflowMetadataRegistry,
  fromNamespace: string,
  fromName: string,
  toNamespace: string,
  toName: string,
): MutableWorkflowMetadataRegistry {
  const sourceMetadata = readWorkflowPackageMetadata(registry, fromNamespace, fromName);
  let moved = deleteWorkflowRegistryMetadataEntry(registry, fromNamespace, fromName);
  moved = deleteWorkflowRegistryMetadataEntry(moved, toNamespace, toName);
  return sourceMetadata === undefined
    ? moved
    : setWorkflowRegistryMetadataEntry(moved, toNamespace, toName, sourceMetadata);
}

function deleteWorkflowRegistryMetadataEntry(
  registry: MutableWorkflowMetadataRegistry,
  namespace: string,
  name: string,
): MutableWorkflowMetadataRegistry {
  const bucket = registry[namespace];
  if (bucket === undefined || !(name in bucket)) {
    return registry;
  }

  const remainingBucket = { ...bucket };
  delete remainingBucket[name];

  const result = { ...registry };
  if (Object.keys(remainingBucket).length === 0) {
    delete result[namespace];
  } else {
    result[namespace] = remainingBucket;
  }
  return result;
}

function withWorkflowMetadataRegistry(
  config: Record<string, unknown>,
  registry: MutableWorkflowMetadataRegistry,
  shouldWrite: boolean,
): Record<string, unknown> {
  if (!shouldWrite) {
    return config;
  }

  const compacted = compactWorkflowMetadataRegistry(registry);
  const nextConfig: Record<string, unknown> = { ...config };
  if (Object.keys(compacted).length === 0) {
    delete nextConfig.workflowMetadata;
  } else {
    nextConfig.workflowMetadata = compacted;
  }
  return nextConfig;
}

function compactWorkflowMetadataRegistry(
  registry: MutableWorkflowMetadataRegistry,
): MutableWorkflowMetadataRegistry {
  const compacted: MutableWorkflowMetadataRegistry = {};
  for (const [namespace, bucket] of Object.entries(registry)) {
    if (Object.keys(bucket).length > 0) {
      compacted[namespace] = bucket;
    }
  }
  return compacted;
}

function isWorkflowPackageRegistryMetadata(
  value: unknown,
): value is WorkflowPackageRegistryMetadata {
  return (
    isRecord(value) &&
    value.kind === "package" &&
    isWorkflowPackageSourceType(value.sourceType) &&
    typeof value.packageName === "string" &&
    typeof value.requestedSpec === "string" &&
    typeof value.requestedRange === "string" &&
    isWorkflowRegistryScope(value.installScope) &&
    typeof value.targetRef === "string" &&
    typeof value.workflowName === "string" &&
    typeof value.exportName === "string" &&
    isOptionalString(value.resolvedVersion) &&
    isOptionalString(value.githubRef) &&
    isOptionalWorkflowPackageInstallOwnership(value.installOwnership)
  );
}

function isWorkflowPackageSourceType(value: unknown): value is WorkflowPackageSourceType {
  return value === "npm" || value === "github";
}

function isOptionalWorkflowPackageInstallOwnership(
  value: unknown,
): value is WorkflowPackageInstallOwnership | undefined {
  return (
    value === undefined ||
    value === "trailstep-installed" ||
    value === "reused-existing" ||
    value === "unknown"
  );
}

function isWorkflowRegistryScope(value: unknown): value is WorkflowRegistryScope {
  return value === "local" || value === "project" || value === "global";
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

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
