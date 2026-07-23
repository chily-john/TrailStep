import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { maxSatisfying, prerelease, satisfies, valid } from "semver";

import type { PackageCommandRunner } from "../../command.types.js";
import {
  fetchNpmPackageMetadata,
  type NpmPackageMetadata,
} from "../../package-manager/npm-registry.js";

const stepkitPackageNames = ["@stepkit/core", "@stepkit/sdk", "@stepkit/cli"] as const;

type StepkitPackageName = (typeof stepkitPackageNames)[number];

export type DependencySection = "dependencies" | "devDependencies" | "peerDependencies";

export interface UpdateTarget {
  packageName: StepkitPackageName;
  currentRange: string;
  targetVersion: string;
  dependencySection: DependencySection;
}

export interface StepKitSelfUpdatePlan {
  targets: UpdateTarget[];
}

export interface ResolveStepKitSelfUpdateTargetsOptions {
  cwd: string;
  packageCommandRunner?: PackageCommandRunner;
}

export class UpdateTargetResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpdateTargetResolutionError";
  }
}

export async function resolveStepKitSelfUpdateTargets({
  cwd,
  packageCommandRunner,
}: ResolveStepKitSelfUpdateTargetsOptions): Promise<StepKitSelfUpdatePlan> {
  const packageJson = await readRootPackageJson(cwd);
  const current = readCurrentStepKitRanges(packageJson);
  if (current.size === 0) {
    return { targets: [] };
  }

  const [coreMetadata, sdkMetadata, cliMetadata] = await Promise.all([
    fetchNpmPackageMetadata({ cwd, packageName: "@stepkit/core", packageCommandRunner }),
    fetchNpmPackageMetadata({ cwd, packageName: "@stepkit/sdk", packageCommandRunner }),
    fetchNpmPackageMetadata({ cwd, packageName: "@stepkit/cli", packageCommandRunner }),
  ]);

  const targetCore = selectLatestStable(coreMetadata.versions);
  if (!targetCore) {
    throw new UpdateTargetResolutionError("No published @stepkit/core versions were found.");
  }

  const targetSdk = selectLatestPeerCompatibleVersion(sdkMetadata, targetCore);
  if (!targetSdk) {
    throw new UpdateTargetResolutionError(
      `No @stepkit/sdk version has a @stepkit/core peer dependency compatible with ${targetCore}.`,
    );
  }

  const targetCli = selectLatestPeerCompatibleVersion(cliMetadata, targetCore);
  if (!targetCli) {
    throw new UpdateTargetResolutionError(
      `No @stepkit/cli version has a @stepkit/core peer dependency compatible with ${targetCore}.`,
    );
  }

  return {
    targets: [
      createTarget("@stepkit/core", current, targetCore),
      createTarget("@stepkit/sdk", current, targetSdk),
      createTarget("@stepkit/cli", current, targetCli),
    ].filter((target) => target.currentRange !== ""),
  };
}

function createTarget(
  packageName: StepkitPackageName,
  current: Map<StepkitPackageName, { range: string; section: DependencySection }>,
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
  return peerDependenciesByVersion[version]?.["@stepkit/core"];
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

function readCurrentStepKitRanges(packageJson: Record<string, unknown>) {
  const entries = new Map<StepkitPackageName, { range: string; section: DependencySection }>();
  for (const packageName of stepkitPackageNames) {
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
