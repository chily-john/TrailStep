import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { parseTrailStepProviderManifest, type TrailStepProviderManifest } from "@trailstep/core";
import { CliUsageError } from "../command.types.js";

export interface LoadedProviderPackageDefinition {
  readonly manifest: TrailStepProviderManifest;
  readonly hooksPresent: boolean;
  readonly packageName?: string;
  readonly version?: string;
}

export type ProviderPackageImporter = (specifier: string) => Promise<Record<string, unknown>>;

export interface LoadProviderPackageOptions {
  readonly importer?: ProviderPackageImporter;
}

export async function loadProviderPackage(
  packageRoot: string,
  options: LoadProviderPackageOptions = {},
): Promise<LoadedProviderPackageDefinition> {
  const packageJson = await readPackageJson(packageRoot);
  const entry = typeof packageJson.exports === "string" ? packageJson.exports : packageJson.main;
  const modulePath = resolve(packageRoot, typeof entry === "string" ? entry : "index.js");
  const importer = options.importer ?? defaultImporter;
  const imported = await importer(pathToFileURL(modulePath).href);
  const provider = imported.trailstepProvider;
  if (!isRecord(provider)) {
    throw new CliUsageError(
      "provider export missing: expected package root export trailstepProvider.",
    );
  }

  const diagnostics: string[] = [];
  const rawManifest = provider.manifest;
  const manifest = parseTrailStepProviderManifest(
    "trailstepProvider.manifest",
    rawManifest,
    diagnostics,
  );
  if (manifest === undefined || diagnostics.length > 0) {
    throw new CliUsageError(
      `Invalid provider package manifest at ${packageRoot}:\n${diagnostics.join("\n")}`,
    );
  }

  return {
    manifest,
    hooksPresent: provider.hooks !== undefined,
    ...(typeof packageJson.name === "string" ? { packageName: packageJson.name } : {}),
    ...(typeof packageJson.version === "string" ? { version: packageJson.version } : {}),
  };
}

async function defaultImporter(specifier: string): Promise<Record<string, unknown>> {
  return (await import(specifier)) as Record<string, unknown>;
}

async function readPackageJson(packageRoot: string): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(
    await readFile(resolve(packageRoot, "package.json"), "utf8"),
  ) as unknown;
  return isRecord(parsed) ? parsed : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
