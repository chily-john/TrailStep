import type { PackageCommandRunner } from "../command.types.js";
import { defaultPackageCommandRunner } from "./package-manager.js";

export interface NpmPackageMetadata {
  packageName: string;
  versions: string[];
  peerDependenciesByVersion: Record<string, Record<string, string>>;
}

export interface FetchNpmPackageMetadataOptions {
  cwd: string;
  packageName: string;
  packageCommandRunner?: PackageCommandRunner;
}

export class NpmRegistryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "NpmRegistryError";
  }
}

export async function fetchNpmPackageMetadata({
  cwd,
  packageName,
  packageCommandRunner = defaultPackageCommandRunner,
}: FetchNpmPackageMetadataOptions): Promise<NpmPackageMetadata> {
  const result = await packageCommandRunner({
    command: "npm",
    args: ["view", `${packageName}@*`, "version", "peerDependencies", "--json"],
    cwd,
  });

  if (result.exitCode !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || `exit code ${result.exitCode}`;
    throw new NpmRegistryError(`npm view failed for ${packageName}: ${detail}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout ?? "");
  } catch (error) {
    throw new NpmRegistryError(`Malformed npm view JSON for ${packageName}.`, { cause: error });
  }

  const metadata = normalizeNpmViewMetadata(parsed);
  if (!metadata) {
    throw new NpmRegistryError(
      `Malformed npm view JSON for ${packageName}: expected version metadata from npm view ${packageName}@*.`,
    );
  }

  return {
    packageName,
    versions: metadata.versions,
    peerDependenciesByVersion: metadata.peerDependenciesByVersion,
  };
}

function normalizeNpmViewMetadata(
  value: unknown,
):
  | { versions: string[]; peerDependenciesByVersion: Record<string, Record<string, string>> }
  | undefined {
  const entries = Array.isArray(value) ? value : [value];
  const versions: string[] = [];
  const peerDependenciesByVersion: Record<string, Record<string, string>> = {};

  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.version !== "string") {
      return undefined;
    }
    versions.push(entry.version);
    peerDependenciesByVersion[entry.version] = isRecord(entry.peerDependencies)
      ? normalizePeerDependencies(entry.peerDependencies)
      : {};
  }

  return versions.length > 0 ? { versions, peerDependenciesByVersion } : undefined;
}

function normalizePeerDependencies(value: Record<string, unknown>): Record<string, string> {
  const peers: Record<string, string> = {};
  for (const [peerName, peerRange] of Object.entries(value)) {
    if (typeof peerRange === "string") {
      peers[peerName] = peerRange;
    }
  }
  return peers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
