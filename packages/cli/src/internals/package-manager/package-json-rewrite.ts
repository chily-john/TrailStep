import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type RewriteDependencySection = "dependencies" | "devDependencies" | "peerDependencies";

export interface PackageJsonDependencyUpdate {
  readonly packageName: string;
  readonly targetVersion: string;
  readonly dependencySection: RewriteDependencySection;
}

export interface RewritePackageJsonDependenciesOptions {
  readonly cwd: string;
  readonly updates: readonly PackageJsonDependencyUpdate[];
}

export async function rewritePackageJsonDependencies({
  cwd,
  updates,
}: RewritePackageJsonDependenciesOptions): Promise<void> {
  const packageJsonPath = join(cwd, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as Record<
    string,
    unknown
  >;

  for (const update of updates) {
    const section = packageJson[update.dependencySection];
    if (!isDependencySection(section)) {
      continue;
    }
    const currentRange = section[update.packageName];
    if (typeof currentRange !== "string") {
      continue;
    }
    section[update.packageName] = preserveRangeStyle(currentRange, update.targetVersion);
  }

  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
}

export function preserveRangeStyle(currentRange: string, targetVersion: string): string {
  if (currentRange.startsWith("^")) {
    return `^${targetVersion}`;
  }
  if (currentRange.startsWith("~")) {
    return `~${targetVersion}`;
  }
  if (/^\d+\.\d+\.\d+(?:[-+].*)?$/u.test(currentRange)) {
    return targetVersion;
  }
  return `^${targetVersion}`;
}

function isDependencySection(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
