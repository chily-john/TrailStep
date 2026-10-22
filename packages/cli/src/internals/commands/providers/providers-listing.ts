import type { CliCommandContext } from "../../command-framework/command.types.js";
import { CliUsageError } from "../../command-framework/command.types.js";
import {
  configPathForScope,
  readRawTrailStepConfigFile,
  type WorkflowRegistryScope,
} from "../../workflow-registry/workflow-registry.js";

import { resolveScope } from "./providers-args.js";
import type { ProviderCommandArgs } from "./providers-command.types.js";
import { providerRegistrationHasHooks, writeManifestDetails } from "./providers-config.js";
import {
  inspectInstalledProviderPackage,
  loadProviderDefinition,
  localSourceExists,
} from "./providers-package.js";
import { formatProviderSource, readRegistration } from "./providers-registration.js";
import { toMutableRecord } from "./record-utils.js";

export async function inspectProvider(path: string, context: CliCommandContext): Promise<number> {
  const provider = (await localSourceExists(path, context))
    ? await loadProviderDefinition(path, context)
    : await inspectInstalledProviderPackage(path, context);
  writeManifestDetails(provider.manifest, context, provider.hooksPresent);
  return 0;
}

export async function listProviders(
  args: Extract<ProviderCommandArgs, { readonly action: "list" }>,
  context: CliCommandContext,
): Promise<number> {
  const scope = await resolveScope(args.scope, context);
  const config = await readRawTrailStepConfigFile(configPathForScope(scope, context));
  const providers = toMutableRecord(config.providers);
  for (const id of Object.keys(providers).sort()) {
    const rawRegistration = providers[id];
    const registration = readRegistration(rawRegistration);
    const manifest = registration?.manifest;
    const hooksPresent = await providerRegistrationHasHooks(rawRegistration, scope, context);
    context.io.writeLine(
      `${id}\t${manifest?.displayName ?? "(unknown)"}\t${registration?.source.type ?? "unknown"}\thooks: ${hooksPresent ? "yes" : "no"}`,
    );
  }
  return 0;
}

export async function showProvider(
  args: Extract<ProviderCommandArgs, { readonly action: "show" }>,
  context: CliCommandContext,
): Promise<number> {
  const scope = await resolveScope(args.scope, context);
  const config = await readRawTrailStepConfigFile(configPathForScope(scope, context));
  const providers = toMutableRecord(config.providers);
  const provider = await resolveShowProvider(args.provider, providers, scope, context);
  const rawRegistration = providers[provider];
  const registration = readRegistration(rawRegistration);
  if (registration === undefined) {
    throw new CliUsageError(`Provider ${provider} does not exist in ${scope} config.`);
  }
  writeManifestDetails(
    registration.manifest,
    context,
    await providerRegistrationHasHooks(rawRegistration, scope, context),
  );
  context.io.writeLine(`Source: ${formatProviderSource(registration.source)}`);
  return 0;
}

async function resolveShowProvider(
  provider: string | undefined,
  providers: Record<string, unknown>,
  scope: WorkflowRegistryScope,
  context: CliCommandContext,
): Promise<string> {
  if (provider !== undefined) {
    return provider;
  }

  const providerIds = Object.keys(providers).sort();
  if (providerIds.length === 0) {
    throw new CliUsageError(`No providers registered in ${scope} config.`);
  }
  if (providerIds.length === 1) {
    return providerIds[0] as string;
  }
  if (context.prompts === undefined) {
    throw new CliUsageError(
      "trailstep providers requires <provider> when multiple providers are registered.",
    );
  }
  return context.prompts.select("Provider", providerIds);
}
