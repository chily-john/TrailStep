import {
  createProviderEvidenceRegistry,
  type ProviderEvidenceAdapterV1,
  type ProviderEvidenceDiagnostic,
  type ProviderEvidenceRegistry,
  type ProviderEvidenceRegistryEntry,
  parseProviderEvidenceAdapter,
  parseTrailStepProviderManifest,
  type TrailStepConfig,
  type TrailStepProviderRegistration,
} from "@trailstep/core";
import type { CliCommandContext } from "../command-framework/command.types.js";
import type { WorkflowRegistryScope } from "../workflow-registry/workflow-registry.js";

import {
  importProviderPackageModule,
  type ProviderPackageImporter,
} from "./provider-package-loader.js";
import {
  registeredPackageSource,
  resolveRegisteredProviderPackageRoot,
} from "./provider-package-root.js";

/**
 * Opt-in evidence package loader.
 *
 * Metadata-only `providers` commands keep using `loadProviderPackage`; this
 * loader is the only seam that imports a provider package's executable
 * `evidence` export. It never installs, never selects a package from logs or
 * run artifacts, and never loads a local manifest or legacy custom provider.
 */

export interface LoadedProviderEvidencePackage {
  readonly status: "loaded";
  readonly registrationId: string;
  readonly manifestProviderId: string;
  readonly adapter: ProviderEvidenceAdapterV1;
  readonly packageRoot: string;
}

export type ProviderEvidencePackageLoadResult =
  | LoadedProviderEvidencePackage
  | { readonly status: "unsupported"; readonly diagnostics: readonly ProviderEvidenceDiagnostic[] }
  | { readonly status: "unavailable"; readonly diagnostics: readonly ProviderEvidenceDiagnostic[] };

export interface LoadProviderEvidencePackageOptions {
  readonly registrationId: string;
  readonly registration: TrailStepProviderRegistration;
  readonly scope: WorkflowRegistryScope;
  readonly context: CliCommandContext;
  /** Explicit already-resolved package root; resolution is skipped when set. */
  readonly packageRoot?: string;
  readonly importer?: ProviderPackageImporter;
}

export async function loadProviderEvidencePackage(
  options: LoadProviderEvidencePackageOptions,
): Promise<ProviderEvidencePackageLoadResult> {
  const { registrationId, registration } = options;
  if (registrationId !== registration.manifest.id) {
    return unavailable("identity-mismatch", "registration key and stored manifest id differ");
  }

  const source = registeredPackageSource(registration);
  if (source === undefined) {
    return unsupported(
      "missing-capability",
      "local-manifest and legacy custom providers have no executable evidence capability",
    );
  }

  const packageRoot =
    options.packageRoot ??
    resolveRegisteredProviderPackageRoot(source, options.scope, options.context);

  let imported: Awaited<ReturnType<typeof importProviderPackageModule>>;
  try {
    imported = await importProviderPackageModule(packageRoot, {
      ...(options.importer === undefined ? {} : { importer: options.importer }),
    });
  } catch {
    // Never echo import/parse errors: they may contain private paths.
    return unavailable("unreadable-source", "provider evidence package could not be imported");
  }

  const manifestDiagnostics: string[] = [];
  const manifest = parseTrailStepProviderManifest(
    "trailstepProvider.manifest",
    imported.provider.manifest,
    manifestDiagnostics,
  );
  if (manifest === undefined || manifestDiagnostics.length > 0) {
    return unavailable("malformed-export", "provider package manifest failed validation");
  }
  if (manifest.id !== registrationId) {
    return unavailable("identity-mismatch", "loaded manifest id does not match the registration");
  }

  if (imported.provider.evidence === undefined) {
    return unsupported("missing-capability", "provider package exports no evidence capability");
  }

  const adapterParse = parseProviderEvidenceAdapter(imported.provider.evidence);
  if (adapterParse.status === "unsupported-version") {
    return { status: "unsupported", diagnostics: adapterParse.diagnostics };
  }
  if (adapterParse.status === "malformed") {
    return unavailable("malformed-export", "provider evidence export failed V1 validation");
  }

  return {
    status: "loaded",
    registrationId,
    manifestProviderId: manifest.id,
    adapter: adapterParse.adapter,
    packageRoot,
  };
}

export interface LoadedProviderEvidenceRegistry {
  readonly registry: ProviderEvidenceRegistry;
  readonly entries: readonly ProviderEvidenceRegistryEntry[];
  readonly diagnostics: readonly ProviderEvidenceDiagnostic[];
}

export type ProviderEvidenceRegistryLoadResult =
  | { readonly status: "disabled" }
  | ({ readonly status: "ready" } & LoadedProviderEvidenceRegistry)
  | { readonly status: "unsupported"; readonly diagnostics: readonly ProviderEvidenceDiagnostic[] }
  | { readonly status: "unavailable"; readonly diagnostics: readonly ProviderEvidenceDiagnostic[] };

export interface LoadConfiguredProviderEvidenceOptions {
  readonly config: TrailStepConfig | undefined;
  /** Defaults to `config.providers`. */
  readonly registrations?: Readonly<Record<string, TrailStepProviderRegistration>>;
  readonly scope: WorkflowRegistryScope;
  readonly context: CliCommandContext;
  readonly importer?: ProviderPackageImporter;
}

/**
 * Resolve `settings.evidence` and build an ephemeral registry.
 *
 * Disabled/omitted config returns before touching registrations, so no
 * package import (or importer injection) can happen on the default path.
 * `usage: true` with missing/empty `providerRoots` is `unavailable`, never a
 * fabricated zero. Each root key must name a registered package provider.
 */
export async function loadConfiguredProviderEvidence(
  options: LoadConfiguredProviderEvidenceOptions,
): Promise<ProviderEvidenceRegistryLoadResult> {
  const evidence = options.config?.settings?.evidence;
  if (evidence?.usage !== true) {
    return { status: "disabled" };
  }

  const providerRoots = evidence.providerRoots ?? {};
  if (Object.keys(providerRoots).length === 0) {
    return unavailable(
      "missing-provider-roots",
      "usage is enabled but no provider roots are declared",
    );
  }

  const registrations = options.registrations ?? options.config?.providers ?? {};
  const diagnostics: ProviderEvidenceDiagnostic[] = [];
  const entries: ProviderEvidenceRegistryEntry[] = [];
  let sawUnavailable = false;

  for (const registrationId of Object.keys(providerRoots).sort()) {
    const registration = registrations[registrationId];
    if (registration === undefined) {
      diagnostics.push({
        code: "missing-capability",
        message: `providerRoots names unregistered provider "${registrationId}"`,
      });
      sawUnavailable = true;
      continue;
    }

    const loaded = await loadProviderEvidencePackage({
      registrationId,
      registration,
      scope: options.scope,
      context: options.context,
      ...(options.importer === undefined ? {} : { importer: options.importer }),
    });
    if (loaded.status === "loaded") {
      entries.push({
        registrationId: loaded.registrationId,
        manifestProviderId: loaded.manifestProviderId,
        adapter: loaded.adapter,
        packageRoot: loaded.packageRoot,
      });
      continue;
    }

    diagnostics.push(...loaded.diagnostics);
    if (loaded.status === "unavailable") {
      sawUnavailable = true;
    }
  }

  if (entries.length === 0) {
    return sawUnavailable
      ? { status: "unavailable", diagnostics }
      : { status: "unsupported", diagnostics };
  }

  return {
    status: "ready",
    registry: createProviderEvidenceRegistry(entries),
    entries,
    diagnostics,
  };
}

function unsupported(
  code: ProviderEvidenceDiagnostic["code"],
  message: string,
): { readonly status: "unsupported"; readonly diagnostics: readonly ProviderEvidenceDiagnostic[] } {
  return { status: "unsupported", diagnostics: [{ code, message }] };
}

function unavailable(
  code: ProviderEvidenceDiagnostic["code"],
  message: string,
): { readonly status: "unavailable"; readonly diagnostics: readonly ProviderEvidenceDiagnostic[] } {
  return { status: "unavailable", diagnostics: [{ code, message }] };
}
