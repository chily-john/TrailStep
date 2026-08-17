import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { gt, valid } from "semver";

import type { PackageCommandRunner } from "../../command.types.js";
import { fetchNpmPackageMetadata } from "../../package-manager/npm-registry.js";
import { selectLatestStable, UpdateTargetResolutionError } from "./update-targets.js";

export type GlobalCliPackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface GlobalCliUpdateTarget {
  readonly packageName: "@trailstep/cli";
  readonly currentVersion: string;
  readonly targetVersion: string;
  readonly packageManager: GlobalCliPackageManager;
  readonly command: string;
  readonly args: readonly string[];
}

export interface GlobalCliUpdatePlan {
  readonly currentVersion: string;
  readonly targetVersion: string;
  readonly packageRoot: string;
  readonly packageManager: GlobalCliPackageManager;
  readonly targets: readonly GlobalCliUpdateTarget[];
}

export interface ResolveGlobalCliUpdateTargetOptions {
  readonly cwd: string;
  readonly packageCommandRunner?: PackageCommandRunner;
}

export async function resolveGlobalCliUpdateTarget({
  cwd,
  packageCommandRunner,
}: ResolveGlobalCliUpdateTargetOptions): Promise<GlobalCliUpdatePlan> {
  const packageRoot = await findCliPackageRoot(dirname(fileURLToPath(import.meta.url)));
  const packageJson = await readCliPackageJson(packageRoot);
  const currentVersion = packageJson.version;

  const metadata = await fetchNpmPackageMetadata({
    cwd,
    packageName: "@trailstep/cli",
    packageCommandRunner,
  });
  const targetVersion = selectLatestStable(metadata.versions);
  if (!targetVersion) {
    throw new UpdateTargetResolutionError("No published @trailstep/cli versions were found.");
  }

  const packageManager = inferGlobalCliPackageManager(packageRoot);
  const target = isNewerVersion(targetVersion, currentVersion)
    ? createGlobalCliUpdateTarget({ currentVersion, targetVersion, packageManager })
    : undefined;

  return {
    currentVersion,
    targetVersion,
    packageRoot,
    packageManager,
    targets: target ? [target] : [],
  };
}

function createGlobalCliUpdateTarget({
  currentVersion,
  targetVersion,
  packageManager,
}: {
  readonly currentVersion: string;
  readonly targetVersion: string;
  readonly packageManager: GlobalCliPackageManager;
}): GlobalCliUpdateTarget {
  return {
    packageName: "@trailstep/cli",
    currentVersion,
    targetVersion,
    packageManager,
    command: packageManager,
    args: globalInstallArgs(packageManager, `@trailstep/cli@${targetVersion}`),
  };
}

function globalInstallArgs(
  packageManager: GlobalCliPackageManager,
  packageSpec: string,
): readonly string[] {
  if (packageManager === "npm") {
    return ["install", "--global", packageSpec];
  }
  if (packageManager === "pnpm") {
    return ["add", "--global", packageSpec];
  }
  if (packageManager === "yarn") {
    return ["global", "add", packageSpec];
  }
  return ["add", "--global", packageSpec];
}

function isNewerVersion(targetVersion: string, currentVersion: string): boolean {
  if (valid(targetVersion) !== null && valid(currentVersion) !== null) {
    return gt(targetVersion, currentVersion);
  }
  return targetVersion !== currentVersion;
}

async function readCliPackageJson(packageRoot: string): Promise<{ readonly version: string }> {
  const packageJson = JSON.parse(await readFile(`${packageRoot}/package.json`, "utf8")) as {
    readonly version?: unknown;
  };
  if (typeof packageJson.version !== "string") {
    throw new UpdateTargetResolutionError(
      "Could not read the current @trailstep/cli package version.",
    );
  }
  return { version: packageJson.version };
}

async function findCliPackageRoot(startDirectory: string): Promise<string> {
  let current = startDirectory;

  while (true) {
    if (await isTrailStepCliPackageRoot(current)) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      throw new UpdateTargetResolutionError(
        "Could not resolve the current @trailstep/cli package root.",
      );
    }
    current = parent;
  }
}

async function isTrailStepCliPackageRoot(directory: string): Promise<boolean> {
  try {
    const packageJson = JSON.parse(await readFile(`${directory}/package.json`, "utf8")) as {
      readonly name?: string;
    };
    return packageJson.name === "@trailstep/cli";
  } catch {
    return false;
  }
}

function inferGlobalCliPackageManager(packageRoot: string): GlobalCliPackageManager {
  const normalized = packageRoot.replaceAll("\\", "/").toLowerCase();
  if (normalized.includes("/.pnpm/") || normalized.includes("/pnpm/")) {
    return "pnpm";
  }
  if (normalized.includes("/yarn/")) {
    return "yarn";
  }
  if (normalized.includes("/bun/")) {
    return "bun";
  }
  return "npm";
}
