import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { maxSatisfying, prerelease, satisfies, valid } from "semver";

import type { PackageCommandRunner } from "../../command.types.js";
import {
  fetchNpmPackageMetadata,
  type NpmPackageMetadata,
} from "../../package-manager/npm-registry.js";

const trailstepPackageNames = [
  "@trailstep/core",
  "@trailstep/authoring",
  "@trailstep/cli",
] as const;

type TrailStepPackageName = (typeof trailstepPackageNames)[number];

export type DependencySection = "dependencies" | "devDependencies" | "peerDependencies";

export interface UpdateTarget {
  packageName: TrailStepPackageName;
  currentRange: string;
  targetVersion: string;
  dependencySection: DependencySection;
}

export interface TrailStepSelfUpdatePlan {
  targets: UpdateTarget[];
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
    return { targets: [] };
  }

  const [coreMetadata, authoringMetadata, cliMetadata] = await Promise.all([
    fetchNpmPackageMetadata({ cwd, packageName: "@trailstep/core", packageCommandRunner }),
    fetchNpmPackageMetadata({ cwd, packageName: "@trailstep/authoring", packageCommandRunner }),
    fetchNpmPackageMetadata({ cwd, packageName: "@trailstep/cli", packageCommandRunner }),
  ]);

  const targetCore = selectLatestStable(coreMetadata.versions);
  if (!targetCore) {
    throw new UpdateTargetResolutionError("No published @trailstep/core versions were found.");
  }

  const targetAuthoring = selectLatestPeerCompatibleVersion(authoringMetadata, targetCore);
  if (!targetAuthoring) {
    throw new UpdateTargetResolutionError(
      `No @trailstep/authoring version has a @trailstep/core peer dependency compatible with ${targetCore}.`,
    );
  }

  const targetCli = selectLatestPeerCompatibleVersion(cliMetadata, targetCore);
  if (!targetCli) {
    throw new UpdateTargetResolutionError(
      `No @trailstep/cli version has a @trailstep/core peer dependency compatible with ${targetCore}.`,
    );
  }

  return {
    targets: [
      createTarget("@trailstep/core", current, targetCore),
      createTarget("@trailstep/authoring", current, targetAuthoring),
      createTarget("@trailstep/cli", current, targetCli),
    ].filter((target) => target.currentRange !== ""),
  };
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
