import { join, resolve } from "node:path";

import type { CliCommandContext } from "../../command-framework/command.types.js";
import { CliUsageError } from "../../command-framework/command.types.js";
import { migrateLegacyCustomProvidersConfig } from "../../providers/provider-config-migration.js";
import { loadProviderPackage } from "../../providers/provider-package-loader.js";
import {
  configPathForScope,
  readRawTrailStepConfigFile,
  type WorkflowRegistryScope,
  writeRawTrailStepConfigFile,
} from "../../workflow-registry/workflow-registry.js";

import { resolveScope } from "./providers-args.js";
import type {
  ProviderCommandArgs,
  ProviderManifestWithStoredMetadata,
  TrailStepProviderRegistration,
} from "./providers-command.types.js";
import { prepareProviderForAdd } from "./providers-package.js";
import { readRegistration } from "./providers-registration.js";
import { isRecord, toMutableRecord } from "./record-utils.js";

export async function addProvider(
  args: Extract<ProviderCommandArgs, { readonly action: "add" }>,
  context: CliCommandContext,
): Promise<number> {
  const scope = await resolveScope(args.scope, context);
  const prepared = await prepareProviderForAdd(args.path, scope, context);
  const configPath = configPathForScope(scope, context);
  const config = await readRawTrailStepConfigFile(configPath);
  const providers = toMutableRecord(config.providers);
  providers[prepared.manifest.id] = {
    source: prepared.source,
    manifest: prepared.manifest,
  } satisfies TrailStepProviderRegistration;
  await writeRawTrailStepConfigFile(configPath, { ...config, providers });
  context.io.writeLine(`Wrote provider ${prepared.manifest.id} to ${configPath}.`);
  writeProviderHookTrustWarning(context, prepared.hooksPresent);
  return 0;
}

export async function migrateProviders(
  args: Extract<ProviderCommandArgs, { readonly action: "migrate" }>,
  context: CliCommandContext,
): Promise<number> {
  const scope = await resolveScope(args.scope, context);
  const configPath = configPathForScope(scope, context);
  const config = await readRawTrailStepConfigFile(configPath);
  const legacyProviders = toMutableRecord(config.customProviders);
  const { config: migrated, diagnostics } = migrateLegacyCustomProvidersConfig(config);
  await writeRawTrailStepConfigFile(configPath, migrated);

  for (const id of Object.keys(legacyProviders).sort()) {
    if (!diagnostics.some((diagnostic) => diagnostic.includes(`customProviders.${id}`))) {
      context.io.writeLine(`Migrated customProviders.${id} to providers.${id}`);
    }
  }
  for (const diagnostic of diagnostics) {
    context.io.writeError(diagnostic);
  }
  return 0;
}

export async function removeProvider(
  args: Extract<ProviderCommandArgs, { readonly action: "remove" }>,
  context: CliCommandContext,
): Promise<number> {
  const referrers = await findProviderReferrers(args.provider, context);
  if (referrers.length > 0) {
    throw new CliUsageError(
      `Cannot remove provider ${args.provider} because it is referenced by ${referrers
        .map((referrer) => `${referrer.scope}: ${referrer.path}`)
        .join(", ")}.`,
    );
  }

  const scope = await resolveScope(args.scope, context);
  const configPath = configPathForScope(scope, context);
  const config = await readRawTrailStepConfigFile(configPath);
  const providers = toMutableRecord(config.providers);
  if (!(args.provider in providers)) {
    throw new CliUsageError(`Provider ${args.provider} does not exist in ${scope} config.`);
  }
  delete providers[args.provider];
  await writeRawTrailStepConfigFile(configPath, { ...config, providers });
  context.io.writeLine(`Removed provider ${args.provider} from ${configPath}.`);
  return 0;
}

export function writeManifestDetails(
  manifest: ProviderManifestWithStoredMetadata,
  context: CliCommandContext,
  hooksPresent = isRecord(manifest.hooks) && Object.keys(manifest.hooks).length > 0,
): void {
  context.io.writeLine(`Id: ${manifest.id}`);
  context.io.writeLine(`Display name: ${manifest.displayName}`);
  context.io.writeLine(`Working: ${manifest.working.supported ? "supported" : "unsupported"}`);
  context.io.writeLine(
    `Interactive: ${manifest.interactive.supported ? "supported" : "unsupported"}`,
  );
  context.io.writeLine(`Model override: ${manifest.model.supported ? "supported" : "unsupported"}`);
  context.io.writeLine(`Thinking: ${manifest.thinking.supported ? "supported" : "unsupported"}`);
  context.io.writeLine(`Hooks: ${hooksPresent ? "present" : "absent"}`);
  writeProviderHookTrustWarning(context, hooksPresent);
}

export function writeProviderHookTrustWarning(
  context: Pick<CliCommandContext, "io">,
  hooksPresent: boolean,
): void {
  if (!hooksPresent) {
    return;
  }
  context.io.writeLine("Warning: hook-backed provider actions executes provider package code.");
}

interface ProviderReferrer {
  readonly scope: WorkflowRegistryScope;
  readonly path: string;
}

async function findProviderReferrers(
  provider: string,
  context: CliCommandContext,
): Promise<readonly ProviderReferrer[]> {
  const referrers: ProviderReferrer[] = [];
  for (const scope of ["local", "project", "global"] as const) {
    const config = await readRawTrailStepConfigFile(configPathForScope(scope, context));
    collectProviderReferrers(config.agents, "agents", provider, scope, referrers);
    collectProviderReferrers(config.workflows, "workflows", provider, scope, referrers);
  }
  return referrers;
}

function collectProviderReferrers(
  value: unknown,
  path: string,
  provider: string,
  scope: WorkflowRegistryScope,
  referrers: ProviderReferrer[],
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectProviderReferrers(item, `${path}[${index}]`, provider, scope, referrers);
    });
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  if (value.provider === provider) {
    referrers.push({ scope, path: `${path}.provider` });
  }
  for (const [key, child] of Object.entries(value)) {
    collectProviderReferrers(child, `${path}.${key}`, provider, scope, referrers);
  }
}

export async function providerRegistrationHasHooks(
  value: unknown,
  scope: WorkflowRegistryScope,
  context: CliCommandContext,
): Promise<boolean> {
  if (isRecord(value) && isRecord(value.manifest) && isRecord(value.manifest.hooks)) {
    return Object.keys(value.manifest.hooks).length > 0;
  }

  const registration = readRegistration(value);
  if (
    registration === undefined ||
    registration.source.type === "local-manifest" ||
    registration.source.type === "legacy-custom-provider" ||
    registration.source.packageName.length === 0
  ) {
    return false;
  }

  try {
    const packageRoot = resolveRegisteredProviderPackageRoot(registration.source, scope, context);
    return (await loadProviderPackage(packageRoot)).hooksPresent;
  } catch {
    return false;
  }
}

function resolveRegisteredProviderPackageRoot(
  source: Exclude<
    TrailStepProviderRegistration["source"],
    { readonly type: "local-manifest" } | { readonly type: "legacy-custom-provider" }
  >,
  scope: WorkflowRegistryScope,
  context: CliCommandContext,
): string {
  if (source.type === "local-package") {
    return resolve(context.cwd, source.spec);
  }

  const installRoot =
    scope === "global"
      ? join(context.homeDir ?? context.cwd, ".trailstep", "packages")
      : context.cwd;
  return join(installRoot, "node_modules", ...source.packageName.split("/"));
}
