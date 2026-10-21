import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { maxSatisfying, prerelease, satisfies, valid } from "semver";

import type { PackageCommandRunner } from "../../command-framework/command.types.js";
import {
  fetchNpmPackageMetadata,
  type NpmPackageMetadata,
} from "../../package-manager/npm-registry.js";

const trailstepPackageNames = [
  "@trailstep/core",
  "@trailstep/authoring",
  "@trailstep/cli",
  "@trailstep/mcp",
  "@trailstep/provider-claude",
  "@trailstep/provider-codex",
  "@trailstep/provider-gemini",
  "@trailstep/provider-pi",
] as const;

export type TrailStepPackageName = (typeof trailstepPackageNames)[number];

export type DependencySection = "dependencies" | "devDependencies" | "peerDependencies";

export interface UpdateTarget {
  packageName: TrailStepPackageName;
  currentRange: string;
  targetVersion: string;
  dependencySection: DependencySection;
}

export interface TrailStepSelfUpdatePlan {
  targets: UpdateTarget[];
  currentPackageNames: readonly TrailStepPackageName[];
}

export interface ResolveTrailStepSelfUpdateTargetsOptions {
  cwd: string;
  packageCommandRunner?: PackageCommandRunner;
}

export class UpdateTargetResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpdateTargetResolutionError";
  }
}

export async function resolveTrailStepSelfUpdateTargets({
  cwd,
  packageCommandRunner,
}: ResolveTrailStepSelfUpdateTargetsOptions): Promise<TrailStepSelfUpdatePlan> {
  const packageJson = await readRootPackageJson(cwd);
  const current = readCurrentTrailStepRanges(packageJson);
  if (current.size === 0) {
    return { targets: [], currentPackageNames: [] };
  }

  const [
    coreMetadata,
    authoringMetadata,
    cliMetadata,
    mcpMetadata,
    providerClaudeMetadata,
    providerCodexMetadata,
    providerGeminiMetadata,
    providerPiMetadata,
  ] = await Promise.all([
    fetchNpmPackageMetadata({ cwd, packageName: "@trailstep/core", packageCommandRunner }),
    fetchNpmPackageMetadata({ cwd, packageName: "@trailstep/authoring", packageCommandRunner }),
    fetchNpmPackageMetadata({ cwd, packageName: "@trailstep/cli", packageCommandRunner }),
    fetchNpmPackageMetadata({ cwd, packageName: "@trailstep/mcp", packageCommandRunner }),
    fetchNpmPackageMetadata({
      cwd,
      packageName: "@trailstep/provider-claude",
      packageCommandRunner,
    }),
    fetchNpmPackageMetadata({
      cwd,
      packageName: "@trailstep/provider-codex",
      packageCommandRunner,
    }),
    fetchNpmPackageMetadata({
      cwd,
      packageName: "@trailstep/provider-gemini",
      packageCommandRunner,
    }),
    fetchNpmPackageMetadata({
      cwd,
      packageName: "@trailstep/provider-pi",
      packageCommandRunner,
    }),
  ]);

  const targetCore = selectLatestStable(coreMetadata.versions);
  if (!targetCore) {
    throw new UpdateTargetResolutionError("No published @trailstep/core versions were found.");
  }

  const targetAuthoring = resolveOptionalPeerTarget(
    "@trailstep/authoring",
    current,
    authoringMetadata,
    targetCore,
  );
  const targetCli = resolveOptionalPeerTarget("@trailstep/cli", current, cliMetadata, targetCore);

  return {
    targets: [
      createTarget("@trailstep/core", current, targetCore),
      createTarget("@trailstep/authoring", current, targetAuthoring),
      createTarget("@trailstep/cli", current, targetCli),
      createOptionalTarget("@trailstep/mcp", current, mcpMetadata, targetCore),
      createOptionalTarget(
        "@trailstep/provider-claude",
        current,
        providerClaudeMetadata,
        targetCore,
      ),
      createOptionalTarget("@trailstep/provider-codex", current, providerCodexMetadata, targetCore),
      createOptionalTarget(
        "@trailstep/provider-gemini",
        current,
        providerGeminiMetadata,
        targetCore,
      ),
      createOptionalTarget("@trailstep/provider-pi", current, providerPiMetadata, targetCore),
    ].filter((target) => target.currentRange !== ""),
    currentPackageNames: [...current.keys()],
  };
}

function createOptionalTarget(
  packageName: TrailStepPackageName,
  current: Map<TrailStepPackageName, { range: string; section: DependencySection }>,
  metadata: NpmPackageMetadata,
  coreVersion: string,
): UpdateTarget {
  if (!current.has(packageName)) {
    return { packageName, currentRange: "", targetVersion: "", dependencySection: "dependencies" };
  }
  const targetVersion = selectLatestCompatibleOrStable(metadata, coreVersion);
  if (!targetVersion) {
    throw new UpdateTargetResolutionError(
      `No ${packageName} version has a @trailstep/core peer dependency compatible with ${coreVersion}.`,
    );
  }
  return createTarget(packageName, current, targetVersion);
}

function selectLatestCompatibleOrStable(metadata: NpmPackageMetadata, coreVersion: string) {
  const hasAnyCorePeer = Object.values(metadata.peerDependenciesByVersion).some(
    (peers) => peers["@trailstep/core"] !== undefined,
  );
  if (!hasAnyCorePeer) {
    return selectLatestStable(metadata.versions);
  }
  return selectLatestPeerCompatibleVersion(metadata, coreVersion);
}

function resolveOptionalPeerTarget(
  packageName: TrailStepPackageName,
  current: Map<TrailStepPackageName, { range: string; section: DependencySection }>,
  metadata: NpmPackageMetadata,
  coreVersion: string,
): string {
  if (!current.has(packageName)) {
    return "";
  }
  const target = selectLatestPeerCompatibleVersion(metadata, coreVersion);
  if (!target) {
    throw new UpdateTargetResolutionError(
      `No ${packageName} version has a @trailstep/core peer dependency compatible with ${coreVersion}.`,
    );
  }
  return target;
}

function createTarget(
  packageName: TrailStepPackageName,
  current: Map<TrailStepPackageName, { range: string; section: DependencySection }>,
  targetVersion: string,
): UpdateTarget {
  const currentEntry = current.get(packageName);
  return {
    packageName,
    currentRange: currentEntry?.range ?? "",
    targetVersion,
    dependencySection: currentEntry?.section ?? "dependencies",
  };
}

function selectLatestPeerCompatibleVersion(metadata: NpmPackageMetadata, coreVersion: string) {
  return selectLatestStable(
    metadata.versions.filter((version) => {
      const peerRange = readCorePeerRange(metadata.peerDependenciesByVersion, version);
      return peerRange ? satisfies(coreVersion, peerRange) : false;
    }),
  );
}

export function selectLatestStable(versions: readonly string[]): string | undefined {
  const validVersions = versions.filter((version) => valid(version) !== null);
  const stable = validVersions.filter((version) => prerelease(version) === null);
  return (
    maxSatisfying(stable.length > 0 ? stable : validVersions, "*", {
      includePrerelease: stable.length === 0,
    }) ?? undefined
  );
}

function readCorePeerRange(
  peerDependenciesByVersion: NpmPackageMetadata["peerDependenciesByVersion"],
  version: string,
): string | undefined {
  return peerDependenciesByVersion[version]?.["@trailstep/core"];
}

export async function readRootPackageJson(cwd: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as Record<string, unknown>;
}

export function readPackageDependencyEntry(
  packageJson: Record<string, unknown>,
  packageName: string,
): { readonly range: string; readonly section: DependencySection } | undefined {
  for (const section of ["dependencies", "devDependencies", "peerDependencies"] as const) {
    const dependencies = packageJson[section];
    if (!isRecord(dependencies)) {
      continue;
    }
    const range = dependencies[packageName];
    if (typeof range === "string") {
      return { range, section };
    }
  }
  return undefined;
}

function readCurrentTrailStepRanges(packageJson: Record<string, unknown>) {
  const entries = new Map<TrailStepPackageName, { range: string; section: DependencySection }>();
  for (const packageName of trailstepPackageNames) {
    const entry = readPackageDependencyEntry(packageJson, packageName);
    if (entry) {
      entries.set(packageName, entry);
    }
  }
  return entries;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
