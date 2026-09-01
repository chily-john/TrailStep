function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toMutableRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {};
}

export function migrateLegacyCustomProvidersConfig(value: unknown): {
  readonly config: Record<string, unknown>;
  readonly diagnostics: readonly string[];
} {
  const config = toMutableRecord(value);
  const customProviders = toMutableRecord(config.customProviders);
  const providers = toMutableRecord(config.providers);
  const diagnostics: string[] = [];

  for (const [id, provider] of Object.entries(customProviders)) {
    if (!isRecord(provider)) {
      diagnostics.push(`customProviders.${id} must be an object to migrate.`);
      continue;
    }
    if (providers[id] !== undefined) {
      diagnostics.push(`providers.${id} already exists; customProviders.${id} was not migrated.`);
      continue;
    }
    if (typeof provider.binary !== "string" || provider.binary.length === 0) {
      diagnostics.push(`customProviders.${id}.binary must be a non-empty string to migrate.`);
      continue;
    }

    const working: Record<string, unknown> = {
      supported: true,
      command: provider.binary,
      prompt: { kind: "prompt-file" },
      output: { style: "provider-output-file" },
    };
    if (Array.isArray(provider.args)) {
      working.args = provider.args;
    }

    const interactive: Record<string, unknown> = Array.isArray(provider.interactiveArgs)
      ? {
          supported: true,
          command: provider.binary,
          args: provider.interactiveArgs,
        }
      : { supported: false, reason: "interactiveArgs is not declared" };

    providers[id] = {
      source: { type: "legacy-custom-provider" },
      manifest: {
        schemaVersion: 1,
        id,
        displayName: id,
        working,
        interactive,
        model: isRecord(provider.model) ? provider.model : { supported: false },
        thinking: isRecord(provider.thinking) ? provider.thinking : { supported: false },
        ...(typeof provider.cwd === "string" ? { cwd: provider.cwd } : {}),
        ...(isRecord(provider.env) ? { env: provider.env } : {}),
      },
    };
  }

  const nextConfig: Record<string, unknown> = { ...config, providers };
  delete nextConfig.customProviders;
  return { config: nextConfig, diagnostics };
}
