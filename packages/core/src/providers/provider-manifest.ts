/**
 * Provider manifest public surface.
 *
 * The implementation is split into focused modules in this directory:
 * - `provider-manifest.types.ts` — manifest shapes and registrations.
 * - `provider-manifest.parse.ts` — manifest validation/parsing.
 * - `provider-manifest.registration.ts` — provider registration resolution.
 * - `provider-hygiene-args.ts` — provider hygiene argv adapters.
 *
 * This module keeps the historical import path and export names working.
 */
export { buildProviderHygieneArgs } from "./provider-hygiene-args.js";
export { parseTrailStepProviderManifest } from "./provider-manifest.parse.js";
export { parseTrailStepProviderRegistrations } from "./provider-manifest.registration.js";
export type {
  ProviderHygieneArgs,
  TrailStepProviderEnvironmentManifest,
  TrailStepProviderFollowUpManifest,
  TrailStepProviderHygieneCapability,
  TrailStepProviderHygieneManifest,
  TrailStepProviderInteractiveManifest,
  TrailStepProviderManifest,
  TrailStepProviderModelDiscoveryManifest,
  TrailStepProviderModelManifest,
  TrailStepProviderOutputManifest,
  TrailStepProviderOutputParsingManifest,
  TrailStepProviderOutputStyle,
  TrailStepProviderPackageDefinition,
  TrailStepProviderPromptFileReferenceStyle,
  TrailStepProviderPromptManifest,
  TrailStepProviderRegistration,
  TrailStepProviderSource,
  TrailStepProviderThinkingManifest,
  TrailStepProviderWorkingManifest,
} from "./provider-manifest.types.js";
