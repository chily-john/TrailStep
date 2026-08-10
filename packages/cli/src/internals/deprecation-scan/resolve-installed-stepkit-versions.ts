import { resolveInstalledPackageManifest } from "../discovery/discovery.js";

export interface ResolveInstalledStepKitVersionsOptions {
  readonly cwd: string;
}

export type InstalledStepKitVersions = ReadonlyMap<
  string,
  { readonly installedVersion?: string; readonly targetVersion: string }
>;

export async function resolveInstalledStepKitVersions({
  cwd,
}: ResolveInstalledStepKitVersionsOptions): Promise<InstalledStepKitVersions> {
  const versions = new Map<
    string,
    { readonly installedVersion?: string; readonly targetVersion: string }
  >();

  for (const packageName of ["@trailstep/core", "@trailstep/authoring"] as const) {
    const manifest = await resolveInstalledPackageManifest(packageName, cwd);
    const installedVersion = manifest?.packageJson.version;
    if (typeof installedVersion !== "string") {
      continue;
    }
    versions.set(packageName, { installedVersion, targetVersion: installedVersion });
  }

  return versions;
}
