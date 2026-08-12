import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

import type { Workflow } from "@trailstep/core";

import { loadTrailStepProjectConfig, loadTrailStepUserWorkflowRegistry } from "../config/config.js";
import { discoverWorkflows } from "../discovery/discovery.js";
import { workflowPackageInstallRootForMetadata } from "../workflow-packages/install-root.js";
import {
  parseBundleWorkflowId,
  parseWorkflowId,
} from "../workflow-reference/workflow-reference.js";
import type {
  BundleWorkflowReference,
  WorkflowReference,
} from "../workflow-reference/workflow-reference.types.js";
import {
  findRegisteredWorkflowEntryInScopes,
  type WorkflowPackageRegistryMetadata,
  type WorkflowRegistryScope,
} from "../workflow-registry/workflow-registry.js";
import { hasBundleWorkflowManifest, loadBundleWorkflow } from "./bundle-resolver.js";
import { loadDirectWorkflowFile } from "./direct-file-resolver.js";
import { WorkflowResolutionError } from "./workflow-resolution-error.js";

export interface ResolveWorkflowReferenceOptions {
  readonly cwd: string;
  readonly homeDir?: string;
}

export interface ResolvedWorkflowReference {
  readonly id: string;
  readonly workflow: Workflow;
  readonly workflowRef: WorkflowReference;
  readonly notFoundMessage?: string;
}

export function isDirectWorkflowFileReference(rawRef: string): boolean {
  return isDirectWorkflowFileReferencePrefix(stripExportName(rawRef));
}

function isDirectWorkflowFileReferencePrefix(pathRef: string): boolean {
  return (
    pathRef.startsWith("./") ||
    pathRef.startsWith("../") ||
    pathRef.startsWith(".\\") ||
    pathRef.startsWith("..\\") ||
    isAbsolute(pathRef) ||
    /^[A-Za-z]:[\\/]/u.test(pathRef) ||
    pathRef.startsWith("\\\\")
  );
}

function stripExportName(rawRef: string): string {
  const hashIndex = rawRef.lastIndexOf("#");
  return hashIndex === -1 ? rawRef : rawRef.slice(0, hashIndex);
}

function readExportName(rawRef: string): string | undefined {
  const hashIndex = rawRef.lastIndexOf("#");
  return hashIndex === -1 ? undefined : rawRef.slice(hashIndex + 1);
}

export async function resolveWorkflowReference(
  rawRef: string,
  options: ResolveWorkflowReferenceOptions,
): Promise<ResolvedWorkflowReference | undefined> {
  return resolveWorkflowReferenceInternal(rawRef, options, new Set());
}

async function resolveWorkflowReferenceInternal(
  rawRef: string,
  options: ResolveWorkflowReferenceOptions,
  resolvingRefs: Set<string>,
): Promise<ResolvedWorkflowReference | undefined> {
  if (isDirectWorkflowFileReference(rawRef)) {
    const bundleRef = parseDirectLookingBundleWorkflowId(rawRef);
    if (bundleRef && (await hasBundleWorkflowManifest(bundleRef.packageName, options))) {
      return loadBundleWorkflow(bundleRef, options);
    }

    const directWorkflow = await loadDirectWorkflowFile(rawRef, options);
    const exportName = readExportName(rawRef);
    return {
      id: exportName === undefined ? directWorkflow.id : `${directWorkflow.id}#${exportName}`,
      workflow: directWorkflow.workflow,
      workflowRef: {
        kind: "direct-file",
        packageName: directWorkflow.id,
        exportName: exportName ?? directWorkflow.workflow.id,
      },
    };
  }

  const bundleRef = parseBundleWorkflowId(rawRef);

  if (bundleRef) {
    return loadBundleWorkflow(bundleRef, options);
  }

  const registeredWorkflow = await resolveRegisteredWorkflowReference(
    rawRef,
    options,
    resolvingRefs,
  );
  if (registeredWorkflow) {
    return registeredWorkflow;
  }

  const parsedRef = parseWorkflowId(rawRef);
  const workflows = await discoverWorkflows({ cwd: options.cwd });
  const discoveredWorkflow = workflows.find((workflow) => workflow.id === rawRef);

  if (!discoveredWorkflow) {
    return undefined;
  }

  return {
    id: discoveredWorkflow.id,
    workflow: discoveredWorkflow.workflow,
    workflowRef: parsedRef,
  };
}

function parseDirectLookingBundleWorkflowId(rawRef: string): BundleWorkflowReference | undefined {
  try {
    return parseBundleWorkflowId(rawRef);
  } catch {
    return undefined;
  }
}

async function resolveRegisteredWorkflowReference(
  rawRef: string,
  options: ResolveWorkflowReferenceOptions,
  resolvingRefs: Set<string>,
): Promise<ResolvedWorkflowReference | undefined> {
  if (rawRef.includes(":") || rawRef.includes("#")) {
    return undefined;
  }

  const homeDir = options.homeDir ?? homedir();
  const { workflowRegistry: projectRegistry } = await loadTrailStepProjectConfig(options.cwd, {
    homeDir,
  });
  const userRegistry = await loadTrailStepUserWorkflowRegistry(homeDir);
  const registeredRef = parseRegisteredWorkflowRef(rawRef);

  if (registeredRef) {
    const match = await findNamespacedRegistryTarget(registeredRef, {
      projectRegistry,
      userRegistry,
      cwd: options.cwd,
      homeDir,
    });

    if (match === undefined) {
      throw new WorkflowResolutionError(
        `Registered workflow namespace not found for ref: ${rawRef}`,
      );
    }

    if (match.targetRef === undefined) {
      throw new WorkflowResolutionError(`Registered workflow not found for ref: ${rawRef}`);
    }

    return resolveRegistryTarget(rawRef, match, options, resolvingRefs);
  }

  const match = await findUnqualifiedRegistryTarget(rawRef, {
    projectRegistry,
    userRegistry,
    cwd: options.cwd,
    homeDir,
  });

  if (match === undefined) {
    return undefined;
  }

  return resolveRegistryTarget(match.canonicalRef, match, options, resolvingRefs);
}

type WorkflowRegistry = Readonly<Record<string, Readonly<Record<string, string>>>>;

interface RegistryLookupOptions {
  readonly projectRegistry: WorkflowRegistry;
  readonly userRegistry: WorkflowRegistry;
  readonly cwd: string;
  readonly homeDir: string;
}

const PROJECT_REGISTRY_SCOPES: readonly WorkflowRegistryScope[] = ["local", "project"];
const GLOBAL_REGISTRY_SCOPES: readonly WorkflowRegistryScope[] = ["global"];

interface RegistryTargetMatch {
  readonly canonicalRef: string;
  readonly targetRef: string;
  readonly packageMetadata?: WorkflowPackageRegistryMetadata;
}

async function findNamespacedRegistryTarget(
  registeredRef: { readonly namespace: string; readonly name: string },
  options: RegistryLookupOptions,
): Promise<RegistryTargetMatch | { readonly targetRef: undefined } | undefined> {
  const source = registrySourceForNamespace(registeredRef.namespace, options);
  if (source === undefined) {
    return undefined;
  }

  const targetRef = source.registry[registeredRef.namespace]?.[registeredRef.name];
  if (targetRef === undefined) {
    return { targetRef: undefined };
  }

  const entry = await findRegisteredWorkflowEntryInScopes(
    registeredRef.namespace,
    registeredRef.name,
    source.scopes,
    options,
  );
  const packageMetadata = entry?.packageMetadata;

  return {
    canonicalRef: `${registeredRef.namespace}/${registeredRef.name}`,
    targetRef: normalizeRegistryTargetRef(entry?.targetRef ?? targetRef, source.baseDir),
    ...(packageMetadata === undefined ? {} : { packageMetadata }),
  };
}

async function findUnqualifiedRegistryTarget(
  name: string,
  options: RegistryLookupOptions,
): Promise<RegistryTargetMatch | undefined> {
  const projectTargetRef = options.projectRegistry.project?.[name];
  if (projectTargetRef !== undefined) {
    const entry = await findRegisteredWorkflowEntryInScopes(
      "project",
      name,
      PROJECT_REGISTRY_SCOPES,
      options,
    );
    const packageMetadata = entry?.packageMetadata;
    return {
      canonicalRef: `project/${name}`,
      targetRef: normalizeRegistryTargetRef(entry?.targetRef ?? projectTargetRef, options.cwd),
      ...(packageMetadata === undefined ? {} : { packageMetadata }),
    };
  }

  const userTargetRef = options.userRegistry.global?.[name];
  if (userTargetRef !== undefined) {
    const entry = await findRegisteredWorkflowEntryInScopes(
      "global",
      name,
      GLOBAL_REGISTRY_SCOPES,
      options,
    );
    const packageMetadata = entry?.packageMetadata;
    return {
      canonicalRef: `global/${name}`,
      targetRef: normalizeRegistryTargetRef(entry?.targetRef ?? userTargetRef, options.homeDir),
      ...(packageMetadata === undefined ? {} : { packageMetadata }),
    };
  }

  return undefined;
}

function registrySourceForNamespace(
  namespace: string,
  options: RegistryLookupOptions,
):
  | {
      readonly registry: WorkflowRegistry;
      readonly baseDir: string;
      readonly scopes: readonly WorkflowRegistryScope[];
    }
  | undefined {
  if (namespace === "project") {
    return options.projectRegistry.project === undefined
      ? undefined
      : {
          registry: options.projectRegistry,
          baseDir: options.cwd,
          scopes: PROJECT_REGISTRY_SCOPES,
        };
  }

  if (namespace === "global") {
    return options.userRegistry.global === undefined
      ? undefined
      : {
          registry: options.userRegistry,
          baseDir: options.homeDir,
          scopes: GLOBAL_REGISTRY_SCOPES,
        };
  }

  if (options.projectRegistry[namespace] !== undefined) {
    return {
      registry: options.projectRegistry,
      baseDir: options.cwd,
      scopes: PROJECT_REGISTRY_SCOPES,
    };
  }

  if (options.userRegistry[namespace] !== undefined) {
    return {
      registry: options.userRegistry,
      baseDir: options.homeDir,
      scopes: GLOBAL_REGISTRY_SCOPES,
    };
  }

  return undefined;
}

function normalizeRegistryTargetRef(targetRef: string, baseDir: string): string {
  if (targetRef === "~") {
    return baseDir;
  }

  if (targetRef.startsWith("~/") || targetRef.startsWith("~\\")) {
    return resolve(baseDir, targetRef.slice(2));
  }

  if (isDirectWorkflowFileReference(targetRef) && !isAbsolute(targetRef)) {
    return resolve(baseDir, targetRef);
  }

  return targetRef;
}

async function resolveRegistryTarget(
  requestedRef: string,
  match: RegistryTargetMatch,
  options: ResolveWorkflowReferenceOptions,
  resolvingRefs: Set<string>,
): Promise<ResolvedWorkflowReference> {
  if (resolvingRefs.has(requestedRef)) {
    throw new WorkflowResolutionError(
      `Registered workflow cycle detected for ref: ${requestedRef}`,
    );
  }

  resolvingRefs.add(requestedRef);
  const targetOptions = resolveOptionsForRegistryTarget(match, options);
  const resolvedTarget = await resolveWorkflowReferenceInternal(
    match.targetRef,
    targetOptions,
    resolvingRefs,
  );
  resolvingRefs.delete(requestedRef);

  if (!resolvedTarget) {
    throw new WorkflowResolutionError(
      `Registered workflow target not found for ref: ${requestedRef} -> ${match.targetRef}`,
    );
  }

  return { ...resolvedTarget, id: requestedRef };
}

function resolveOptionsForRegistryTarget(
  match: RegistryTargetMatch,
  options: ResolveWorkflowReferenceOptions,
): ResolveWorkflowReferenceOptions {
  if (match.packageMetadata === undefined) {
    return options;
  }

  return {
    ...options,
    cwd: workflowPackageInstallRootForMetadata(match.packageMetadata, {
      cwd: options.cwd,
      homeDir: options.homeDir,
    }),
  };
}

function parseRegisteredWorkflowRef(
  rawRef: string,
): { readonly namespace: string; readonly name: string } | undefined {
  const separatorIndex = rawRef.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === rawRef.length - 1) {
    return undefined;
  }

  return {
    namespace: rawRef.slice(0, separatorIndex),
    name: rawRef.slice(separatorIndex + 1),
  };
}
